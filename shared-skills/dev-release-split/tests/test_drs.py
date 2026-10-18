import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys

import pytest


SKILL = Path(__file__).resolve().parents[1]
CLI = SKILL / "scripts" / "drs.py"
HOOK = SKILL / "scripts" / "pre_push_hook.py"
SCANNER = SKILL / "scripts" / "leak_scan.py"
BRANCH = "refs/heads/release-snapshot"
ZERO = "0" * 40


def run(args, cwd, *, ok=True, data=None, detached=False):
    result = subprocess.run(
        [str(arg) for arg in args], cwd=cwd, input=data, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=detached,
    )
    if ok:
        assert result.returncode == 0, result.stdout + result.stderr
    return result


def git(repo, *args, ok=True, data=None, detached=False):
    return run(["git", *args], repo, ok=ok, data=data, detached=detached)


def drs(repo, *args, ok=True):
    return run([sys.executable, CLI, *args, "--repo", repo], repo, ok=ok)


def write(repo, path, content="project content\n"):
    destination = repo / path
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(content)
    return destination


def commit(repo, message="Dev change"):
    git(repo, "add", "--all")
    git(repo, "commit", "-m", message)
    return git(repo, "rev-parse", "HEAD").stdout.strip()


def ref(repo, name=BRANCH):
    result = git(repo, "rev-parse", "--verify", "--quiet", name, ok=False)
    assert result.returncode in (0, 1), result.stderr
    return result.stdout.strip()


def tree(repo, name=BRANCH):
    return set(git(repo, "ls-tree", "-rz", "--name-only", name).stdout.rstrip("\0").split("\0")) - {""}


def installed_hook(repo):
    path = Path(git(repo, "rev-parse", "--git-path", "hooks").stdout.strip())
    return (path if path.is_absolute() else repo / path) / "pre-push"


@pytest.fixture(autouse=True)
def isolated_git(monkeypatch, tmp_path):
    for key in list(os.environ):
        if key.startswith("GIT_"):
            monkeypatch.delenv(key)
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(tmp_path / "empty-global-config"))
    monkeypatch.setenv("GIT_ATTR_NOSYSTEM", "1")
    monkeypatch.setenv("GIT_TERMINAL_PROMPT", "0")
    monkeypatch.setenv("GIT_ALLOW_PROTOCOL", "file")
    monkeypatch.setenv("PYTHONDONTWRITEBYTECODE", "1")


@pytest.fixture
def project(tmp_path):
    repo = tmp_path / "dev repo"
    repo.mkdir()
    git(repo, "init", "--quiet", "--template=", "--initial-branch=main")
    git(repo, "config", "user.name", "Snapshot Tests")
    git(repo, "config", "user.email", "snapshot@example.org")
    write(repo, "app.txt", "hello\n")
    commit(repo)
    bare = tmp_path / "release.git"
    git(tmp_path, "init", "--quiet", "--bare", "--template=", bare)
    scanner = tmp_path / "scanner.py"
    receipt = tmp_path / "scanner-result.json"
    scanner.write_text(
        "import argparse, json, subprocess\nfrom pathlib import Path\n"
        "p = argparse.ArgumentParser(); p.add_argument('--root'); a = p.parse_args()\n"
        "root = Path(a.root)\n"
        "files = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split('\\0')\n"
        f"Path({str(receipt)!r}).write_text(json.dumps({{'files': sorted(filter(None, files)), 'root': str(root)}}))\n"
    )
    git(repo, "config", "dev-release.scanner", scanner)
    return repo, bare, scanner, receipt


def configure(project, *options):
    repo, bare, _, _ = project
    return drs(repo, "setup", str(bare), *options)


def hook_run(repo, remote, url, lines, *, ok=False):
    return run([installed_hook(repo), remote, url], repo, ok=ok, data=lines, detached=True)


def install_previous(repo, marker, exit_code=0):
    hook = installed_hook(repo)
    hook.parent.mkdir(parents=True, exist_ok=True)
    hook.write_text(
        f"#!{sys.executable}\nimport json, sys\nfrom pathlib import Path\n"
        f"Path({str(marker)!r}).write_text(json.dumps({{'args': sys.argv[1:], 'stdin': sys.stdin.read()}}))\n"
        f"raise SystemExit({exit_code})\n"
    )
    hook.chmod(0o755)
    return hook.read_bytes()


def test_default_selection_and_scanner_input(project):
    repo, _, _, receipt = project
    configure(project)
    excluded = {
        "CLAUDE.md", "sub/CLAUDE.md", "CLAUDE.local.md", "sub/CLAUDE.local.md",
        "AGENTS.md", "sub/AGENTS.md", ".claude/x", "a/.claude/x",
        "GEMINI.md", "sub/GEMINI.md", ".codex/x", "sub/.codex/x",
        ".cursor/x", ".gemini/x", ".windsurf/x", ".aider.conf.yml",
        ".aider-cache/x", ".cursorrules", ".windsurfrules", ".clinerules",
        ".mcp.json", ".mcp.local.json", ".env", ".env.example", "sub/.env.test",
        ".direnv/x", ".netrc", ".pypirc", "cert.pem", "sub/private.key",
        ".idea/x", ".vscode/x", "app.code-workspace", "app.swp", "app.swo",
        "app~", ".DS_Store", "sub/Thumbs.db", "TASKS.md", "TASKS/x",
        ".agent-work/x", ".scratch/x", ".notes/x", ".releaseignore",
    }
    for prefix in ("", "nested/"):
        excluded.update({
            f"{prefix}.github/copilot-instructions.md", f"{prefix}.github/instructions/x",
            f"{prefix}.github/prompts/x", f"{prefix}.github/agents/x",
        })
    kept = {
        "app.txt", "docs/guide.md", "reports/result.md", "plans/design.md",
        ".github/workflows/ci.yml", "sub/TASKS/x", "sub/TASKS.md",
        "sub/.agent-work/x", "sub/.scratch/x", "sub/.notes/x",
    }
    for path in (excluded - {".releaseignore"}) | kept:
        write(repo, path)
    commit(repo)
    result = drs(repo, "export")
    assert tree(repo) == kept
    assert set(json.loads(receipt.read_text())["files"]) == kept
    for path in excluded:
        assert repr(path) in result.stdout
    assert "Suspicious kept files" in result.stdout
    assert "'reports/result.md': name" in result.stdout


def test_root_overrides_do_not_reenable_nested_agent_files(project):
    repo, _, _, _ = project
    configure(project)
    write(repo, ".releaseignore", "!/.claude/\n/.claude/*\n!/.claude/skills/\n!/AGENTS.md\n")
    for path in (".claude/skills/x/SKILL.md", ".claude/settings.json", "a/.claude/x", "AGENTS.md", "sub/AGENTS.md"):
        write(repo, path)
    commit(repo)
    drs(repo, "export")
    assert tree(repo) == {"app.txt", ".claude/skills/x/SKILL.md", "AGENTS.md"}


def test_ignore_rules_come_from_selected_commit_only(project):
    repo, _, _, _ = project
    configure(project)
    write(repo, ".releaseignore", "/old-private.txt\n")
    write(repo, "old-private.txt")
    write(repo, "public.txt")
    old = commit(repo)
    write(repo, ".releaseignore", "/public.txt\n")
    commit(repo)
    write(repo, ".releaseignore", "/app.txt\n")
    drs(repo, "export", "--commit", old)
    assert tree(repo) == {"app.txt", "public.txt"}


def test_gitignore_info_and_global_excludes_do_not_select_files(project, tmp_path, monkeypatch):
    repo, _, _, _ = project
    configure(project)
    write(repo, ".gitignore", "forced.txt\n")
    write(repo, "sub/.gitignore", "nested.txt\n")
    for path in ("forced.txt", "sub/nested.txt", "info-hidden.txt", "global-hidden.txt"):
        write(repo, path)
    write(repo, ".git/info/exclude", "info-hidden.txt\n")
    global_excludes = tmp_path / "global-excludes"
    global_excludes.write_text("global-hidden.txt\n")
    global_config = tmp_path / "global-config"
    global_config.write_text(f"[core]\n    excludesFile = {global_excludes}\n")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(global_config))
    git(repo, "add", "--force", ".")
    commit(repo)
    drs(repo, "export")
    assert tree(repo) == {"app.txt", ".gitignore", "sub/.gitignore", "forced.txt", "sub/nested.txt", "info-hidden.txt", "global-hidden.txt"}


