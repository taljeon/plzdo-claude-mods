---
name: dev-release-split
description: Publish a project publicly or work where agent files must not reach the shipped repo, such as at a company, by exporting filtered snapshots from a dev repo to a separate release repo. Not for private personal repos.
---

# Dev/release split

## When to use

Use a dev repository for project content, agent configuration and development
history, and a separate release repository for shipped content. Each release
adds at most one snapshot commit. Requires Git and Python 3.12; the scripts use
only Python's standard library and work on macOS and Linux.

## Setup

Run the bundled script from the dev repository, substituting its installed path:

```sh
python3 /path/to/dev-release-split/scripts/drs.py setup <release-url>
python3 /path/to/dev-release-split/scripts/drs.py status
```

Options: `--repo PATH`, `--remote release`, `--branch release-snapshot`, and
`--target main`, plus repeatable `--dev-remote NAME`. Setup adds the remote, saves `dev-release.remote`,
`dev-release.branch` and `dev-release.target`, creates `.releaseignore` only when
absent, and installs a local pre-push hook. An existing hook is preserved as
`pre-push.dev-release-prev` and chained. `core.hooksPath` is respected. Setup
does not fetch or push. Commit `.releaseignore` on the dev branch before release.

Setup records every existing remote except the release remote in the multi-valued
local allowlist `dev-release.devremote`, and adds any `--dev-remote NAME` values.
Re-running setup preserves the allowlist without duplicate values. The release
remote cannot be a dev remote. To add a dev remote later, use either:

```sh
python3 /path/to/dev-release-split/scripts/drs.py setup <release-url> --dev-remote NAME
git config --local --add dev-release.devremote NAME
```

The scanner defaults to the bundled `scripts/leak_scan.py`; no separate skill
installation is needed. To override it with another Python scanner:

```sh
git config dev-release.scanner /abs/path/scanner.py
git config dev-release.check 'your-build-or-test-command'
```

The bundled scanner accepts `--root PATH`, `--json`, `--no-fail` and
`--max-bytes N` (default: 1,000,000). It reports high/medium findings with exit
status 1 unless `--no-fail` is set. Oversized text files receive a
`large-text-file-skipped` finding for human review.

A custom scanner must accept `--root PATH` and exit nonzero to block export.
It receives a temporary Git repo whose tracked files are exactly the selected
snapshot. When `.releasescan-allow` exists in the exported commit, the scanner
must also accept `--json --no-fail`, exit zero after a successful scan,
and print a JSON list of objects with `severity`, `check`, `path`, `line` and
`detail`. Severity is `high`, `medium` or `low`; check, path and detail are strings;
path is snapshot-relative, and line is a positive 1-based integer or `null`.
Keep scanner diagnostics on stderr and never print secret values. Scanner stderr
is forwarded, including before aborting on a crash, invalid JSON/schema or a
nonzero exit status. Any nonzero build exit status also aborts the export.
A missing scanner aborts too; restore the bundled file or correct the override.
Use `--no-scan` only when the user explicitly waives scanning; never use it
automatically to get past a scanner failure or a missing scanner.

## Release flow

1. Commit the intended project changes and rules in the dev repo.
2. Preview and validate the chosen commit:
   `python3 /path/to/dev-release-split/scripts/drs.py export --commit HEAD --dry-run`.
3. Review excluded paths and suspicious kept files. Warnings cover names such
   as plans/reports/notes and text mentioning agent tools; they do not exclude
   files. Adjust and commit `.releaseignore` if necessary, then preview again.
4. Run `export --commit HEAD` with the same options to create the snapshot.
5. Print the exact push command emitted by export. The user runs it in their
   own terminal: `git push release release-snapshot:main` with default settings.

`--message MSG` replaces `Release YYYY-MM-DD`; messages must contain neither the
full dev commit SHA, any hex token of at least 7 characters that abbreviates it,
nor Git trailers. `--check CMD` overrides the configured
build command. Checks run in the temporary snapshot; their generated or edited
files are not exported. The release always contains the selected dev commit's
original bytes and modes, including executable files and symlinks.

