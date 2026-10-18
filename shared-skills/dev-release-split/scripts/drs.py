#!/usr/bin/env python3
"""Export filtered, history-independent release snapshots using Git plumbing."""

import argparse
from dataclasses import dataclass
from datetime import date
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile


SKILL_DIR = Path(__file__).resolve().parent.parent
HOOK_MARKER = b"# dev-release-split pre-push hook v1\n"
DEFAULT_SCANNER = SKILL_DIR / "scripts" / "leak_scan.py"
MENTIONS = ("Claude Code", "CLAUDE.md", "AGENTS.md", "Codex", "codex-run", "TASKS.md")


class ReleaseError(Exception):
    pass


@dataclass(frozen=True)
class Entry:
    mode: str
    oid: str
    path: str


@dataclass(frozen=True)
class Finding:
    severity: str
    check: str
    path: str
    line: int | None
    detail: str


def scan_path_valid(path: str) -> bool:
    return bool(path) and not any(ord(char) < 32 or ord(char) == 127 for char in path) and all(
        part not in {"", ".", ".."} and part.casefold() != ".git" for part in path.split("/")
    )


def read_scan_allow(snapshot: Path, entries: list[Entry]) -> set[tuple[str, str, str]] | None:
    entry = next((item for item in entries if item.path == ".releasescan-allow"), None)
    if any(item.path.startswith(".releasescan-allow/") for item in entries) or (
        entry is not None and entry.mode not in {"100644", "100755"}
    ):
        raise ReleaseError("the commit's .releasescan-allow must be a regular file")
    if entry is None:
        return None
    try:
        text = (snapshot / entry.path).read_text(encoding="utf-8")
    except UnicodeError:
        raise ReleaseError("the commit's .releasescan-allow must be UTF-8") from None
    allowed = set()
    for number, line in enumerate(text.splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        # The first and last fields delimit the path, which may contain spaces.
        match = re.fullmatch(r"([^\s\x00-\x1f\x7f]+)\s+(.+?)\s+([0-9a-fA-F]{64}|-)", line)
        if not match or not scan_path_valid(match[2]):
            raise ReleaseError(f"malformed .releasescan-allow entry at line {number}")
        allowed.add((match[1], match[2], match[3].lower()))
    return allowed


def parse_findings(output: bytes) -> list[Finding]:
    error = "invalid scanner JSON: expected a list of findings with severity, check, path, line, detail"
    try:
        rows = json.loads(output)
    except (ValueError, UnicodeError):
        raise ReleaseError(error) from None
    if not isinstance(rows, list):
        raise ReleaseError(error)
    findings = []
    for row in rows:
        if (not isinstance(row, dict)
                or not {"severity", "check", "path", "line", "detail"} <= row.keys()
                or not isinstance(row["severity"], str) or row["severity"] not in {"high", "medium", "low"}
                or not isinstance(row["check"], str) or not re.fullmatch(r"[^\s\x00-\x1f\x7f]+", row["check"])
                or not isinstance(row["path"], str) or not scan_path_valid(row["path"])
                or not isinstance(row["detail"], str)
                or (row["line"] is not None and (type(row["line"]) is not int or row["line"] < 1))):
            raise ReleaseError(error)
        findings.append(Finding(row["severity"], row["check"], row["path"], row["line"], row["detail"]))
    return findings


def finding_hash(snapshot: Path, finding: Finding) -> str:
    try:
        path = (snapshot / finding.path).resolve()
        if path.is_relative_to(snapshot.resolve()):
            if path.is_file():
                if finding.line is None:
                    with path.open("rb") as source:
                        return hashlib.file_digest(source, "sha256").hexdigest()
                # Universal newlines remove LF, CRLF or CR, preserving all other text.
                with path.open(encoding="utf-8") as source:
                    for number, line in enumerate(source, 1):
                        if number == finding.line:
                            return hashlib.sha256(line.removesuffix("\n").encode("utf-8")).hexdigest()
            elif finding.line is None:
                return "-"
    except (OSError, UnicodeError, RuntimeError):
        pass
    raise ReleaseError(f"cannot hash scanner finding at {finding.path}:{finding.line}; nothing committed")


def scan_with_allowlist(
    scanner: Path, snapshot: Path, allowed: set[tuple[str, str, str]], env: dict[str, str],
) -> None:
    result = subprocess.run(
        [sys.executable, str(scanner), "--root", str(snapshot), "--json", "--no-fail"],
        cwd=snapshot, env=env, stdout=subprocess.PIPE,
    )
    if result.returncode:
        raise ReleaseError(f"leak scanner exited {result.returncode}; nothing committed")
    findings = parse_findings(result.stdout)
    matched = set()
    blocking = []
    for finding in findings:
        try:
            digest = finding_hash(snapshot, finding)
        except ReleaseError:
            if finding.severity == "low":
                continue
            raise
        key = (finding.check, finding.path, digest)
        if key in allowed:
            matched.add(key)
        elif finding.severity in {"high", "medium"}:
            blocking.append((finding, key))
    for entry in sorted(allowed - matched):
        print(f"warning: unmatched .releasescan-allow entry: {' '.join(entry)}", file=sys.stderr)
    for finding, key in blocking:
        location = finding.line if finding.line is not None else "-"
        print(f"{finding.severity} {finding.check} {finding.path}:{location}", file=sys.stderr)
        if finding.severity == "high" or finding.check == "secret-pattern":
            print("remove the value; do not allow it", file=sys.stderr)
        else:
            print(" ".join(key), file=sys.stderr)
    if blocking:
        raise ReleaseError("leak scanner found unallowed high/medium findings; nothing committed")


def git_env(*, isolated: bool = False) -> dict[str, str]:
    env = os.environ.copy()
    for key in (
        "GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX",
        "GIT_NAMESPACE",
    ):
        env.pop(key, None)
    if isolated:
        env = {key: value for key, value in env.items() if not key.startswith("GIT_")}
        env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull, GIT_ATTR_NOSYSTEM="1")
    env["GIT_NO_REPLACE_OBJECTS"] = "1"
    return env