def test_snapshots_preserve_modes_bytes_and_dev_state(project):
    repo, _, _, _ = project
    configure(project)
    write(repo, "CLAUDE.md", "private instructions\n")
    write(repo, "run.sh", "#!/bin/sh\necho ok\n").chmod(0o755)
    write(repo, "data.bin", "line\r\n")
    os.symlink("app.txt", repo / "app-link")
    dev_sha = commit(repo)
    write(repo, "staged.txt", "staged\n")
    git(repo, "add", "staged.txt")
    write(repo, "app.txt", "dirty\n")
    write(repo, "untracked.txt")
    # status may refresh the index stat cache, so read the index bytes after it.
    status_before = git(repo, "status", "--porcelain=v1", "-z").stdout
    index_before = (repo / ".git/index").read_bytes()
    head_before = (repo / ".git/HEAD").read_bytes()
    result = drs(repo, "export")
    first = ref(repo)
    assert tree(repo) == {"app.txt", "run.sh", "data.bin", "app-link"}
    assert git(repo, "rev-list", "--count", BRANCH).stdout.strip() == "1"
    assert git(repo, "rev-list", "--parents", "-n", "1", BRANCH).stdout.split() == [first]
    message = git(repo, "show", "-s", "--format=%B", first).stdout
    assert message.startswith("Release ") and dev_sha not in message
    assert git(repo, "interpret-trailers", "--parse", data=message).stdout == ""
    assert git(repo, "ls-tree", BRANCH, "run.sh").stdout.startswith("100755 ")
    assert git(repo, "ls-tree", BRANCH, "app-link").stdout.startswith("120000 ")
    for path in ("app.txt", "run.sh", "data.bin", "app-link"):
        assert git(repo, "rev-parse", f"{BRANCH}:{path}").stdout == git(repo, "rev-parse", f"{dev_sha}:{path}").stdout
    assert (repo / ".git/index").read_bytes() == index_before
    assert (repo / ".git/HEAD").read_bytes() == head_before
    assert git(repo, "rev-parse", "HEAD").stdout.strip() == dev_sha
    assert git(repo, "status", "--porcelain=v1", "-z").stdout == status_before
    assert (repo / "app.txt").read_text() == "dirty\n"
    assert (repo / "staged.txt").read_text() == "staged\n"
    assert (repo / "untracked.txt").is_file()
    assert dev_sha in result.stdout
    assert "git push release release-snapshot:main" in result.stdout
    result = drs(repo, "export")
    assert "nothing to release" in result.stdout and ref(repo) == first
    commit(repo)
    drs(repo, "export", "--message", "Ship updated app")
    assert git(repo, "rev-parse", f"{BRANCH}^").stdout.strip() == first
    assert git(repo, "rev-list", "--count", BRANCH).stdout.strip() == "2"


def test_remote_tracking_tip_is_parent_until_local_branch_exists(project):
    repo, _, _, _ = project
    configure(project)
    empty_tree = git(repo, "mktree", data="").stdout.strip()
    remote_tip = git(repo, "commit-tree", empty_tree, "-m", "Existing release").stdout.strip()
    git(repo, "update-ref", "refs/remotes/release/main", remote_tip)
    drs(repo, "export")
    assert git(repo, "rev-parse", f"{BRANCH}^").stdout.strip() == remote_tip
    first = ref(repo)
    unrelated = git(repo, "commit-tree", empty_tree, "-m", "Unrelated remote state").stdout.strip()
    git(repo, "update-ref", "refs/remotes/release/main", unrelated)
    write(repo, "app.txt", "updated\n")
    commit(repo)
    drs(repo, "export")
    assert git(repo, "rev-parse", f"{BRANCH}^").stdout.strip() == first


@pytest.mark.parametrize("exit_code", [1, 2, 23])
def test_scanner_failure_leaves_no_commit(project, exit_code):
    repo, _, scanner, _ = project
    configure(project)
    scanner.write_text(f"raise SystemExit({exit_code})\n")
    before = git(repo, "rev-list", "--all").stdout
    result = drs(repo, "export", ok=False)
    assert result.returncode == 1 and f"scanner exited {exit_code}" in result.stderr
    assert not ref(repo)
    assert git(repo, "rev-list", "--all").stdout == before


def scan_finding(*, severity="medium", check="fixture-path", path="app.txt", line=1):
    return dict(severity=severity, check=check, path=path, line=line, detail="DO NOT PRINT DETAILS")


def allow_line(text="hello", *, check="fixture-path", path="app.txt"):
    digest = "-" if text is None else hashlib.sha256(text.encode("utf-8")).hexdigest()
    return f"{check} {path} {digest}\n"


def json_scanner(project, findings, *, output=None, exit_code=0):
    _, _, scanner, receipt = project
    output = json.dumps(findings) if output is None else output
    scanner.write_text(
        "import argparse, json, subprocess\nfrom pathlib import Path\n"
        "p = argparse.ArgumentParser(); p.add_argument('--root')\n"
        "p.add_argument('--json', action='store_true'); p.add_argument('--no-fail', action='store_true')\n"
        "a = p.parse_args(); assert a.json and a.no_fail\n"
        "root = Path(a.root)\n"
        "assert not (root / '.releasescan-allow').exists()\n"
        "files = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split('\\0')\n"
        f"Path({str(receipt)!r}).write_text(json.dumps({{'files': sorted(filter(None, files))}}))\n"
        f"print({output!r})\nraise SystemExit({exit_code})\n"
    )


@pytest.mark.parametrize("override", [False, True])
def test_reviewed_allowance_accepts_matching_finding_and_never_ships(project, override):
    repo, _, _, receipt = project
    configure(project)
    if override:
        write(repo, ".releaseignore", "!/.releasescan-allow\n")
    write(repo, ".releasescan-allow", "# Human-reviewed fixture\n\n" + allow_line())
    commit(repo)
    json_scanner(project, [scan_finding()])
    result = drs(repo, "export")
    assert tree(repo) == {"app.txt"}
    assert json.loads(receipt.read_text())["files"] == ["app.txt"]
    assert "unmatched" not in result.stderr
    assert "DO NOT PRINT DETAILS" not in result.stdout + result.stderr


@pytest.mark.parametrize("text", ["changed", "hello "])
def test_changed_line_invalidates_allowance_without_committing(project, text):
    repo, _, _, _ = project
    configure(project)
    write(repo, ".releasescan-allow", allow_line())
    commit(repo)
    json_scanner(project, [scan_finding()])
    drs(repo, "export")
    previous = ref(repo)
    write(repo, "app.txt", text + "\n")
    commit(repo)
    before = git(repo, "count-objects", "-v").stdout
    result = drs(repo, "export", ok=False)
    assert result.returncode == 1 and "medium fixture-path app.txt:1" in result.stderr
    assert allow_line(text).strip() in result.stderr
    assert "warning: unmatched" in result.stderr
    assert ref(repo) == previous
    assert git(repo, "count-objects", "-v").stdout == before


@pytest.mark.parametrize("new_finding", [
    scan_finding(check="new-check"),
    scan_finding(path="new.txt"),
    scan_finding(line=2),
])
def test_new_finding_blocks_and_prints_its_allow_line(project, new_finding):
    repo, _, _, _ = project
    configure(project)
    write(repo, ".releasescan-allow", allow_line())
    write(repo, "app.txt", "hello\nNEW PRIVATE TEXT\n")
    write(repo, "new.txt", "NEW PRIVATE TEXT\n")
    commit(repo)
    json_scanner(project, [scan_finding(), new_finding])
    before = git(repo, "count-objects", "-v").stdout
    result = drs(repo, "export", ok=False)
    assert result.returncode == 1
    assert f"{new_finding['severity']} {new_finding['check']} {new_finding['path']}:{new_finding['line']}" in result.stderr
    text = "hello" if new_finding["check"] == "new-check" else "NEW PRIVATE TEXT"
    assert allow_line(text, check=new_finding["check"], path=new_finding["path"]).strip() in result.stderr
    assert "medium fixture-path app.txt:1\n" not in result.stderr
    assert "NEW PRIVATE TEXT" not in result.stdout + result.stderr
    assert "DO NOT PRINT DETAILS" not in result.stdout + result.stderr
    assert not ref(repo)
    assert git(repo, "count-objects", "-v").stdout == before


@pytest.mark.parametrize("severity,check", [
    ("high", "fixture-path"), ("high", "secret-pattern"), ("medium", "secret-pattern"),
])
def test_sensitive_findings_never_suggest_allowance_hashes(project, severity, check):
    repo, _, _, _ = project
    configure(project)
    write(repo, ".releasescan-allow", "")
    commit(repo)
    json_scanner(project, [scan_finding(severity=severity, check=check)])
    result = drs(repo, "export", ok=False)
    assert result.returncode == 1 and not ref(repo)
    assert f"{severity} {check} app.txt:1" in result.stderr
    assert "remove the value; do not allow it" in result.stderr
    assert hashlib.sha256(b"hello").hexdigest() not in result.stdout + result.stderr
    assert "DO NOT PRINT DETAILS" not in result.stdout + result.stderr


def test_human_computed_secret_pattern_allowance_still_matches(project):
    repo, _, _, _ = project
    configure(project)
    write(repo, ".releasescan-allow", allow_line(check="secret-pattern"))
    commit(repo)
    json_scanner(project, [scan_finding(severity="high", check="secret-pattern")])
    result = drs(repo, "export")
    assert "unmatched" not in result.stderr and ref(repo)