Exports leave the dev index, working tree and HEAD unchanged. The parent is the
local snapshot branch tip, otherwise the existing remote-tracking target tip,
otherwise no parent. An identical tree prints `nothing to release` and creates
no commit. Setup and export reject symbolic snapshot refs and parents whose
history overlaps another ref (excluding this snapshot branch and this release
remote's tracking refs), or contains a merge. Setup also rejects the current
branch as the snapshot branch. Dry runs perform selection, preview, scan and build without changing
a ref or creating a commit. Export never fetches or pushes.

## Approval rule

**Agents never push to the release remote.** Print the push command for the user
to run in their own terminal. Agent shells, and possibly `!` shells, have no
controlling terminal. Do not create a pseudo-terminal or automate confirmation.
Never use `--no-verify` or pty wrappers such as `script/expect` for release pushes.

The hook reads repository-local release settings and fails closed. A dev push
requires both a configured remote name in local `dev-release.devremote` and an
exact destination URL match from `git remote get-url --push --all -- NAME`.
This lookup applies persistent `insteadOf`/`pushInsteadOf` rules with transient
Git config overrides scrubbed. Only matching dev pushes chain the previous hook
without terminal confirmation, preserving its exit code. Raw-URL pushes are
never dev pushes, even if their URL matches an allowlisted remote.
For multiple push URLs, embedded newlines in URL settings or rewrite rules make
the lookup ambiguous; those pushes also require snapshot and terminal approval.

Pushes to any other destination require the snapshot branch as the source and
terminal confirmation. The hook rejects deletions, tags and other branches,
including those included in `--all` or `--mirror` pushes. It displays the remote name and URL,
refs, commit SHA, number of commits to send and up to 10 subjects, then asks for
`y` or `yes` through `/dev/tty`. If the remote's old commit is unavailable locally,
the preview conservatively counts all ancestors of the pushed commit.
Missing or empty local remote/branch settings reject every push until setup.
After approval, the preserved pre-push hook still runs and can reject the push.

## Customizing .releaseignore

Git's own ignore matcher applies the bundled defaults first, then
`.releaseignore` **from the exported commit**. Working-tree rule edits, project
`.gitignore`, `.git/info/exclude` and global excludes do not affect selection.
Later negations override earlier rules, subject to Git's parent-directory rules.

Defaults exclude agent config at any depth, root agent work areas, secrets,
editor/OS files and the root `.releaseignore` and `.releasescan-allow`. They keep
`reports/`, `plans/`, `docs/` and `.github/workflows/`. `.env.example` is excluded
by default too.

Append these rules to ship only the root `.claude/skills/` tree, retaining the
exclusion of `.claude/settings.json` and nested `a/.claude/` directories:

```gitignore
!/.claude/
/.claude/*
!/.claude/skills/
```

To publish only a root `AGENTS.md`:

```gitignore
!/AGENTS.md
```

To ship a reviewed, nonsecret example environment file, explicitly add
`!/.env.example`. Do not unignore secrets just to make a build pass.

## Human-reviewed scan allowances

The optional root `.releasescan-allow` accepts specific findings that a human has
reviewed as safe. **Every entry requires human review. Agents must not add entries
on their own without the user's review.** Commit it on the dev branch; export
reads only the selected commit's regular file, never working-tree edits. It never
ships, even if `.releaseignore` tries to re-include it.

Each entry is `check path sha256-or-dash`. Blank lines and lines beginning with `#`
(after optional whitespace) are ignored; malformed entries abort export. The
first and last whitespace-delimited fields surround the snapshot-relative path,
which may contain spaces. For numbered findings, the hash is SHA-256 of the exact
flagged line's UTF-8 text without its LF, CRLF or CR terminator; all other
whitespace is preserved. For findings with no line number on a regular snapshot
file, hash the entire file's bytes, including line terminators. Any byte change
then invalidates the entry. Use `-` only for no-line findings whose path is not a
file in the snapshot, such as `gitignore-missing`; it never matches a file-backed
finding. Matching requires the same check, path and computed key.

With this file present (even empty), export requests JSON findings and blocks on
every remaining high/medium finding. Low findings never block. Blocking findings
print `severity check path:line` without line content or scanner details. High
findings and any `secret-pattern` finding print `remove the value; do not allow it`
instead of a hash or ready-to-paste allowance, because hashes of short secret
lines can be brute-forced. A human-computed allowance still works after review.
Other blocking findings print a ready-to-paste `check path sha256-or-dash` entry
with the correct key. No-line findings display `path:-`. Entries that match
nothing produce warnings. Without this file, export retains the plain `--root`
scan and aborts on any nonzero scanner exit status.

## Limits

- The hook is a local accident guard against agents and humans pushing by
  mistake, **not a security boundary**. Anyone with shell access, agents included,
  can bypass it with `--no-verify`, `core.hooksPath`, editing `.git/config`, or a
  pty wrapper (`script/expect`). `git push --receive-pack=...` or `--exec=...`
  can also redirect the receiver without the hook seeing it. Transient `-c`
  settings and `GIT_SSH`/`GIT_SSH_COMMAND` overrides make any push count as a
  release push. Clones need setup again.
- For a hard boundary, keep release-repo push credentials out of agent
  environments and/or use server-side protection, such as a protected branch
  requiring a PR review. The agent rule remains: never push to release, never
  use `--no-verify` or pty wrappers for it.
- The leak scan is not a guarantee. Review the selected content before release;
  `--no-scan` explicitly skips this check.
- Export creates snapshots with independent, linear release ancestry and rejects
  parents sharing history with other refs. Use a dedicated snapshot branch and
  release repository. This ref-based check cannot identify dev ancestry after
  its other refs are deleted. Nothing removes history already pushed.
- Remote-tracking state is used as-is; no automatic fetch occurs. Resolve stale
  remote state before releasing. Concurrent local snapshot updates are rejected.
- Submodules are rejected because a gitlink is not a materialized project file.
  `.releaseignore` and `.releasescan-allow` must be regular files. The snapshot
  branch must not be checked out in any worktree while exporting.
- Trees with casefold collisions in any path component, or symlink ancestors,
  are rejected before materialization, including dry runs. Git replacement
  objects are ignored; materialized blob hashes must match the committed IDs.
