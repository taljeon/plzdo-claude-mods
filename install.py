#!/usr/bin/env python3
"""Preview or apply this checkout's Claude Code mods and shared skills."""

import argparse
from datetime import datetime
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
from typing import Optional


PLUGIN_DIRS = "CLAUDE_CODE_PLUGIN_DIRS"
# Used from the checkout to run this installer; nothing to link once setup is done.
SETUP_ONLY_SKILLS = {"claude-env-setup"}


def reject_json_constant(value: str) -> None:
    raise ValueError("Invalid JSON constant: " + value)


def read_settings(path: Path) -> dict:
    try:
        settings = json.loads(path.read_text(encoding="utf-8"), parse_constant=reject_json_constant)
    except FileNotFoundError:
        settings = {}
    if not isinstance(settings, dict):
        raise ValueError("settings.json must contain an object")
    env = settings.get("env", {})
    if not isinstance(env, dict):
        raise ValueError("settings.json env must be an object")
    if not isinstance(env.get(PLUGIN_DIRS, ""), str):
        raise ValueError("settings.json env." + PLUGIN_DIRS + " must be a string")
    return settings


def merge_mods(settings: dict, mods: list[Path]) -> tuple[bool, list[str]]:
    env = settings.get("env", {})
    segments = [part for part in env.get(PLUGIN_DIRS, "").split(":") if part]
    present = {os.path.realpath(part) for part in segments}
    added = []
    for mod in mods:
        resolved = str(mod.resolve())
        for segment in segments:
            if Path(segment).name == mod.name and os.path.realpath(segment) != resolved:
                print("Warning: old checkout for {}: {}; keeping it.".format(mod.name, segment))
        if resolved not in present:
            added.append(resolved)
            present.add(resolved)
    changed = PLUGIN_DIRS not in env or bool(added)
    if changed:
        env[PLUGIN_DIRS] = ":".join(segments + added)
        settings["env"] = env
    enabled = settings.get("enabledPlugins", {})
    if isinstance(enabled, dict) and enabled.get("inline-next-steps@claude-mods") is True:
        print("Warning: inline-next-steps@claude-mods overlaps next-steps-pick "
              "and should be turned off; leaving it unchanged.")
    return changed, added


def plan_skills(skills: list[Path], directory: Path) -> tuple[list[tuple[Path, Path]], int]:
    links = []
    conflicts = 0
    for skill in skills:
        destination = directory / skill.name
        target = skill.resolve()
        if destination.is_symlink() and os.path.realpath(destination) == str(target):
            continue
        if os.path.lexists(destination):
            print("Conflict: {}; leaving it untouched.".format(destination))
            conflicts += 1
        else:
            links.append((destination, target))
    return links, conflicts


def settings_target(settings_path: Path) -> Path:
    """Write through a symlinked settings.json so a dotfile link stays intact."""
    if not settings_path.is_symlink():
        return settings_path
    if not settings_path.exists():
        raise ValueError("settings.json is a dangling symlink: " + os.readlink(settings_path))
    return Path(os.path.realpath(settings_path))


def write_backup(settings_path: Path, data: bytes, mode: int) -> Path:
    """Reserve the backup name exclusively and create it owner-only before copying bytes."""
    base = settings_path.with_name("settings.json.bak-" + datetime.now().strftime("%Y%m%d-%H%M%S"))
    candidate = base
    suffix = 1
    while True:
        try:
            fd = os.open(str(candidate), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            candidate = base.with_name(base.name + "-" + str(suffix))
            suffix += 1
            continue
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
            # Never wider than the original settings file.
            os.chmod(str(candidate), mode & 0o777)
        except BaseException:
            candidate.unlink(missing_ok=True)
            raise
        return candidate


def write_settings(path: Path, settings: dict, backup_dir_path: Optional[Path]) -> Optional[Path]:
    target = settings_target(path)
    original = target.read_bytes() if target.exists() else None
    mode = stat.S_IMODE(target.stat().st_mode) if original is not None else None
    backup = write_backup(backup_dir_path, original, mode) if backup_dir_path is not None and original is not None else None
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=str(target.parent),
            prefix=".settings.json.", suffix=".tmp", delete=False,
        ) as stream:
            temporary = Path(stream.name)
            stream.write(json.dumps(settings, indent=2, ensure_ascii=False) + "\n")
        if mode is not None:
            temporary.chmod(mode)
        os.replace(temporary, target)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return backup


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Set up this checkout's mods and shared skills (Python 3.9+; no network or installs).",
        epilog="Merge settings.json with a timestamped backup and preserve other settings. "
               "Link shared skills without overwriting conflicts. "
               "Exit codes: 0 success, 2 invalid settings or I/O error, 3 skill conflicts. "
               "Restart Claude Code after applying changes.",
    )
    parser.add_argument("--claude-dir", type=Path,
                        default=os.environ.get("CLAUDE_CONFIG_DIR", "~/.claude"),
                        help="target directory (default: $CLAUDE_CONFIG_DIR, else ~/.claude)")
    parser.add_argument("--apply", action="store_true",
                        help="perform changes; without this flag, only print a dry-run plan (no writes)")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    mods = sorted((p for p in root.iterdir() if p.is_dir() and
                   (p / ".claude-plugin" / "plugin.json").is_file()), key=lambda p: p.name)
    skills = sorted((p.parent for p in (root / "shared-skills").glob("*/SKILL.md")
                     if p.is_file() and p.parent.name not in SETUP_ONLY_SKILLS), key=lambda p: p.name)
    directory = args.claude_dir.expanduser().resolve()
    settings_path = directory / "settings.json"
    skills_dir = directory / "skills"
    added = []
    links = []
    conflicts = 0
    result = 0
    try:
        # Validate before planning or applying any filesystem changes.
        settings = read_settings(settings_path)
        changed, added = merge_mods(settings, mods)
        links, conflicts = plan_skills(skills, skills_dir)
        if changed:
            settings_target(settings_path)
        backs_up = changed and os.path.lexists(settings_path)
        if (changed or links) and not directory.exists():
            print("Create directory: {}".format(directory))
        for mod in added:
            print("Add mod: {}".format(mod))
        if changed:
            if backs_up:
                print("Back up settings: {} -> {}".format(
                    settings_path, settings_path.with_name("settings.json.bak-<timestamp>")))
            if settings_path.is_symlink():
                print("Write through symlink: {} -> {}".format(settings_path, settings_target(settings_path)))
            print("{} settings: {}".format("Update" if settings_path.exists() else "Create", settings_path))
        if links and not skills_dir.exists():
            print("Create directory: {}".format(skills_dir))
        for destination, target in links:
            print("Link skill: {} -> {}".format(destination, target))
        if not changed and not links and not conflicts:
            print("No changes needed.")
        if args.apply:
            if changed:
                directory.mkdir(parents=True, exist_ok=True)
                backup = write_settings(settings_path, settings, settings_path if backs_up else None)
                if backup is not None:
                    print("Backed up settings: {}".format(backup))
            if links:
                skills_dir.mkdir(parents=True, exist_ok=True)
                for destination, target in links:
                    destination.symlink_to(target, target_is_directory=True)
            if changed or links:
                print("Restart Claude Code to load the mods.")
        if conflicts:
            result = 3
    except (OSError, ValueError) as error:
        print("Error: {}".format(error), file=sys.stderr)
        result = 2
    print("Mods: {} (added {}) | Skills: {} (linked {}, conflicts {}) | Mode: {}".format(
        len(mods), len(added), len(skills), len(links), conflicts,
        "apply" if args.apply else "dry-run",
    ))
    return result


if __name__ == "__main__":
    sys.exit(main())