@pytest.mark.parametrize("line", [1, None, 999])
def test_low_findings_never_block_with_allow_file(project, line):
    repo, _, _, _ = project
    configure(project)
    write(repo, ".releasescan-allow", "")
    commit(repo)
    json_scanner(project, [scan_finding(severity="low", line=line)])
    drs(repo, "export")
    assert tree(repo) == {"app.txt"}


@pytest.mark.parametrize("committed_allow", [False, True])
def test_scan_allowances_come_from_selected_commit_not_worktree(project, committed_allow):
    repo, _, _, _ = project
    configure(project)
    write(repo, ".releasescan-allow", allow_line() if committed_allow else "")
    selected = commit(repo)
    write(repo, ".releasescan-allow", "" if committed_allow else allow_line())
    commit(repo)
    write(repo, ".releasescan-allow", "invalid worktree entry\n" if committed_allow else allow_line())
    json_scanner(project, [scan_finding()])
    result = drs(repo, "export", "--commit", selected, ok=committed_allow)
    assert bool(ref(repo)) == committed_allow
    assert result.returncode == (0 if committed_allow else 1)
    assert "malformed" not in result.stderr


@pytest.mark.parametrize("entry", [
    "check path\n", "check path wrong-hash\n", "check path " + "a" * 63 + "\n",
    "check path " + "g" * 64 + "\n", "check ../outside -\n", "check /absolute -\n",
    "check path - trailing-comment\n",
])
def test_malformed_allow_entry_aborts_before_scanner(project, entry):
    repo, _, _, receipt = project
    configure(project)
    write(repo, ".releasescan-allow", entry)
    commit(repo)
    result = drs(repo, "export", ok=False)
    assert result.returncode == 1 and "malformed .releasescan-allow entry at line 1" in result.stderr
    assert not ref(repo) and not receipt.exists()


@pytest.mark.parametrize("kind", ["symlink", "directory"])
def test_allow_file_must_be_regular(project, kind):
    repo, _, _, receipt = project
    configure(project)
    if kind == "symlink":
        os.symlink("app.txt", repo / ".releasescan-allow")
    else:
        write(repo, ".releasescan-allow/entry", allow_line())
    commit(repo)
    result = drs(repo, "export", ok=False)
    assert result.returncode == 1 and ".releasescan-allow must be a regular file" in result.stderr
    assert not ref(repo) and not receipt.exists()


def test_unmatched_allow_entry_warns_without_blocking(project):
    repo, _, _, _ = project
    configure(project)
    entries = allow_line() + allow_line(None, check="missing", path="absent.txt")
    write(repo, ".releasescan-allow", entries)
    commit(repo)
    json_scanner(project, [])
    result = drs(repo, "export")
    for entry in entries.splitlines():
        assert f"warning: unmatched .releasescan-allow entry: {entry}" in result.stderr
    assert ref(repo)


@pytest.mark.parametrize("output", [
    "NOT JSON PRIVATE TEXT", "{}", "null", '["PRIVATE TEXT"]',
    json.dumps([{key: value for key, value in scan_finding().items() if key != "detail"}]),
    *[json.dumps([{**scan_finding(), key: value}]) for key, value in [
        ("severity", "unknown"), ("severity", []), ("check", None), ("path", "../outside"),
        ("line", "1"), ("line", True), ("line", 0), ("line", -1), ("detail", None),
    ]],
])
def test_bad_scanner_json_aborts_without_printing_it(project, output):
    repo, _, _, _ = project
    configure(project)
    write(repo, ".releasescan-allow", "")
    commit(repo)
    json_scanner(project, [], output=output)
    result = drs(repo, "export", ok=False)
    assert result.returncode == 1 and "invalid scanner JSON" in result.stderr
    assert "PRIVATE TEXT" not in result.stdout + result.stderr
    assert not ref(repo)


def test_nonzero_json_scanner_exit_still_aborts(project):
    repo, _, _, _ = project
    configure(project)
    write(repo, ".releasescan-allow", "")
    commit(repo)
    json_scanner(project, [], exit_code=23)
    result = drs(repo, "export", ok=False)
    assert result.returncode == 1 and "scanner exited 23" in result.stderr
    assert not ref(repo)


@pytest.mark.parametrize("with_allow,failure", [
    (False, "nonzero"), (True, "nonzero"), (False, "crash"), (True, "crash"), (True, "bad-json"),
])
def test_scanner_failures_show_stderr_before_aborting(project, with_allow, failure):
    repo, _, scanner, _ = project
    configure(project)
    if with_allow:
        write(repo, ".releasescan-allow", "")
    commit(repo)
    ending = {
        "nonzero": "raise SystemExit(23)",
        "crash": "raise RuntimeError('scanner crashed')",
        "bad-json": "print('NOT JSON PRIVATE TEXT')",
    }[failure]
    scanner.write_text("import sys\nprint('scanner diagnostic', file=sys.stderr)\n" + ending + "\n")
    result = drs(repo, "export", ok=False)
    assert result.returncode == 1 and not ref(repo)
    assert "scanner diagnostic" in result.stderr
    assert result.stderr.index("scanner diagnostic") < result.stderr.index("dev-release-split:")
    if failure == "crash":
        assert "RuntimeError: scanner crashed" in result.stderr
    assert "NOT JSON PRIVATE TEXT" not in result.stdout + result.stderr


def test_untracked_allow_file_does_not_change_legacy_scanner_mode(project):
    repo, _, scanner, receipt = project
    configure(project)
    # The original fixture scanner accepts only --root, and records invocation.
    write(repo, ".releasescan-allow", allow_line())
    scanner.write_text(scanner.read_text() + "raise SystemExit(23)\n")
    result = drs(repo, "export", ok=False)
    assert result.returncode == 1 and "scanner exited 23" in result.stderr
    assert receipt.exists() and not ref(repo)


@pytest.mark.parametrize("allowed", [False, True])
def test_no_line_findings_use_dash(project, allowed):
    repo, _, _, _ = project
    configure(project)
    entry = allow_line(None, path="missing.txt")
    write(repo, ".releasescan-allow", entry if allowed else "")
    commit(repo)
    json_scanner(project, [scan_finding(line=None, path="missing.txt")])
    result = drs(repo, "export", ok=allowed)
    if not allowed:
        assert "medium fixture-path missing.txt:-" in result.stderr
        assert entry.strip() in result.stderr
    assert bool(ref(repo)) == allowed


@pytest.mark.parametrize("ending", [b"\n", b"\r\n", b"\r", b""])
def test_line_hash_preserves_unicode_and_whitespace_and_supports_spaces_in_paths(project, ending):
    repo, _, _, _ = project
    configure(project)
    text = "  한글 café\t "
    path = "file with spaces.txt"
    write(repo, path).write_bytes(b"first\n" + text.encode("utf-8") + ending)
    write(repo, ".releasescan-allow", allow_line(text, path=path))
    commit(repo)
    json_scanner(project, [scan_finding(path=path, line=2)])
    result = drs(repo, "export")
    assert "unmatched" not in result.stderr and ref(repo)


@pytest.mark.parametrize("line", [1, 2, None])
def test_dash_allowance_never_matches_an_existing_file(project, line):
    repo, _, _, _ = project
    configure(project)
    write(repo, ".releasescan-allow", allow_line(None))
    commit(repo)
    json_scanner(project, [scan_finding(line=line)])
    result = drs(repo, "export", ok=False)
    assert result.returncode == 1 and not ref(repo)
    if line == 1:
        assert "medium fixture-path app.txt:1" in result.stderr
        assert allow_line().strip() in result.stderr
    elif line == 2:
        assert "cannot hash scanner finding" in result.stderr
    else:
        assert "medium fixture-path app.txt:-" in result.stderr
        assert allow_line("hello\n").strip() in result.stderr


@pytest.mark.parametrize("check,severity", [
    ("large-text-file-skipped", "medium"), ("tracked-protected-path", "high"),
])
def test_no_line_file_allowance_hashes_all_bytes_and_expires(project, check, severity):
    repo, _, _, _ = project
    configure(project)
    original = b"\xff\x00first\r\nsecond\n"
    write(repo, "app.txt").write_bytes(original)
    digest = hashlib.sha256(original).hexdigest()
    write(repo, ".releasescan-allow", f"{check} app.txt {digest}\n")
    commit(repo)
    json_scanner(project, [scan_finding(severity=severity, check=check, line=None)])
    result = drs(repo, "export")
    assert "unmatched" not in result.stderr
    previous = ref(repo)
    assert previous

    changed = original + b"new content\n"
    (repo / "app.txt").write_bytes(changed)
    commit(repo)
    before = git(repo, "count-objects", "-v").stdout
    result = drs(repo, "export", ok=False)
    assert result.returncode == 1 and ref(repo) == previous
    assert git(repo, "count-objects", "-v").stdout == before
    assert f"{severity} {check} app.txt:-" in result.stderr
    changed_digest = hashlib.sha256(changed).hexdigest()
    if severity == "medium":
        assert f"{check} app.txt {changed_digest}" in result.stderr
    else:
        assert changed_digest not in result.stderr
        assert "remove the value; do not allow it" in result.stderr