def git(
    repo: Path, *args: str, data: bytes | None = None,
    env: dict[str, str] | None = None, allow_missing: bool = False,
) -> bytes:
    result = subprocess.run(
        ["git", "-C", str(repo), *args], input=data, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, env={**(git_env() if env is None else env), "GIT_NO_REPLACE_OBJECTS": "1"},
    )
    if result.returncode:
        if allow_missing and result.returncode == 1:
            return b""
        raise ReleaseError(result.stderr.decode(errors="replace").strip() or f"git {args[0]} failed")
    return result.stdout


def config(repo: Path, key: str) -> str:
    return os.fsdecode(git(repo, "config", "--local", "--get", f"dev-release.{key}", allow_missing=True)).strip()


def settings(repo: Path) -> tuple[str, str, str]:
    values = tuple(config(repo, key) for key in ("remote", "branch", "target"))
    if not all(values):
        raise ReleaseError("run setup first: release remote, branch and target must be configured")
    remote, branch, target = values
    git(repo, "check-ref-format", f"refs/heads/{branch}")
    git(repo, "check-ref-format", f"refs/heads/{target}")
    git(repo, "check-ref-format", f"refs/remotes/{remote}/{target}")
    return remote, branch, target


def hook_path(repo: Path) -> Path:
    path = Path(os.fsdecode(git(repo, "rev-parse", "--git-path", "hooks")).strip())
    return (path if path.is_absolute() else repo / path) / "pre-push"


def is_our_hook(path: Path) -> bool:
    return path.is_file() and HOOK_MARKER in path.read_bytes().splitlines(keepends=True)[:3]


