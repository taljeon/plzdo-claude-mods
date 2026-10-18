#!/usr/bin/env python3
# dev-release-split pre-push hook v1
"""Require a controlling terminal before pushing the release snapshot."""

import os
from pathlib import Path
import subprocess
import sys
from typing import TextIO


def confirm(in_stream: TextIO, out_stream: TextIO) -> bool:
    out_stream.write("[y/N] ")
    out_stream.flush()
    return in_stream.readline().strip().lower() in {"y", "yes"}


def git_env() -> dict[str, str]:
    env = os.environ.copy()
    for key in ("GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_CONFIG",
                "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"):
        env.pop(key, None)
    env = {key: value for key, value in env.items()
           if not key.startswith(("GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_"))}
    env["GIT_NO_REPLACE_OBJECTS"] = "1"
    return env


def git_output(*args: str, allow_missing: bool = False) -> str:
    result = subprocess.run(
        ["git", *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=git_env()
    )
    if result.returncode:
        if allow_missing and result.returncode == 1:
            return ""
        raise ValueError(os.fsdecode(result.stderr).strip() or f"git {args[0]} failed")
    return os.fsdecode(result.stdout).removesuffix("\n")


# Not GIT_EXEC_PATH: git sets it for every hook.
TRANSPORT_OVERRIDES = ("GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_SSH", "GIT_SSH_COMMAND",
                       "GIT_PROXY_COMMAND")


def is_dev_push(name: str, url: str, release_remote: str) -> bool:
    # A transient -c (e.g. remote.<name>.receivepack) or ssh override can send the push
    # somewhere other than the URL the hook sees, so it never counts as a dev push.
    if any(os.environ.get(key) for key in TRANSPORT_OVERRIDES):
        return False
    allowed = git_output("config", "--local", "--null", "--get-all", "dev-release.devremote", allow_missing=True).split("\0")
    if name == release_remote or name not in allowed or name not in git_output("remote").splitlines():
        return False
    # Git applies persistent URL rewrites; transient overrides must not authorize a push.
    output = git_output("remote", "get-url", "--push", "--all", "--", name)
    first = git_output("remote", "get-url", "--push", "--", name)
    if output == first:
        return url == first
    # Git emits newline-delimited URLs. Split only when their inputs are unambiguous.
    configured = git_output("config", "--null", "--get-all", f"remote.{name}.pushurl", allow_missing=True)
    if not configured:
        configured = git_output("config", "--null", "--get-all", f"remote.{name}.url", allow_missing=True)
    rules = git_output("config", "--null", "--get-regexp", r"^url\.", allow_missing=True)
    # Each NUL-delimited rule has exactly one newline between its key and value.
    if not configured or "\n" in configured or any(
        rule.count("\n") != 1 for rule in rules.split("\0") if rule
    ):
        return False
    return url in output.split("\n")


def describe_updates(updates: list[list[str]], out_stream: TextIO) -> None:
    for local_ref, sha, remote_ref, remote_sha in updates:
        revisions = [sha]
        if remote_sha.strip("0") and git_output(
            "rev-parse", "--verify", "--quiet", f"{remote_sha}^{{commit}}", allow_missing=True,
        ):
            revisions.extend(["--not", remote_sha])
        count = int(git_output("rev-list", "--count", *revisions, "--"))
        subjects = git_output("log", "--format=%s", "-n", "10", *revisions, "--")
        out_stream.write(f"{local_ref} -> {remote_ref}\nCommit: {sha}\nCommits to send: {count}\n")
        for subject in subjects.splitlines():
            out_stream.write(f"  {subject}\n")
        if count > 10:
            out_stream.write(f"  ({count - 10} more commits; showing at most 10 subjects)\n")


def chain(args: list[str], data: bytes) -> int:
    previous = Path(__file__).resolve().with_name("pre-push.dev-release-prev")
    if not os.path.lexists(previous):
        return 0
    try:
        return subprocess.run([str(previous), *args], input=data).returncode
    except OSError as exc:
        print(f"dev-release-split: cannot run previous hook: {exc}", file=sys.stderr)
        return 1


def main() -> int:
    args = sys.argv[1:]
    if len(args) != 2:
        print("dev-release-split: expected remote name and URL", file=sys.stderr)
        return 1
    data = sys.stdin.buffer.read()
    remote = git_output("config", "--local", "--get", "dev-release.remote", allow_missing=True)
    branch = git_output("config", "--local", "--get", "dev-release.branch", allow_missing=True)
    if not remote or not branch:
        print("dev-release-split: missing local release remote or branch; run setup before pushing", file=sys.stderr)
        return 1
    urls = []
    for key in ("url", "pushurl"):
        urls.extend(git_output("config", "--local", "--get-all", f"remote.{remote}.{key}", allow_missing=True).splitlines())
    if not urls or not all(urls):
        print("dev-release-split: missing local release destination; run setup before pushing", file=sys.stderr)
        return 1
    if is_dev_push(args[0], args[1], remote):
        return chain(args, data)

    updates = []
    for line in data.decode("utf-8", errors="replace").splitlines():
        fields = line.split()
        if (
            not branch
            or len(fields) != 4
            or fields[0] != f"refs/heads/{branch}"
            or not fields[1].strip("0")
        ):
            print(
                f"dev-release-split: release push rejected; only refs/heads/{branch} "
                "may be pushed. Deletions, tags and other branches are forbidden.",
                file=sys.stderr,
            )
            return 1
        updates.append(fields)

    try:
        # Separate wrappers avoid seek requirements on a read/write terminal.
        fd = os.open("/dev/tty", os.O_RDWR)
        with os.fdopen(fd, "r", encoding="utf-8") as tty_in:
            with os.fdopen(os.dup(tty_in.fileno()), "w", encoding="utf-8") as tty_out:
                tty_out.write(f"Release destination: {args[0]} ({args[1]})\n")
                describe_updates(updates, tty_out)
                tty_out.write(f"Push release snapshot to {args[0]} ({args[1]})? ")
                approved = confirm(tty_in, tty_out)
    except (OSError, UnicodeError):
        print(
            "dev-release-split: run this push yourself in your own terminal",
            file=sys.stderr,
        )
        return 1
    if not approved:
        print("dev-release-split: release push cancelled", file=sys.stderr)
        return 1
    return chain(args, data)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as exc:
        print(f"dev-release-split: push rejected: {exc}", file=sys.stderr)
        raise SystemExit(1)