@pytest.mark.parametrize("with_allow", [False, True])
def test_bundled_scanner_is_default_without_config(project, tmp_path, with_allow):
    repo, _, scanner, receipt = project
    configure(project)
    git(repo, "config", "--unset", "dev-release.scanner")
    scanner.unlink()
    installed = tmp_path / "installed-skill"
    shutil.copytree(SKILL, installed)
    (installed / "scripts" / "leak_scan.py").write_text(
        "import runpy, sys\nprint('bundled scanner invoked', file=sys.stderr)\n"
        f"runpy.run_path({str(SCANNER)!r}, run_name='__main__')\n"
    )
    command = [sys.executable, installed / "scripts" / "drs.py", "export", "--repo", repo, "--dry-run"]
    write(repo, ".gitignore", "")
    if with_allow:
        write(repo, ".releasescan-allow", "")
    commit(repo)
    result = run(command, repo)
    assert "bundled scanner invoked" in result.stderr
    assert not ref(repo) and not receipt.exists()
    token = "ghp_" + "A" * 40
    write(repo, "app.txt", token + "\n")
    commit(repo)
    result = run(command, repo, ok=False)
    assert result.returncode == 1 and not ref(repo)
    assert "bundled scanner invoked" in result.stderr
    assert "secret-pattern app.txt:1" in result.stdout + result.stderr
    assert token not in result.stdout + result.stderr


@pytest.mark.parametrize("path", ["tést.txt", "한글.txt", 'quoted"file.txt', "two\nlines.txt"])
def test_bundled_scanner_reads_unquoted_nul_delimited_paths(project, path):
    repo, _, _, _ = project
    write(repo, ".gitignore", "")
    token = "ghp_" + "A" * 40
    write(repo, path, token + "\n")
    commit(repo)
    git(repo, "config", "core.quotepath", "true")
    result = run([sys.executable, SCANNER, "--root", repo, "--json"], repo, ok=False)
    assert result.returncode == 1
    findings = json.loads(result.stdout)
    assert any(item["check"] == "secret-pattern" and item["path"] == path and item["line"] == 1
               for item in findings)
    assert token not in result.stdout + result.stderr


@pytest.mark.parametrize("path", ["tést-token.json", "two\nlines-token.json"])
def test_bundled_scanner_preserves_untracked_paths_and_ignores_ignored_files(project, path):
    repo, _, _, _ = project
    write(repo, ".gitignore", "ignored-token.json\n")
    commit(repo)
    write(repo, path, "{}\n")
    write(repo, "ignored-token.json", "{}\n")
    result = run([sys.executable, SCANNER, "--root", repo, "--json", "--no-fail"], repo)
    findings = json.loads(result.stdout)
    assert any(item["check"] == "untracked-sensitive-path" and item["path"] == path
               for item in findings)
    assert not any(item["path"] == "ignored-token.json" for item in findings)


def test_bundled_scanner_honors_max_bytes(project):
    repo, _, _, _ = project
    write(repo, ".gitignore", "")
    commit(repo)
    result = run([sys.executable, SCANNER, "--root", repo, "--json", "--no-fail", "--max-bytes", "1"], repo)
    assert any(item["check"] == "large-text-file-skipped" and item["path"] == "app.txt"
               and item["line"] is None for item in json.loads(result.stdout))


def test_bundled_scanner_has_no_high_or_medium_findings_on_entire_skill(project):
    repo, _, _, _ = project
    configure(project)
    git(repo, "config", "--unset", "dev-release.scanner")
    write(repo, ".gitignore", "")
    shutil.copytree(SKILL, repo / "shared-skills" / "dev-release-split")
    commit(repo)
    result = run([sys.executable, SCANNER, "--root", repo, "--json"], repo)
    assert not [item for item in json.loads(result.stdout) if item["severity"] in {"high", "medium"}]
    before = git(repo, "status", "--porcelain").stdout
    result = drs(repo, "export", "--dry-run")
    assert "Dry run complete" in result.stdout and not ref(repo)
    assert git(repo, "status", "--porcelain").stdout == before


@pytest.mark.parametrize("line", [1, None])
def test_finding_hash_cannot_read_through_symlink_outside_snapshot(project, tmp_path, line):
    repo, _, _, _ = project
    configure(project)
    outside = tmp_path / "outside.txt"
    outside.write_text("OUTSIDE PRIVATE CONTENT\n")
    os.symlink(outside, repo / "outside-link")
    write(repo, ".releasescan-allow", allow_line("OUTSIDE PRIVATE CONTENT", path="outside-link"))
    commit(repo)
    json_scanner(project, [scan_finding(path="outside-link", line=line)])
    result = drs(repo, "export", ok=False)
    assert result.returncode == 1 and "cannot hash scanner finding" in result.stderr
    assert "OUTSIDE PRIVATE CONTENT" not in result.stdout + result.stderr
    assert not ref(repo)


def test_missing_scanner_requires_explicit_skip(project):
    repo, _, scanner, _ = project
    configure(project)
    scanner.unlink()
    result = drs(repo, "export", ok=False)
    assert result.returncode == 1 and "install it or pass --no-scan" in result.stderr
    assert not ref(repo)
    drs(repo, "export", "--no-scan")
    assert ref(repo)


@pytest.mark.parametrize("configured", [False, True])
def test_failed_build_creates_no_snapshot(project, configured):
    repo, _, _, receipt = project
    configure(project)
    if configured:
        git(repo, "config", "dev-release.check", "false")
    result = drs(repo, "export", *([] if configured else ["--check", "false"]), ok=False)
    assert result.returncode == 1 and "build check exited" in result.stderr
    assert receipt.exists() and not ref(repo)


def test_cli_check_overrides_config_and_dry_run_runs_checks(project, tmp_path):
    repo, _, _, receipt = project
    configure(project)
    git(repo, "config", "dev-release.check", "false")
    marker = tmp_path / "build-marker"
    check = f"git ls-files > {shlex.quote(str(marker))}"
    result = drs(repo, "export", "--dry-run", "--check", check)
    assert "no commit or ref changed" in result.stdout
    assert not ref(repo)
    assert marker.read_text().splitlines() == ["app.txt"]
    assert json.loads(receipt.read_text())["files"] == ["app.txt"]


def test_build_outputs_cannot_enter_snapshot(project):
    repo, _, _, _ = project
    configure(project)
    drs(repo, "export", "--check", "printf changed > app.txt; printf artifact > built.txt")
    assert tree(repo) == {"app.txt"}
    assert git(repo, "show", f"{BRANCH}:app.txt").stdout == "hello\n"


def test_preview_mentions_and_filename_warnings(project):
    repo, _, _, _ = project
    configure(project)
    names = {"PLAN.md", "report.txt", "notes.txt", "TODO", "handoff.txt", "memo.txt"}
    for name in names:
        write(repo, name)
    terms = ("Claude Code", "CLAUDE.md", "AGENTS.md", "Codex", "codex-run", "TASKS.md")
    for index, term in enumerate(terms):
        write(repo, f"text{index}.txt", term)
    (repo / "binary.dat").write_bytes(b"\0Codex")
    os.symlink("/definitely-missing/AGENTS.md", repo / "broken-link")
    commit(repo)
    result = drs(repo, "export")
    for name in names:
        assert f"{name!r}: name" in result.stdout
    for index, term in enumerate(terms):
        assert f"'text{index}.txt': {term}" in result.stdout
    assert "'binary.dat':" not in result.stdout
    assert names <= tree(repo)


@pytest.mark.parametrize("hooks_setting", [None, ".custom-hooks", "absolute"])
def test_setup_idempotent_preserves_and_chains_existing_hook(project, tmp_path, hooks_setting):
    repo, bare, _, _ = project
    git(repo, "remote", "add", "origin", "local-nonrelease-url")
    if hooks_setting:
        hooks_path = str(tmp_path / "shared-hooks") if hooks_setting == "absolute" else hooks_setting
        git(repo, "config", "core.hooksPath", hooks_path)
    marker = tmp_path / "previous-marker"
    original = install_previous(repo, marker)
    write(repo, ".releaseignore", "/custom-private.txt\n")
    assert "clones need setup again" in configure(project).stdout
    hook = installed_hook(repo)
    first_hook = hook.read_bytes()
    configure(project)
    assert hook.read_bytes() == first_hook and os.access(hook, os.X_OK)
    assert hook.with_name("pre-push.dev-release-prev").read_bytes() == original
    assert (repo / ".releaseignore").read_text() == "/custom-private.txt\n"
    assert git(repo, "remote", "get-url", "release").stdout.strip() == str(bare)
    for key, value in (("remote", "release"), ("branch", "release-snapshot"), ("target", "main")):
        assert git(repo, "config", f"dev-release.{key}").stdout.strip() == value
    line = f"refs/heads/main {'a' * 40} refs/heads/main {ZERO}\n"
    hook_run(repo, "origin", "local-nonrelease-url", line, ok=True)
    assert json.loads(marker.read_text()) == {"args": ["origin", "local-nonrelease-url"], "stdin": line}
    assert not git(bare, "show-ref", ok=False).stdout