def setup(repo: Path, args: argparse.Namespace) -> None:
    git(repo, "check-ref-format", f"refs/heads/{args.branch}")
    git(repo, "check-ref-format", f"refs/heads/{args.target}")
    git(repo, "check-ref-format", f"refs/remotes/{args.remote}/{args.target}")
    branch_ref = f"refs/heads/{args.branch}"
    require_direct_ref(repo, branch_ref)
    if git(repo, "symbolic-ref", "--quiet", "HEAD", allow_missing=True).decode().strip() == branch_ref:
        raise ReleaseError("the snapshot branch must not be the current branch; choose a dedicated release branch")
    parent = tip(repo, branch_ref) or tip(repo, f"refs/remotes/{args.remote}/{args.target}")
    validate_parent(repo, parent, branch_ref, args.remote)
    remotes = os.fsdecode(git(repo, "remote")).splitlines()
    for name in args.dev_remote:
        git(repo, "check-ref-format", f"refs/remotes/{name}/{args.target}")
        if name == args.remote:
            raise ReleaseError("the release remote cannot be a dev remote")
    configured = os.fsdecode(git(
        repo, "config", "--local", "--null", "--get-all", "dev-release.devremote", allow_missing=True,
    ))
    configured_dev = configured.removesuffix("\0").split("\0") if configured else []
    dev_remotes = sorted(set(configured_dev + remotes + args.dev_remote) - {args.remote, ""})
    if args.remote in remotes:
        url = os.fsdecode(git(repo, "config", "--local", "--get", f"remote.{args.remote}.url")).strip()
        if url != args.release_url:
            raise ReleaseError(f"remote {args.remote!r} already exists with a different URL")

    hook = hook_path(repo)
    previous = hook.with_name("pre-push.dev-release-prev")
    needs_backup = os.path.lexists(hook) and not is_our_hook(hook)
    if needs_backup and os.path.lexists(previous):
        raise ReleaseError(f"both {hook} and {previous} exist; refusing to overwrite either hook")
    if args.remote not in remotes:
        git(repo, "remote", "add", "--", args.remote, args.release_url)
    for key, value in (("remote", args.remote), ("branch", args.branch), ("target", args.target)):
        git(repo, "config", "--local", f"dev-release.{key}", value)
    if configured_dev:
        git(repo, "config", "--local", "--unset-all", "dev-release.devremote")
    for name in dev_remotes:
        git(repo, "config", "--local", "--add", "dev-release.devremote", name)
    ignore = repo / ".releaseignore"
    if not os.path.lexists(ignore):
        shutil.copyfile(SKILL_DIR / "defaults.releaseignore", ignore)
    hook.parent.mkdir(parents=True, exist_ok=True)
    if needs_backup:
        hook.rename(previous)
    # Replace, rather than follow, an existing hook symlink.
    with tempfile.NamedTemporaryFile(dir=hook.parent, delete=False) as staged:
        staged_path = Path(staged.name)
        staged.write((SKILL_DIR / "scripts" / "pre_push_hook.py").read_bytes())
    try:
        staged_path.chmod(0o755)
        staged_path.replace(hook)
    finally:
        staged_path.unlink(missing_ok=True)
    print(f"Configured {args.remote}: {args.branch} -> {args.target}")
    print("The pre-push hook is local; clones need setup again. No fetch or push performed.")


def entries_at(repo: Path, commit: str) -> list[Entry]:
    entries = []
    for record in git(repo, "ls-tree", "-rz", "--full-tree", commit).split(b"\0"):
        if not record:
            continue
        metadata, raw_path = record.split(b"\t", 1)
        mode, kind, oid = metadata.decode("ascii").split()
        path = os.fsdecode(raw_path)
        if kind != "blob" or mode not in {"100644", "100755", "120000"}:
            raise ReleaseError(f"unsupported tracked entry (submodules are not exported): {path!r}")
        entries.append(Entry(mode, oid, path))
    validate_paths(entries)
    return entries


