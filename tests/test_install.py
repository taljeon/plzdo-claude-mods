"""Exercise the installer in temporary targets; the checkout is read-only input."""

from datetime import datetime, timedelta
import json
import os
from pathlib import Path
import stat
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / "install.py"
MODS = sorted((p.parent.parent for p in ROOT.glob("*/.claude-plugin/plugin.json")
               if p.is_file()), key=lambda p: p.name)
SKILLS = sorted((p.parent for p in (ROOT / "shared-skills").glob("*/SKILL.md")
                 if p.is_file() and p.parent.name != "claude-env-setup"), key=lambda p: p.name)
PLUGIN_DIRS = "CLAUDE_CODE_PLUGIN_DIRS"
MOD_PATHS = [str(mod.resolve()) for mod in MODS]


@pytest.fixture
def run_install(tmp_path):
    def run(*arguments, target=None, env=None, use_option=True):
        environment = os.environ.copy()
        environment.pop("CLAUDE_CONFIG_DIR", None)
        environment["HOME"] = str(tmp_path / "home")
        environment.update(env or {})
        command = [sys.executable, str(INSTALLER)]
        if use_option:
            command.extend(["--claude-dir", str(target if target is not None else tmp_path / "claude")])
        return subprocess.run(command + list(arguments), cwd=tmp_path, env=environment,
                              text=True, capture_output=True, check=False)
    return run


def snapshot(root):
    """Include modes, timestamps and link text to detect unexpected mutations."""
    result = {}
    for path in [root] + sorted(root.rglob("*")):
        metadata = path.lstat()
        if path.is_symlink():
            content = os.readlink(path)
        elif path.is_file():
            content = path.read_bytes()
        else:
            content = None
        result[str(path.relative_to(root))] = (metadata.st_mode, metadata.st_mtime_ns, content)
    return result