def test_setup_creates_defaults_and_status_reports_snapshot(project):
    repo, _, _, _ = project
    before = drs(repo, "status").stdout
    assert "Hook installed: no" in before and ".releaseignore exists: no" in before
    configure(project)
    assert (repo / ".releaseignore").read_bytes() == (SKILL / "defaults.releaseignore").read_bytes()
    drs(repo, "export")
    after = drs(repo, "status").stdout
    assert "Hook installed: yes" in after and ".releaseignore exists: yes" in after
    assert "dev-release.branch: release-snapshot" in after
    assert f"Snapshot branch tip: {ref(repo)}" in after


def test_remote_name_url_conflict_does_not_modify_setup(project):
    repo, bare, _, _ = project
    git(repo, "remote", "add", "release", "different-url")
    config_before = (repo / ".git/config").read_bytes()
    result = drs(repo, "setup", str(bare), ok=False)
    assert result.returncode == 1 and "different URL" in result.stderr
    assert (repo / ".git/config").read_bytes() == config_before
    assert not (repo / ".releaseignore").exists()
    assert not installed_hook(repo).exists()


def test_setup_never_overwrites_previous_hook(project, tmp_path):
    repo, bare, _, _ = project
    install_previous(repo, tmp_path / "marker")
    hook = installed_hook(repo)
    previous = hook.with_name("pre-push.dev-release-prev")
    previous.write_text("older hook\n")
    original = hook.read_bytes()
    result = drs(repo, "setup", str(bare), ok=False)
    assert result.returncode == 1 and "refusing to overwrite" in result.stderr
    assert hook.read_bytes() == original and previous.read_text() == "older hook\n"
    assert git(repo, "remote").stdout == ""


@pytest.mark.parametrize("remote_name", ["release", "alias"])
def test_release_hook_no_controlling_tty_is_rejected(project, remote_name, tmp_path):
    repo, bare, _, _ = project
    marker = tmp_path / "previous-marker"
    install_previous(repo, marker)
    configure(project)
    line = f"{BRANCH} {'a' * 40} refs/heads/main {ZERO}\n"
    result = hook_run(repo, remote_name, str(bare), line)
    assert result.returncode == 1 and "run this push yourself in your own terminal" in result.stderr
    assert not marker.exists()


@pytest.mark.parametrize("local_ref", ["refs/heads/main", "refs/tags/v1", "(delete)", "refs/remotes/origin/main"])
def test_other_release_refs_rejected_before_tty(project, local_ref):
    repo, bare, _, _ = project
    configure(project)
    line = f"{local_ref} {'a' * 40} refs/heads/main {ZERO}\n"
    result = hook_run(repo, "release", str(bare), line)
    assert result.returncode == 1 and "only refs/heads/release-snapshot" in result.stderr
    assert "own terminal" not in result.stderr


def test_mixed_release_push_rejected_before_tty(project):
    repo, bare, _, _ = project
    configure(project)
    lines = f"{BRANCH} {'a' * 40} refs/heads/main {ZERO}\nrefs/heads/dev {'b' * 40} refs/heads/dev {ZERO}\n"
    result = hook_run(repo, "release", str(bare), lines)
    assert result.returncode == 1 and "other branches are forbidden" in result.stderr
    assert "own terminal" not in result.stderr


def test_push_url_alias_is_also_release(project):
    repo, _, _, _ = project
    configure(project)
    git(repo, "remote", "set-url", "--push", "release", "push-only-local-url")
    line = f"{BRANCH} {'a' * 40} refs/heads/main {ZERO}\n"
    result = hook_run(repo, "alias", "push-only-local-url", line)
    assert result.returncode == 1 and "own terminal" in result.stderr


@pytest.mark.parametrize("exit_code", [0, 17])
def test_nonrelease_hook_propagates_original_exit(project, tmp_path, exit_code):
    repo, _, _, _ = project
    git(repo, "remote", "add", "origin", "other-url")
    marker = tmp_path / "previous-marker"
    install_previous(repo, marker, exit_code)
    configure(project)
    line = f"refs/heads/dev {'a' * 40} refs/heads/dev {ZERO}\n"
    result = hook_run(repo, "origin", "other-url", line)
    assert result.returncode == exit_code
    assert json.loads(marker.read_text())["stdin"] == line


def test_nonrelease_without_original_hook_passes(project):
    repo, _, _, _ = project
    git(repo, "remote", "add", "origin", "other-url")
    configure(project)
    assert hook_run(repo, "origin", "other-url", "", ok=True).returncode == 0


@pytest.mark.parametrize("answer,accepted", [
    ("y", True), ("yes", True), ("YES", True), (" Y \n", True),
    ("", False), ("n", False), ("yess", False),
])
def test_confirm(answer, accepted):
    spec = importlib.util.spec_from_file_location("release_hook", HOOK)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    out = io.StringIO()
    assert module.confirm(io.StringIO(answer), out) is accepted
    assert "[y/N]" in out.getvalue()


def test_end_to_end_push_without_tty_keeps_bare_remote_empty(project):
    repo, bare, _, _ = project
    configure(project)
    drs(repo, "export")
    result = git(repo, "push", "release", "release-snapshot:main", ok=False, detached=True, data="yes\n")
    assert result.returncode != 0 and "run this push yourself in your own terminal" in result.stderr
    assert git(bare, "show-ref", ok=False).stdout == ""
    assert not (bare / "refs/heads/main").exists()


@pytest.mark.parametrize("message_kind", ["sha", "trailer"])
def test_release_messages_reject_dev_sha_and_trailers(project, message_kind):
    repo, _, _, _ = project
    configure(project)
    dev_sha = ref(repo, "HEAD")
    message = f"Release {dev_sha}" if message_kind == "sha" else "Release\n\nCo-authored-by: Example <example@example.org>\n"
    result = drs(repo, "export", "--message", message, ok=False)
    assert result.returncode == 1 and not ref(repo)
    assert "messages must not contain" in result.stderr


def test_checked_out_snapshot_branch_is_not_modified(project):
    repo, _, _, _ = project
    configure(project)
    drs(repo, "export")
    git(repo, "switch", "release-snapshot")
    before = ref(repo)
    result = drs(repo, "export", ok=False)
    assert result.returncode == 1 and "checked out" in result.stderr
    assert ref(repo) == before


def test_submodule_fails_explicitly_without_network(project):
    repo, _, _, _ = project
    configure(project)
    sha = ref(repo, "HEAD")
    git(repo, "update-index", "--add", "--cacheinfo", f"160000,{sha},vendor/lib")
    git(repo, "commit", "-m", "Gitlink without fetching")
    result = drs(repo, "export", ok=False)
    assert result.returncode == 1 and "submodules are not exported" in result.stderr
    assert not ref(repo)


def test_unusual_filenames_and_attributes_preserve_exact_blobs(project):
    repo, _, _, _ = project
    configure(project)
    names = {"space name.txt", "tab\tname.txt", "line\nname.txt", "한국어.txt", "-option.txt"}
    for name in names:
        write(repo, name, "exact content\n")
    write(repo, ".gitattributes", "*.txt text eol=crlf\n")
    commit(repo)
    # This hostile clean filter must not run during export or scanner staging.
    git(repo, "config", "filter.hostile.clean", "false")
    write(repo, ".gitattributes", "*.txt filter=hostile\n")
    git(repo, "add", ".gitattributes")
    git(repo, "commit", "-m", "Attribute rules")
    drs(repo, "export")
    assert tree(repo) == names | {"app.txt", ".gitattributes"}
    for name in names:
        assert git(repo, "rev-parse", f"{BRANCH}:{name}").stdout == git(repo, "rev-parse", f"HEAD:{name}").stdout


def load_script(path):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("injection", ["flag", "environment"])
@pytest.mark.parametrize("key,value", [("remote", ""), ("remote", "x"), ("branch", "main")])
def test_push_config_overrides_cannot_disable_guard(project, monkeypatch, injection, key, value):
    repo, bare, _, _ = project
    configure(project)
    options = []
    if injection == "flag":
        options = ["-c", f"dev-release.{key}={value}"]
    else:
        monkeypatch.setenv("GIT_CONFIG_COUNT", "1")
        monkeypatch.setenv("GIT_CONFIG_KEY_0", f"dev-release.{key}")
        monkeypatch.setenv("GIT_CONFIG_VALUE_0", value)
    result = git(repo, *options, "push", "release", "main:main", ok=False, detached=True)
    assert result.returncode != 0 and "only refs/heads/release-snapshot" in result.stderr
    assert git(bare, "show-ref", ok=False).stdout == ""