def validate_paths(entries: list[Entry]) -> None:
    symlinks = {entry.path.casefold() for entry in entries if entry.mode == "120000"}
    files = {entry.path.casefold() for entry in entries}
    if len(files) != len(entries):
        raise ReleaseError("casefold path collision between tracked files")
    prefixes: dict[str, str] = {}
    for entry in entries:
        parts = entry.path.split("/")
        if any(part in {"", ".", ".."} or part.casefold() == ".git" for part in parts):
            raise ReleaseError(f"unsafe tracked path: {entry.path!r}")
        for length in range(1, len(parts) + 1):
            prefix = "/".join(parts[:length])
            folded = prefix.casefold()
            if length < len(parts) and folded in symlinks:
                raise ReleaseError(f"symlink ancestor in tracked path: {entry.path!r}")
            if ((folded in prefixes and prefixes[folded] != prefix)
                    or (length < len(parts) and folded in files)):
                raise ReleaseError(f"casefold path collision at {prefix!r}")
            prefixes[folded] = prefix


def materialize(repo: Path, snapshot: Path, entries: list[Entry]) -> None:
    # Validate the entire tree before creating even the first directory.
    validate_paths(entries)
    root = snapshot.resolve()
    for entry in entries:
        destination = snapshot / entry.path
        if not destination.parent.resolve().is_relative_to(root):
            raise ReleaseError(f"snapshot path escapes its root: {entry.path!r}")
        data = git(repo, "cat-file", "blob", entry.oid)
        directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        parent_fd = os.open(snapshot, directory_flags)
        try:
            parts = entry.path.split("/")
            for part in parts[:-1]:
                try:
                    os.mkdir(part, dir_fd=parent_fd)
                except FileExistsError:
                    pass
                child_fd = os.open(part, directory_flags, dir_fd=parent_fd)
                os.close(parent_fd)
                parent_fd = child_fd
            if entry.mode == "120000":
                os.symlink(os.fsdecode(data), parts[-1], dir_fd=parent_fd)
            else:
                fd = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o600, dir_fd=parent_fd)
                with os.fdopen(fd, "wb") as output:
                    output.write(data)
                    os.fchmod(output.fileno(), 0o755 if entry.mode == "100755" else 0o644)
        finally:
            os.close(parent_fd)


def preview(snapshot: Path, kept: list[Entry], excluded: list[Entry]) -> None:
    print(f"Tracked: {len(kept) + len(excluded)}; kept: {len(kept)}; excluded: {len(excluded)}")
    print("Excluded paths:")
    for entry in excluded:
        print(f"  {entry.path!r}")
    print("Suspicious kept files (warnings only):")
    for entry in kept:
        reasons = []
        if re.search(r"plan|report|note|todo|handoff|memo", entry.path, re.IGNORECASE):
            reasons.append("name")
        if entry.mode != "120000":
            data = (snapshot / entry.path).read_bytes()
            if b"\0" not in data:
                try:
                    text = data.decode("utf-8")
                except UnicodeDecodeError:
                    text = ""
                reasons.extend(term for term in MENTIONS if term in text)
        if reasons:
            print(f"  {entry.path!r}: {', '.join(reasons)}")


def index_entries(entries: list[Entry]) -> bytes:
    return b"".join(
        f"{entry.mode} {entry.oid}\t".encode("ascii") + os.fsencode(entry.path) + b"\0"
        for entry in entries
    )


def tip(repo: Path, ref: str) -> str:
    return git(repo, "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}", allow_missing=True).decode().strip()


def require_direct_ref(repo: Path, ref: str) -> None:
    if git(repo, "symbolic-ref", "--quiet", ref, allow_missing=True):
        raise ReleaseError(f"snapshot ref {ref} is symbolic; use a dedicated direct branch")