def write_settings(target, settings):
    target.mkdir(parents=True, exist_ok=True)
    path = target / "settings.json"
    path.write_text(json.dumps(settings, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


def link_skills(target):
    directory = target / "skills"
    directory.mkdir(parents=True, exist_ok=True)
    for skill in SKILLS:
        (directory / skill.name).symlink_to(skill.resolve(), target_is_directory=True)


def assert_all_skills(target):
    assert sorted(path.name for path in (target / "skills").iterdir()) == [p.name for p in SKILLS]
    for skill in SKILLS:
        link = target / "skills" / skill.name
        assert link.is_symlink()
        assert link.resolve() == skill.resolve()


def assert_summary(result, *, added=0, linked=0, conflicts=0, mode="dry-run"):
    expected = "Mods: {} (added {}) | Skills: {} (linked {}, conflicts {}) | Mode: {}".format(
        len(MODS), added, len(SKILLS), linked, conflicts, mode)
    assert result.stdout.splitlines()[-1] == expected


@pytest.mark.parametrize("existing", [False, True])
def test_dry_run_writes_nothing_and_lists_everything(tmp_path, run_install, existing):
    target = tmp_path / "claude"
    if existing:
        target.mkdir()
    before = snapshot(tmp_path)
    result = run_install()
    assert result.returncode == 0, result.stderr
    assert snapshot(tmp_path) == before
    assert [line.removeprefix("Add mod: ") for line in result.stdout.splitlines()
            if line.startswith("Add mod: ")] == MOD_PATHS
    for skill in SKILLS:
        assert "Link skill: {} -> {}".format(target / "skills" / skill.name, skill.resolve()) in result.stdout
    assert "Restart Claude Code" not in result.stdout
    assert_summary(result, added=len(MODS), linked=len(SKILLS))


def test_apply_empty_and_second_apply_is_noop(tmp_path, run_install):
    target = tmp_path / "claude"
    result = run_install("--apply")
    assert result.returncode == 0, result.stderr
    settings = {"env": {PLUGIN_DIRS: ":".join(MOD_PATHS)}}
    assert (target / "settings.json").read_text() == json.dumps(settings, indent=2, ensure_ascii=False) + "\n"
    assert_all_skills(target)
    assert not list(target.glob("settings.json.bak-*"))
    assert "Restart Claude Code to load the mods." in result.stdout
    assert_summary(result, added=len(MODS), linked=len(SKILLS), mode="apply")
    before = snapshot(target)
    result = run_install("--apply")
    assert result.returncode == 0, result.stderr
    assert "No changes needed." in result.stdout.splitlines()
    assert "Restart Claude Code" not in result.stdout
    assert snapshot(target) == before
    assert_summary(result, mode="apply")


def test_merge_preserves_values_bytes_backup_and_mode(tmp_path, run_install):
    target = tmp_path / "claude"
    foreign = [str(tmp_path / "foreign-z"), str(tmp_path / "foreign-a")]
    existing = foreign + MOD_PATHS[::2]
    original = {
        "model": "model-name",
        "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "echo unchanged"}]}]},
        "permissions": {"allow": ["Read"], "deny": ["Bash(rm:*)"]},
        "env": {"LANG": "日本語", "OTHER": "unchanged", PLUGIN_DIRS: ":" + "::".join(existing) + ":"},
        "other": [None, False, 42, {"nested": "value"}],
    }
    path = write_settings(target, original)
    path.chmod(0o640)
    original_bytes = path.read_bytes()
    before = snapshot(tmp_path)
    preview = run_install()
    assert preview.returncode == 0, preview.stderr
    assert snapshot(tmp_path) == before
    result = run_install("--apply")
    assert result.returncode == 0, result.stderr
    merged = json.loads(path.read_text())
    expected = json.loads(original_bytes)
    expected["env"][PLUGIN_DIRS] = ":".join(existing + MOD_PATHS[1::2])
    assert merged == expected
    assert path.read_text() == json.dumps(expected, indent=2, ensure_ascii=False) + "\n"
    assert stat.S_IMODE(path.stat().st_mode) == 0o640
    backups = list(target.glob("settings.json.bak-*"))
    assert len(backups) == 1
    assert backups[0].read_bytes() == original_bytes
    assert stat.S_IMODE(backups[0].stat().st_mode) == 0o640
    assert not list(target.glob(".settings.json.*.tmp"))
    assert_all_skills(target)
    assert_summary(result, added=len(MOD_PATHS[1::2]), linked=len(SKILLS), mode="apply")


@pytest.mark.parametrize("settings", [{"model": "keep"}, {"env": {"OTHER": "keep"}}])
def test_add_missing_env_or_plugin_key(tmp_path, run_install, settings):
    target = tmp_path / "claude"
    path = write_settings(target, settings)
    original = path.read_bytes()
    result = run_install("--apply")
    assert result.returncode == 0, result.stderr
    expected = json.loads(original)
    expected.setdefault("env", {})[PLUGIN_DIRS] = ":".join(MOD_PATHS)
    assert json.loads(path.read_text()) == expected
    assert [p.read_bytes() for p in target.glob("settings.json.bak-*")] == [original]


@pytest.mark.parametrize("apply", [False, True])
def test_all_mods_present_keeps_empty_segments_order_and_bytes(tmp_path, run_install, apply):
    target = tmp_path / "claude"
    write_settings(target, {"env": {PLUGIN_DIRS: ":" + "::".join(reversed(MOD_PATHS)) + ":"}})
    link_skills(target)
    before = snapshot(target)
    result = run_install(*(["--apply"] if apply else []))
    assert result.returncode == 0, result.stderr
    assert "No changes needed." in result.stdout.splitlines()
    assert snapshot(target) == before
    assert_summary(result, mode="apply" if apply else "dry-run")


def test_realpath_aliases_count_as_present(tmp_path, run_install):
    target = tmp_path / "claude"
    alias = tmp_path / "alias"
    alias.symlink_to(ROOT, target_is_directory=True)
    segments = [str(alias / mod.name) for mod in MODS]
    write_settings(target, {"env": {PLUGIN_DIRS: ":".join(segments)}})
    link_skills(target)
    before = snapshot(target)
    result = run_install("--apply")
    assert result.returncode == 0, result.stderr
    assert "No changes needed." in result.stdout
    assert "Warning:" not in result.stdout
    assert snapshot(target) == before


def test_old_checkout_warned_and_kept(tmp_path, run_install):
    target = tmp_path / "claude"
    old = tmp_path / "old-checkout" / MODS[0].name
    old.mkdir(parents=True)
    path = write_settings(target, {"env": {PLUGIN_DIRS: str(old)}})
    result = run_install("--apply")
    assert result.returncode == 0, result.stderr
    assert "Warning:" in result.stdout and str(old) in result.stdout
    assert json.loads(path.read_text())["env"][PLUGIN_DIRS].split(":") == [str(old)] + MOD_PATHS


@pytest.mark.parametrize("raw", [
    "{broken", "[]", "null", '"string"',
    '{"other": NaN}', '{"other": Infinity}', '{"other": -Infinity}',
    '{"env": []}', '{"env": null}', '{"env": "string"}',
    '{"env": {"CLAUDE_CODE_PLUGIN_DIRS": []}}',
    '{"env": {"CLAUDE_CODE_PLUGIN_DIRS": null}}',
    '{"env": {"CLAUDE_CODE_PLUGIN_DIRS": 123}}',
])
@pytest.mark.parametrize("apply", [False, True])
def test_invalid_settings_write_nothing(tmp_path, run_install, raw, apply):
    target = tmp_path / "claude"
    target.mkdir()
    (target / "settings.json").write_text(raw)
    before = snapshot(tmp_path)
    result = run_install(*(["--apply"] if apply else []))
    assert result.returncode == 2
    assert "Error:" in result.stderr
    assert snapshot(tmp_path) == before
    assert not (target / "skills").exists()
    assert_summary(result, mode="apply" if apply else "dry-run")


@pytest.mark.parametrize("kind", ["directory", "file", "symlink", "dangling-symlink"])
@pytest.mark.parametrize("apply", [False, True])
def test_conflicts_untouched_and_other_changes_continue(tmp_path, run_install, kind, apply):
    target = tmp_path / "claude"
    (target / "skills").mkdir(parents=True)
    conflict = target / "skills" / SKILLS[0].name
    other = tmp_path / "other"
    if kind == "directory":
        conflict.mkdir()
        (conflict / "keep").write_text("preserve directory contents")
    elif kind == "file":
        conflict.write_text("preserve file")
    else:
        if kind == "symlink":
            other.mkdir()
            (other / "keep").write_text("preserve symlink target")
        conflict.symlink_to(other, target_is_directory=True)
    before = snapshot(tmp_path)
    result = run_install(*(["--apply"] if apply else []))
    assert result.returncode == 3, result.stderr
    assert "Conflict:" in result.stdout and str(conflict) in result.stdout
    assert "No changes needed." not in result.stdout
    after = snapshot(tmp_path)
    for name, value in before.items():
        if name.startswith("claude/skills/" + SKILLS[0].name) or name.startswith("other"):
            assert after[name] == value
    if apply:
        assert json.loads((target / "settings.json").read_text())["env"][PLUGIN_DIRS].split(":") == MOD_PATHS
        for skill in SKILLS[1:]:
            assert (target / "skills" / skill.name).resolve() == skill.resolve()
            assert (target / "skills" / skill.name).is_symlink()
        assert "Restart Claude Code to load the mods." in result.stdout
    else:
        assert after == before
    assert_summary(result, added=len(MODS), linked=len(SKILLS) - 1,
                   conflicts=1, mode="apply" if apply else "dry-run")


def test_conflict_only_is_not_reported_as_noop(tmp_path, run_install):
    target = tmp_path / "claude"
    write_settings(target, {"env": {PLUGIN_DIRS: ":".join(MOD_PATHS)}})
    link_skills(target)
    conflict = target / "skills" / SKILLS[0].name
    conflict.unlink()
    conflict.mkdir()
    before = snapshot(target)
    result = run_install("--apply")
    assert result.returncode == 3
    assert "No changes needed." not in result.stdout
    assert "Restart Claude Code" not in result.stdout
    assert snapshot(target) == before
    assert_summary(result, conflicts=1, mode="apply")


@pytest.mark.parametrize("complete", [False, True])
def test_overlapping_plugin_warned_but_unchanged(tmp_path, run_install, complete):
    target = tmp_path / "claude"
    settings = {"enabledPlugins": {"inline-next-steps@claude-mods": True, "other": False}}
    if complete:
        settings["env"] = {PLUGIN_DIRS: ":".join(MOD_PATHS)}
        link_skills(target)
    path = write_settings(target, settings)
    before = snapshot(target)
    result = run_install("--apply")
    assert result.returncode == 0, result.stderr
    assert "Warning:" in result.stdout
    assert "overlaps next-steps-pick" in result.stdout
    assert "should be turned off" in result.stdout
    assert json.loads(path.read_text())["enabledPlugins"] == settings["enabledPlugins"]
    if complete:
        assert "No changes needed." in result.stdout
        assert snapshot(target) == before


def test_existing_skill_alias_is_untouched(tmp_path, run_install):
    target = tmp_path / "claude"
    (target / "skills").mkdir(parents=True)
    alias = tmp_path / "skill-alias"
    alias.symlink_to(SKILLS[0], target_is_directory=True)
    link = target / "skills" / SKILLS[0].name
    link.symlink_to(Path("../..") / alias.name, target_is_directory=True)
    before = (os.readlink(link), link.lstat().st_mtime_ns)
    result = run_install("--apply")
    assert result.returncode == 0, result.stderr
    assert (os.readlink(link), link.lstat().st_mtime_ns) == before
    assert_all_skills(target)
    assert_summary(result, added=len(MODS), linked=len(SKILLS) - 1, mode="apply")


def test_linking_skills_does_not_rewrite_complete_settings(tmp_path, run_install):
    target = tmp_path / "claude"
    path = write_settings(target, {"env": {PLUGIN_DIRS: ":".join(MOD_PATHS) + ":"}})
    original = (path.read_bytes(), path.stat().st_mode, path.stat().st_mtime_ns)
    result = run_install("--apply")
    assert result.returncode == 0, result.stderr
    assert (path.read_bytes(), path.stat().st_mode, path.stat().st_mtime_ns) == original
    assert not list(target.glob("settings.json.bak-*"))
    assert_all_skills(target)
    assert_summary(result, linked=len(SKILLS), mode="apply")


def test_backup_name_collision_adds_numeric_suffix(tmp_path, run_install):
    target = tmp_path / "claude"
    path = write_settings(target, {"model": "keep"})
    original = path.read_bytes()
    now = datetime.now()
    # Reserve nearby timestamps so the subprocess need not run in this exact second.
    for offset in range(-2, 61):
        stamp = (now + timedelta(seconds=offset)).strftime("%Y%m%d-%H%M%S")
        (target / ("settings.json.bak-" + stamp)).write_bytes(b"existing backup")
    existing = {p.name: p.read_bytes() for p in target.glob("settings.json.bak-*")}
    result = run_install("--apply")
    assert result.returncode == 0, result.stderr
    backups = {p.name: p.read_bytes() for p in target.glob("settings.json.bak-*")}
    assert len(backups) == len(existing) + 1
    for name, content in existing.items():
        assert backups[name] == content
    new = set(backups) - set(existing)
    assert len(new) == 1
    name = new.pop()
    assert name.endswith("-1")
    assert backups[name] == original


def test_claude_config_dir_default(tmp_path, run_install):
    target = tmp_path / "environment-config"
    result = run_install("--apply", use_option=False, env={"CLAUDE_CONFIG_DIR": str(target)})
    assert result.returncode == 0, result.stderr
    assert json.loads((target / "settings.json").read_text())["env"][PLUGIN_DIRS].split(":") == MOD_PATHS
    assert_all_skills(target)
    assert not (tmp_path / "claude").exists()
    assert not (tmp_path / "home").exists()


def test_explicit_target_overrides_environment(tmp_path, run_install):
    ignored = tmp_path / "ignored-config"
    result = run_install("--apply", env={"CLAUDE_CONFIG_DIR": str(ignored)})
    assert result.returncode == 0, result.stderr
    assert not ignored.exists()
    assert (tmp_path / "claude" / "settings.json").is_file()


def test_home_default_is_temporary(tmp_path, run_install):
    result = run_install("--apply", use_option=False)
    assert result.returncode == 0, result.stderr
    target = tmp_path / "home" / ".claude"
    assert json.loads((target / "settings.json").read_text())["env"][PLUGIN_DIRS].split(":") == MOD_PATHS
    assert_all_skills(target)


def test_symlinked_settings_written_through(tmp_path, run_install):
    target = tmp_path / "claude"
    managed = tmp_path / "dotfiles" / "settings.json"
    managed.parent.mkdir(parents=True)
    managed.write_text(json.dumps({"model": "keep"}) + "\n")
    managed.chmod(0o600)
    target.mkdir()
    (target / "settings.json").symlink_to(managed)
    result = run_install("--apply")
    assert result.returncode == 0, result.stderr
    assert (target / "settings.json").is_symlink()
    merged = json.loads(managed.read_text())
    assert merged["model"] == "keep" and merged["env"][PLUGIN_DIRS] == ":".join(MOD_PATHS)
    backups = list(target.glob("settings.json.bak-*"))
    assert len(backups) == 1 and json.loads(backups[0].read_text()) == {"model": "keep"}
    assert stat.S_IMODE(backups[0].stat().st_mode) == 0o600


def test_dangling_settings_symlink_writes_nothing(tmp_path, run_install):
    target = tmp_path / "claude"
    target.mkdir()
    (target / "settings.json").symlink_to(tmp_path / "missing.json")
    before = snapshot(tmp_path)
    result = run_install("--apply")
    assert result.returncode == 2
    assert snapshot(tmp_path) == before


def test_setup_skill_is_not_linked(tmp_path, run_install):
    result = run_install("--apply")
    assert result.returncode == 0, result.stderr
    assert not os.path.lexists(tmp_path / "claude" / "skills" / "claude-env-setup")