@pytest.mark.parametrize("key", ["remote", "branch"])
@pytest.mark.parametrize("missing", [True, False])
@pytest.mark.parametrize("destination", ["release", "unrelated"])
def test_missing_local_guard_config_rejects_every_push(project, monkeypatch, tmp_path, key, missing, destination):
    repo, bare, _, _ = project
    configure(project)
    if destination == "unrelated":
        bare = tmp_path / "unrelated.git"
        git(tmp_path, "init", "--bare", "--template=", bare)
    if missing:
        git(repo, "config", "--unset", f"dev-release.{key}")
    else:
        git(repo, "config", f"dev-release.{key}", "")
    fallback = tmp_path / "fallback-config"
    fallback.write_text("[dev-release]\nremote = other\nbranch = main\n")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(fallback))
    result = git(repo, "push", str(bare), "main:main", ok=False, detached=True)
    assert result.returncode != 0 and "run setup" in result.stderr
    assert git(bare, "show-ref", ok=False).stdout == ""


def test_hook_git_calls_scrub_config_and_disable_replacements(monkeypatch):
    hook = load_script(HOOK)
    names = ["GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0",
             "GIT_CONFIG_VALUE_0", "GIT_CONFIG_KEY_87", "GIT_CONFIG_VALUE_87",
             "GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"]
    for name in names:
        monkeypatch.setenv(name, "hostile")
    monkeypatch.setenv("GIT_NO_REPLACE_OBJECTS", "0")
    captured = []

    def capture(args, **kwargs):
        captured.append(kwargs["env"])
        return subprocess.CompletedProcess(args, 0, "value\n", "")

    monkeypatch.setattr(hook.subprocess, "run", capture)
    assert hook.git_output("config", "--local", "--get", "dev-release.remote") == "value"
    assert all(name not in captured[0] for name in names)
    assert captured[0]["GIT_NO_REPLACE_OBJECTS"] == "1"


@pytest.mark.parametrize("alias", ["file", "dot", "trailing", "second-remote", "pushurl", "no-suffix", "file-no-suffix"])
def test_destination_alias_all_push_is_rejected(project, alias):
    repo, bare, _, _ = project
    configure(project)
    write(repo, "AGENTS.md", "Private dev instructions\n")
    commit(repo)
    drs(repo, "export")
    destinations = {
        "file": bare.as_uri(), "dot": f"{bare}/./", "trailing": f"{bare}/",
        "no-suffix": str(bare.with_suffix("")), "file-no-suffix": bare.with_suffix("").as_uri(),
    }
    destination = destinations.get(alias, bare.as_uri())
    if alias == "second-remote":
        git(repo, "remote", "add", "alias", destination)
        destination = "alias"
    elif alias == "pushurl":
        git(repo, "remote", "set-url", "release", str(bare.parent / "different.git"))
        git(repo, "config", "--add", "remote.release.pushurl", str(bare.parent / "another.git"))
        git(repo, "config", "--add", "remote.release.pushurl", str(bare))
    result = git(repo, "push", destination, "--all", ok=False, detached=True)
    assert result.returncode != 0 and "other branches are forbidden" in result.stderr
    assert git(bare, "show-ref", ok=False).stdout == ""


def test_remote_url_override_cannot_hide_destination(project):
    repo, bare, _, _ = project
    configure(project)
    result = git(repo, "-c", "remote.release.url=elsewhere", "-c", "remote.release.pushurl=elsewhere",
                 "push", bare.as_uri(), "--all", ok=False, detached=True)
    assert result.returncode != 0 and "other branches are forbidden" in result.stderr
    assert git(bare, "show-ref", ok=False).stdout == ""


@pytest.mark.parametrize("suffix", [".git", "", ".git "])
def test_allowlisted_dev_push_without_tty(project, tmp_path, suffix):
    repo, release, _, _ = project
    dev = tmp_path / f"origin{suffix}"
    git(tmp_path, "init", "--quiet", "--bare", "--template=", dev)
    git(repo, "remote", "add", "origin", dev)
    configure(project)
    git(repo, "push", "origin", "main", detached=True)
    assert ref(dev, "refs/heads/main") == ref(repo, "HEAD")
    assert git(release, "show-ref", ok=False).stdout == ""


@pytest.mark.parametrize("override", ["receivepack", "ssh-command"])
def test_transient_transport_override_is_not_a_dev_push(project, tmp_path, override):
    repo, release, _, _ = project
    dev = tmp_path / "origin.git"
    git(tmp_path, "init", "--quiet", "--bare", "--template=", dev)
    git(repo, "remote", "add", "origin", dev)
    configure(project)
    if override == "receivepack":
        args = ["-c", f"remote.origin.receivepack=git-receive-pack {shlex.quote(str(release))} #", "push", "origin", "main"]
    else:
        args = ["-c", "core.sshCommand=ssh", "push", "origin", "main"]
    result = git(repo, *args, ok=False, detached=True)
    assert result.returncode != 0 and "other branches are forbidden" in result.stderr
    assert git(release, "show-ref", ok=False).stdout == ""
    assert git(dev, "show-ref", ok=False).stdout == ""


def test_setup_dev_remote_allowlist_is_idempotent(project, tmp_path):
    repo, release, _, _ = project
    git(repo, "remote", "add", "origin", tmp_path / "origin.git")
    git(repo, "remote", "add", "upstream", tmp_path / "upstream.git")
    configure(project)
    key = "dev-release.devremote"
    assert set(git(repo, "config", "--local", "--get-all", key).stdout.splitlines()) == {"origin", "upstream"}
    extra = tmp_path / "extra.git"
    git(tmp_path, "init", "--quiet", "--bare", "--template=", extra)
    git(repo, "remote", "add", "extra", extra)
    for _ in range(2):
        configure(project, "--dev-remote", "extra", "--dev-remote", "origin", "--dev-remote", "extra")
    values = git(repo, "config", "--local", "--get-all", key).stdout.splitlines()
    assert set(values) == {"origin", "upstream", "extra"}
    assert len(values) == len(set(values))
    git(repo, "push", "extra", "main", detached=True)
    assert ref(extra, "refs/heads/main") == ref(repo, "HEAD")
    assert git(release, "show-ref", ok=False).stdout == ""


def test_repeatable_dev_remote_options_allow_future_named_remotes(project, tmp_path):
    repo, _, _, _ = project
    configure(project, "--dev-remote", "first", "--dev-remote", "second", "--dev-remote", "first")
    configure(project)
    assert git(repo, "config", "--local", "--get-all", "dev-release.devremote").stdout.splitlines() == ["first", "second"]
    for name in ("first", "second"):
        dev = tmp_path / f"{name}.git"
        git(tmp_path, "init", "--quiet", "--bare", "--template=", dev)
        git(repo, "remote", "add", name, dev)
        git(repo, "push", name, "main", detached=True)
        assert ref(dev, "refs/heads/main") == ref(repo, "HEAD")


def test_setup_refuses_release_remote_in_dev_allowlist(project):
    repo, bare, _, _ = project
    before = (repo / ".git/config").read_bytes()
    result = drs(repo, "setup", bare, "--dev-remote", "release", ok=False)
    assert result.returncode == 1 and "release remote cannot be a dev remote" in result.stderr
    assert (repo / ".git/config").read_bytes() == before
    assert not installed_hook(repo).exists()


@pytest.mark.parametrize("destination", ["raw-url", "removed-name"])
def test_allowlist_requires_a_current_remote_name(project, tmp_path, destination):
    repo, _, _, _ = project
    dev = repo / "stale.git"
    git(tmp_path, "init", "--quiet", "--bare", "--template=", dev)
    git(repo, "remote", "add", "stale.git", dev)
    configure(project)
    if destination == "removed-name":
        git(repo, "remote", "remove", "stale.git")
        target = "stale.git"
    else:
        target = str(dev)
        git(repo, "config", "--local", "--add", "dev-release.devremote", target)
    result = git(repo, "push", target, "main", ok=False, detached=True)
    assert result.returncode != 0 and "only refs/heads/release-snapshot" in result.stderr
    assert git(dev, "show-ref", ok=False).stdout == ""


def test_all_persistent_dev_pushurls_are_allowed(project, tmp_path):
    repo, release, _, _ = project
    git(repo, "remote", "add", "origin", "unused-fetch-url")
    destinations = [tmp_path / f"dev-{n}.git" for n in range(2)]
    for dev in destinations:
        git(tmp_path, "init", "--quiet", "--bare", "--template=", dev)
        git(repo, "config", "--local", "--add", "remote.origin.pushurl", dev)
    configure(project)
    git(repo, "push", "origin", "main", detached=True)
    for dev in destinations:
        assert ref(dev, "refs/heads/main") == ref(repo, "HEAD")
    assert git(release, "show-ref", ok=False).stdout == ""