def validate_parent(repo: Path, parent: str, branch_ref: str, remote: str) -> None:
    if not parent:
        return
    refs = os.fsdecode(git(repo, "for-each-ref", "--format=%(refname)")).splitlines()
    other_refs = [ref for ref in refs if ref != branch_ref and not ref.startswith(f"refs/remotes/{remote}/")]
    total = git(repo, "rev-list", "--count", parent, "--").strip()
    exclusive = git(repo, "rev-list", "--count", parent, "--not", *other_refs, "--").strip()
    if exclusive != total:
        raise ReleaseError("snapshot parent shares history with another ref; use an independent release history")
    if git(repo, "rev-list", "--min-parents=2", parent, "--"):
        raise ReleaseError("snapshot parent history contains a merge; only linear release history is allowed")


def export(repo: Path, args: argparse.Namespace) -> None:
    remote, branch, target = settings(repo)
    branch_ref = f"refs/heads/{branch}"
    require_direct_ref(repo, branch_ref)
    worktrees = git(repo, "worktree", "list", "--porcelain", "-z").split(b"\0")
    if os.fsencode(f"branch {branch_ref}") in worktrees:
        raise ReleaseError("the snapshot branch is checked out; switch to a dev branch before exporting")
    commit = git(repo, "rev-parse", "--verify", "--end-of-options", f"{args.commit}^{{commit}}").decode().strip()
    entries = entries_at(repo, commit)
    message = args.message if args.message is not None else f"Release {date.today().isoformat()}"
    hex_tokens = re.findall(r"[0-9a-f]{7,}", message.lower())
    if commit.lower() in message.lower() or any(commit.lower().startswith(token) for token in hex_tokens):
        raise ReleaseError("release messages must not contain the dev commit SHA")
    if git(repo, "interpret-trailers", "--parse", data=message.encode()):
        raise ReleaseError("release messages must not contain trailers")
    old_tip = tip(repo, branch_ref)
    parent = old_tip or tip(repo, f"refs/remotes/{remote}/{target}")
    validate_parent(repo, parent, branch_ref, remote)

    with tempfile.TemporaryDirectory(prefix="dev-release-split-") as temporary:
        scratch = Path(temporary)
        snapshot = scratch / "snapshot"
        snapshot.mkdir()
        isolated_env = git_env(isolated=True)
        object_format = git(repo, "rev-parse", "--show-object-format").decode().strip()
        git(snapshot, "init", "--quiet", "--template=", f"--object-format={object_format}", env=isolated_env)
        materialize(repo, snapshot, entries)
        scan_allow = read_scan_allow(snapshot, entries)
        rules = (SKILL_DIR / "defaults.releaseignore").read_bytes() + b"\n"
        project_rules = next((entry for entry in entries if entry.path == ".releaseignore"), None)
        if project_rules:
            if project_rules.mode == "120000":
                raise ReleaseError("the commit's .releaseignore must be a regular file")
            rules += (snapshot / ".releaseignore").read_bytes()
        rule_file = scratch / "rules"
        rule_file.write_bytes(rules)
        # Without --exclude-standard, tracked .gitignore files cannot affect selection.
        ignored = set(git(
            snapshot, "ls-files", "--others", "--ignored", "-z", f"--exclude-from={rule_file}",
            env=isolated_env,
        ).split(b"\0"))
        # Review metadata must never ship, even if project rules negate defaults.
        ignored.add(b".releasescan-allow")
        kept = [entry for entry in entries if os.fsencode(entry.path) not in ignored]
        excluded = [entry for entry in entries if os.fsencode(entry.path) in ignored]
        preview(snapshot, kept, excluded)
        for entry in excluded:
            (snapshot / entry.path).unlink()
        # Hash raw bytes so .gitattributes filters cannot change the scanned files.
        for entry in kept:
            path = snapshot / entry.path
            data = os.fsencode(os.readlink(path)) if entry.mode == "120000" else path.read_bytes()
            oid = git(snapshot, "hash-object", "-w", "--stdin", data=data, env=isolated_env).decode().strip()
            if oid != entry.oid:
                raise ReleaseError(f"snapshot blob hash mismatch: {entry.path!r}; nothing committed")
        git(snapshot, "update-index", "-z", "--index-info", data=index_entries(kept), env=isolated_env)

        if not args.no_scan:
            scanner = Path(config(repo, "scanner") or DEFAULT_SCANNER).expanduser()
            if not scanner.is_absolute():
                scanner = repo / scanner
            if not scanner.is_file():
                raise ReleaseError(f"scanner missing: {scanner}; install it or pass --no-scan")
            if scan_allow is None:
                result = subprocess.run([sys.executable, str(scanner), "--root", str(snapshot)], cwd=snapshot, env=isolated_env)
                if result.returncode:
                    raise ReleaseError(f"leak scanner exited {result.returncode}; nothing committed")
            else:
                scan_with_allowlist(scanner, snapshot, scan_allow, isolated_env)
        check = args.check if args.check is not None else config(repo, "check")
        if check:
            result = subprocess.run(check, shell=True, cwd=snapshot, env=isolated_env)
            if result.returncode:
                raise ReleaseError(f"build check exited {result.returncode}; nothing committed")
        if args.dry_run:
            print("Dry run complete; no commit or ref changed.")
            return

        require_direct_ref(repo, branch_ref)
        validate_parent(repo, parent, branch_ref, remote)
        index_env = git_env()
        index_env["GIT_INDEX_FILE"] = str(scratch / "dev-index")
        git(repo, "read-tree", "--empty", env=index_env)
        git(repo, "update-index", "-z", "--index-info", data=index_entries(kept), env=index_env)
        tree = git(repo, "write-tree", env=index_env).decode().strip()
        if parent and tree == git(repo, "rev-parse", f"{parent}^{{tree}}").decode().strip():
            print("nothing to release")
            return
        parent_args = ["-p", parent] if parent else []
        release = git(repo, "commit-tree", tree, *parent_args, "-F", "-", data=message.encode()).decode().strip()
        git(repo, "update-ref", "--no-deref", branch_ref, release, old_tip or "0" * len(commit))
        print(f"Created release snapshot {release} from dev commit {commit}")
        print("Run this yourself in your own terminal:")
        print(shlex.join(["git", "push", remote, f"{branch}:{target}"]))