def test_partial_pushinsteadof_rewrites_allow_each_computed_dev_url(project, tmp_path):
    repo, release, _, _ = project
    destinations = [tmp_path / f"dev-{n}.git" for n in range(2)]
    for dev in destinations:
        git(tmp_path, "init", "--quiet", "--bare", "--template=", dev)
    git(repo, "remote", "add", "origin", "develop:dev-0.git")
    git(repo, "config", "--add", "remote.origin.url", "unused-fetch-url")
    git(repo, "config", "--add", "remote.origin.url", "develop:dev-1.git")
    git(repo, "config", f"url.{tmp_path}/.pushInsteadOf", "develop:")
    configure(project)
    git(repo, "push", "origin", "main", detached=True)
    for dev in destinations:
        assert ref(dev, "refs/heads/main") == ref(repo, "HEAD")
    assert git(release, "show-ref", ok=False).stdout == ""


@pytest.mark.parametrize("separator", ["\n", "\r", "\v", "\u0085"])
def test_url_line_separators_cannot_authorize_partial_destination(project, tmp_path, separator):
    repo, release, _, _ = project
    dev = tmp_path / f"origin{separator}{release}"
    git(tmp_path, "init", "--quiet", "--bare", "--template=", dev)
    git(repo, "remote", "add", "origin", dev)
    configure(project)
    write(repo, "AGENTS.md", "Private dev instructions\n")
    commit(repo)
    result = git(repo, "-c", f"remote.origin.pushurl={release}", "push", "origin", "main",
                 ok=False, detached=True)
    assert result.returncode != 0 and "only refs/heads/release-snapshot" in result.stderr
    assert git(release, "show-ref", ok=False).stdout == ""
    git(repo, "push", "origin", "main", detached=True)
    assert ref(dev, "refs/heads/main") == ref(repo, "HEAD")


def test_ambiguous_multiline_pushurl_list_fails_closed(project, tmp_path):
    repo, release, _, _ = project
    git(repo, "remote", "add", "origin", "unused-fetch-url")
    destinations = [tmp_path / f"origin\n{release}", tmp_path / "other.git"]
    for dev in destinations:
        git(tmp_path, "init", "--quiet", "--bare", "--template=", dev)
        git(repo, "config", "--local", "--add", "remote.origin.pushurl", dev)
    configure(project)
    result = git(repo, "-c", f"remote.origin.pushurl={release}", "push", "origin", "main",
                 ok=False, detached=True)
    assert result.returncode != 0 and "only refs/heads/release-snapshot" in result.stderr
    for bare in [*destinations, release]:
        assert git(bare, "show-ref", ok=False).stdout == ""


def test_dev_allowlist_values_are_not_split_on_newlines(project, tmp_path):
    repo, _, _, _ = project
    dev = tmp_path / "origin.git"
    git(tmp_path, "init", "--quiet", "--bare", "--template=", dev)
    git(repo, "remote", "add", "origin", dev)
    configure(project)
    git(repo, "config", "--local", "dev-release.devremote", "origin\nother")
    result = git(repo, "push", "origin", "main", ok=False, detached=True)
    assert result.returncode != 0 and "only refs/heads/release-snapshot" in result.stderr
    assert git(dev, "show-ref", ok=False).stdout == ""


@pytest.mark.parametrize("injection", ["flag", "environment", "global"])
def test_nonlocal_dev_allowlist_cannot_allow_release_push(project, tmp_path, monkeypatch, injection):
    repo, release, _, _ = project
    configure(project)
    git(repo, "remote", "add", "new", release)
    options = []
    if injection == "flag":
        options = ["-c", "dev-release.devremote=new"]
    elif injection == "environment":
        monkeypatch.setenv("GIT_CONFIG_COUNT", "1")
        monkeypatch.setenv("GIT_CONFIG_KEY_0", "dev-release.devremote")
        monkeypatch.setenv("GIT_CONFIG_VALUE_0", "new")
    else:
        monkeypatch.setenv("HOME", str(tmp_path))
        monkeypatch.delenv("GIT_CONFIG_GLOBAL")
        git(repo, "config", "--global", "dev-release.devremote", "new")
    result = git(repo, *options, "push", "new", "main", ok=False, detached=True)
    assert result.returncode != 0 and "only refs/heads/release-snapshot" in result.stderr
    assert git(release, "show-ref", ok=False).stdout == ""


def test_unlisted_remote_requires_snapshot_then_manual_allowlist_allows_dev(project, tmp_path):
    repo, _, _, _ = project
    configure(project)
    dev = tmp_path / "x.git"
    git(tmp_path, "init", "--quiet", "--bare", "--template=", dev)
    git(repo, "remote", "add", "new", dev)
    result = git(repo, "push", "new", "main", ok=False, detached=True)
    assert result.returncode != 0 and "only refs/heads/release-snapshot" in result.stderr
    assert git(dev, "show-ref", ok=False).stdout == ""
    git(repo, "config", "--local", "--add", "dev-release.devremote", "new")
    git(repo, "push", "new", "main", detached=True)
    assert ref(dev, "refs/heads/main") == ref(repo, "HEAD")


def test_release_insteadof_alias_cannot_allow_raw_url_push(project):
    repo, bare, _, _ = project
    git(repo, "config", f"url.{bare.parent}/.insteadOf", "publish:")
    drs(repo, "setup", "publish:release.git")
    write(repo, "AGENTS.md", "Private dev instructions\n")
    commit(repo)
    result = git(repo, "push", bare, "--all", ok=False, detached=True)
    assert result.returncode != 0 and "only refs/heads/release-snapshot" in result.stderr
    assert git(bare, "show-ref", ok=False).stdout == ""


@pytest.mark.parametrize("injection", ["flag", "environment"])
def test_dev_remote_pushurl_override_cannot_publish_dev(project, tmp_path, monkeypatch, injection):
    repo, bare, _, _ = project
    git(repo, "remote", "add", "origin", tmp_path / "origin.git")
    configure(project)
    write(repo, "AGENTS.md", "Private dev instructions\n")
    commit(repo)
    options = []
    if injection == "flag":
        options = ["-c", f"remote.origin.pushurl={bare}"]
    else:
        monkeypatch.setenv("GIT_CONFIG_COUNT", "1")
        monkeypatch.setenv("GIT_CONFIG_KEY_0", "remote.origin.pushurl")
        monkeypatch.setenv("GIT_CONFIG_VALUE_0", str(bare))
    result = git(repo, *options, "push", "origin", "--all", ok=False, detached=True)
    assert result.returncode != 0 and "only refs/heads/release-snapshot" in result.stderr
    assert git(bare, "show-ref", ok=False).stdout == ""


@pytest.mark.parametrize("scope", ["--local", "--global"])
@pytest.mark.parametrize("rewrite", ["insteadOf", "pushInsteadOf"])
def test_persistent_dev_url_rewrites_allow_normal_push(project, tmp_path, monkeypatch, scope, rewrite):
    repo, release, _, _ = project
    # A real temporary HOME keeps persistent global config visible after env scrubbing.
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    monkeypatch.delenv("GIT_CONFIG_GLOBAL")
    dev = tmp_path / "origin.git"
    git(tmp_path, "init", "--quiet", "--bare", "--template=", dev)
    git(repo, "config", scope, f"url.{tmp_path}/.{rewrite}", "develop:")
    git(repo, "remote", "add", "origin", "develop:origin.git")
    configure(project)
    git(repo, "push", "origin", "main", detached=True)
    assert ref(dev, "refs/heads/main") == ref(repo, "HEAD")
    assert git(release, "show-ref", ok=False).stdout == ""


def commit_index_entries(repo, entries):
    for mode, path, contents in entries:
        oid = git(repo, "hash-object", "-w", "--stdin", data=contents).stdout.strip()
        git(repo, "update-index", "--add", "--cacheinfo", f"{mode},{oid},{path}")
    git(repo, "commit", "-m", "Constructed tree")


@pytest.mark.parametrize("dry_run", [False, True])
@pytest.mark.parametrize("collision", ["symlink", "directory", "file", "unicode"])
def test_casefold_collisions_abort_before_materialization(project, tmp_path, collision, dry_run):
    repo, _, _, receipt = project
    configure(project)
    outside = tmp_path / "outside"
    outside.mkdir()
    write(outside, "sentinel", "untouched\n")
    cases = {
        "symlink": [("120000", "A", str(outside)), ("100644", "a/AGENTS.md", "private\n")],
        "directory": [("100644", "A/one", "one"), ("100644", "a/two", "two")],
        "file": [("100644", "Case.txt", "one"), ("100644", "case.txt", "two")],
        "unicode": [("100644", "Straße/one", "one"), ("100644", "STRASSE/two", "two")],
    }
    commit_index_entries(repo, cases[collision])
    before = git(repo, "count-objects", "-v").stdout
    result = drs(repo, "export", *(["--dry-run"] if dry_run else []), ok=False)
    assert result.returncode == 1 and ("collision" in result.stderr or "symlink ancestor" in result.stderr)
    assert sorted(p.name for p in outside.iterdir()) == ["sentinel"]
    assert (outside / "sentinel").read_text() == "untouched\n"
    assert not ref(repo) and not receipt.exists()
    assert git(repo, "count-objects", "-v").stdout == before


def test_materialize_rejects_existing_symlink_parent(project, tmp_path):
    repo, _, _, _ = project
    module = load_script(CLI)
    snapshot = tmp_path / "snapshot"
    outside = tmp_path / "outside"
    snapshot.mkdir()
    outside.mkdir()
    os.symlink(outside, snapshot / "nested")
    oid = git(repo, "rev-parse", "HEAD:app.txt").stdout.strip()
    with pytest.raises((module.ReleaseError, OSError)):
        module.materialize(repo, snapshot, [module.Entry("100644", oid, "nested/escaped")])
    assert list(outside.iterdir()) == []


@pytest.mark.parametrize("replacement", ["blob", "rules", "commit"])
def test_git_replacements_cannot_change_scanned_or_selected_bytes(project, replacement):
    repo, _, scanner, receipt = project
    configure(project)
    write(repo, ".releaseignore", "/private.txt\n")
    write(repo, "private.txt", "private\n")
    commit(repo)
    original = ref(repo, "HEAD")
    if replacement == "commit":
        empty_tree = git(repo, "mktree", data="").stdout.strip()
        substitute = git(repo, "commit-tree", empty_tree, "-m", "Fake tree").stdout.strip()
        replaced = original
    else:
        path = "app.txt" if replacement == "blob" else ".releaseignore"
        replaced = git(repo, "rev-parse", f"HEAD:{path}").stdout.strip()
        substitute = git(repo, "hash-object", "-w", "--stdin", data="substituted\n").stdout.strip()
    git(repo, "replace", replaced, substitute)
    scanner.write_text(scanner.read_text() + "\nassert (root / 'app.txt').read_bytes() == b'hello\\n'\nassert not (root / 'private.txt').exists()\n")
    drs(repo, "export")
    assert json.loads(receipt.read_text())["files"] == ["app.txt"]
    assert tree(repo) == {"app.txt"}
    assert git(repo, "--no-replace-objects", "show", f"{BRANCH}:app.txt").stdout == "hello\n"


def test_snapshot_blob_hash_mismatch_aborts_before_scan(project, monkeypatch):
    repo, _, _, receipt = project
    configure(project)
    module = load_script(CLI)
    original = module.git

    def mismatch(path, *args, **kwargs):
        output = original(path, *args, **kwargs)
        return b"0" * 40 + b"\n" if args[0] == "hash-object" else output

    monkeypatch.setattr(module, "git", mismatch)
    monkeypatch.setattr(sys, "argv", [str(CLI), "export", "--repo", str(repo)])
    assert module.main() == 1
    assert not ref(repo) and not receipt.exists()


@pytest.mark.parametrize("command", ["setup", "export"])
def test_symbolic_snapshot_ref_never_moves_dev_head(project, command):
    repo, bare, _, receipt = project
    configure(project)
    write(repo, "AGENTS.md", "excluded content makes the snapshot tree differ\n")
    commit(repo)
    git(repo, "symbolic-ref", BRANCH, "refs/heads/main")
    before = ref(repo, "HEAD")
    objects_before = git(repo, "count-objects", "-v").stdout
    config_before = (repo / ".git/config").read_bytes()
    args = ["setup", str(bare)] if command == "setup" else ["export"]
    result = drs(repo, *args, ok=False)
    assert result.returncode == 1 and "symbolic" in result.stderr
    assert ref(repo, "HEAD") == before
    assert git(repo, "symbolic-ref", BRANCH).stdout.strip() == "refs/heads/main"
    assert (repo / ".git/config").read_bytes() == config_before
    assert git(repo, "count-objects", "-v").stdout == objects_before
    assert not receipt.exists()


@pytest.mark.parametrize("seed", [BRANCH, "refs/remotes/release/main", "shared-ancestor"])
def test_parent_sharing_dev_history_is_rejected(project, seed):
    repo, _, _, receipt = project
    configure(project)
    write(repo, "AGENTS.md", "private dev content\n")
    commit(repo)
    dev = ref(repo, "HEAD")
    if seed == "shared-ancestor":
        empty_tree = git(repo, "mktree", data="").stdout.strip()
        parent = git(repo, "commit-tree", empty_tree, "-p", dev, "-m", "Looks like release").stdout.strip()
        git(repo, "update-ref", BRANCH, parent)
    else:
        git(repo, "update-ref", seed, dev)
    before = git(repo, "show-ref").stdout
    objects_before = git(repo, "count-objects", "-v").stdout
    result = drs(repo, "export", ok=False)
    assert result.returncode == 1 and "shares history" in result.stderr
    assert git(repo, "show-ref").stdout == before and not receipt.exists()
    assert git(repo, "count-objects", "-v").stdout == objects_before


@pytest.mark.parametrize("branch", ["main", "release-snapshot"])
def test_setup_refuses_dev_branch_without_modifications(project, branch):
    repo, bare, _, _ = project
    if branch != "main":
        git(repo, "branch", branch, "HEAD")
    before = (repo / ".git/config").read_bytes()
    result = drs(repo, "setup", str(bare), "--branch", branch, ok=False)
    assert result.returncode == 1
    assert "current branch" in result.stderr or "shares history" in result.stderr
    assert (repo / ".git/config").read_bytes() == before
    assert not (repo / ".releaseignore").exists() and not installed_hook(repo).exists()


def test_merge_in_snapshot_ancestry_is_rejected(project):
    repo, _, _, receipt = project
    configure(project)
    empty_tree = git(repo, "mktree", data="").stdout.strip()
    roots = [git(repo, "commit-tree", empty_tree, "-m", f"Root {n}").stdout.strip() for n in (1, 2)]
    merge = git(repo, "commit-tree", empty_tree, "-p", roots[0], "-p", roots[1], "-m", "Merge").stdout.strip()
    tip = git(repo, "commit-tree", empty_tree, "-p", merge, "-m", "Linear tip").stdout.strip()
    git(repo, "update-ref", BRANCH, tip)
    result = drs(repo, "export", ok=False)
    assert result.returncode == 1 and "merge" in result.stderr
    assert ref(repo) == tip and not receipt.exists()


@pytest.mark.parametrize("remote_known", [False, True])
def test_hook_preview_counts_outgoing_commits_and_limits_subjects(project, monkeypatch, remote_known):
    repo, _, _, _ = project
    configure(project)
    empty_tree = git(repo, "mktree", data="").stdout.strip()
    commits = []
    for n in range(12):
        parents = ["-p", commits[-1]] if commits else []
        commits.append(git(repo, "commit-tree", empty_tree, *parents, "-m", f"Snapshot {n}").stdout.strip())
    # A replacement must not hide history or replace displayed subjects.
    substitute = git(repo, "commit-tree", empty_tree, "-m", "Misleading replacement").stdout.strip()
    git(repo, "replace", commits[-1], substitute)
    hook = load_script(HOOK)
    monkeypatch.chdir(repo)
    out = io.StringIO()
    remote_sha = commits[4] if remote_known else "f" * 40
    hook.describe_updates([[BRANCH, commits[-1], "refs/heads/main", remote_sha]], out)
    value = out.getvalue()
    assert f"Commits to send: {7 if remote_known else 12}" in value
    assert "Snapshot 11" in value and "Snapshot 0" not in value
    assert value.count("Snapshot ") == (7 if remote_known else 10)
    assert "Misleading replacement" not in value


@pytest.mark.parametrize("length", [7, 8, 12, 39])
@pytest.mark.parametrize("template", ["Release ({})", "Release dev_{}"])
def test_abbreviated_dev_sha_in_message_is_rejected(project, length, template):
    repo, _, _, _ = project
    configure(project)
    token = ref(repo, "HEAD")[:length].upper()
    result = drs(repo, "export", "--message", template.format(token), ok=False)
    assert result.returncode == 1 and "dev commit SHA" in result.stderr
    assert not ref(repo)


def test_nonidentifying_hex_message_tokens_are_allowed(project):
    repo, _, _, _ = project
    configure(project)
    dev = ref(repo, "HEAD")
    unrelated = ("a" if dev[0] != "a" else "b") + dev[1:12]
    drs(repo, "export", "--message", f"Release {dev[:6]} {unrelated}")
    assert ref(repo)


def test_limits_describe_shell_bypass_and_hard_boundary():
    text = (SKILL / "SKILL.md").read_text()
    assert "configuration cannot supply or redirect confirmation" not in text
    for term in ("accident guard", "agents included", "--no-verify", "core.hooksPath",
                 ".git/config", "script/expect", "credentials", "protected branch"):
        assert term in text