def status(repo: Path) -> None:
    for key in ("remote", "branch", "target", "scanner", "check"):
        print(f"dev-release.{key}: {config(repo, key) or '(not set)'}")
    print(f"Hook installed: {'yes' if is_our_hook(hook_path(repo)) else 'no'}")
    branch = config(repo, "branch")
    print(f"Snapshot branch tip: {(tip(repo, f'refs/heads/{branch}') if branch else '') or '(none)'}")
    print(f".releaseignore exists: {'yes' if os.path.lexists(repo / '.releaseignore') else 'no'}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    setup_parser = commands.add_parser("setup")
    setup_parser.add_argument("release_url")
    setup_parser.add_argument("--remote", default="release")
    setup_parser.add_argument("--branch", default="release-snapshot")
    setup_parser.add_argument("--target", default="main")
    setup_parser.add_argument("--dev-remote", action="append", default=[], metavar="NAME",
                              help="allow a named dev remote without terminal confirmation (repeatable)")
    export_parser = commands.add_parser("export")
    export_parser.add_argument("--commit", default="HEAD")
    export_parser.add_argument("--message")
    export_parser.add_argument("--dry-run", action="store_true")
    export_parser.add_argument("--no-scan", action="store_true")
    export_parser.add_argument("--check")
    status_parser = commands.add_parser("status")
    for subparser in (setup_parser, export_parser, status_parser):
        subparser.add_argument("--repo", default=".")
    args = parser.parse_args()
    try:
        repo = Path(os.fsdecode(git(Path(args.repo), "rev-parse", "--show-toplevel")).strip())
        if args.command == "setup":
            setup(repo, args)
        elif args.command == "export":
            export(repo, args)
        else:
            status(repo)
    except (ReleaseError, OSError, ValueError) as exc:
        print(f"dev-release-split: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
