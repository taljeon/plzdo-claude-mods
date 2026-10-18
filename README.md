# claude-mods

Personal Claude Code mods. Each folder is one mod.

- `blast-radius`: holds risky Bash commands (rm -rf, force-push, migrations) and shows what would be lost first. Fork of hamzafer/claude-code-mods (MIT).
- `usage-keeper`: sends keep-alives every 55 idle minutes to refresh the 1-hour prompt cache, then compacts and saves a handoff after the configured number (default 3).
- `where-am-i`: fork of hamzafer/claude-code-mods (MIT).
- `workbench`: a side pane with the changed files, their diff, stage and open-in-VS Code buttons, the status of running agents and Codex, and the first line of each Codex run's last answer; settings ask-rule requests wait in a placed pane for approval or refusal for 30 s, then fall back to the chat dialog, with the tool, agent, input, and rule shown.
- `loop-breaker`: tells Claude to stop and rethink when the same command keeps failing or the same code keeps being rewritten. Fork of mishgoldenberg/claude-mods (MIT), messages in Korean.
- `md-render`: redraws Claude's finished replies as colored markdown (headings, bold, code, lists, quotes); tables and code blocks keep the built-in renderer. Fork of deepskyblue86/claude-markdown-mod (MIT).
- `duo-quiz`: Duolingo-style multiple-choice quiz below the workbench pane, made by Haiku from the current prompt and the last answer (architecture, design, terms). Up to 10 questions, explanations, missed ones asked once more at the end, skip and stop. Each quiz is an extra Haiku call, billed like any other model use.
- `next-steps-pick`: next-step suggestions above the prompt; pressing one puts that request in the prompt box (Enter sends it). Fork of shijieli708-ship-it/claude-mods inline-next-steps (MIT); if you also have `inline-next-steps@claude-mods`, turn it off in `enabledPlugins` (install.py only warns).

## Requirements

- Claude Code with mod support (`CLAUDE_CODE_PLUGIN_DIRS`); tested on 2.1.300.
- macOS or Linux with `bash` and `git` (blast-radius runs its checks through `/bin/bash`).
- Python 3.9+ for `install.py`; Python 3.12+ for `shared-skills/dev-release-split` (`pytest` only to run its tests).
- dev-release-split bundles its leak scanner (`scripts/leak_scan.py`); set `git config dev-release.scanner` to use another one (see its SKILL.md).

## Use

```bash
git clone https://github.com/taljeon/plzdo-claude-mods.git ~/.claude/mods
cd ~/.claude/mods
python3 install.py          # Preview only; no writes
python3 install.py --apply  # Apply the changes
```

The installer uses Python 3.9+ and the standard library only.

It discovers this checkout's mods and merges their absolute paths into `env.CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`, preserving existing paths and other settings. Before changing an existing settings file, it creates a `settings.json.bak-YYYYMMDD-HHMMSS` backup (with a numeric suffix if needed). It also symlinks each shared skill into `~/.claude/skills` (except `claude-env-setup`, which is used from the checkout); conflicting paths are reported and left untouched while other changes are applied. Restart Claude Code after applying.

Use `--claude-dir PATH` on both commands to target another configuration directory. Without it, the installer uses `$CLAUDE_CONFIG_DIR` when set, otherwise `~/.claude`.

To undo a settings change, copy the appropriate `settings.json.bak-*` file back to `settings.json` in that directory. Backups restore settings only, not skill symlinks; a newly created settings file has no backup.

For guided setup through Claude, use [shared-skills/claude-env-setup](shared-skills/claude-env-setup/SKILL.md).

## License

MIT (see [LICENSE](LICENSE)). Forked mods (blast-radius, where-am-i, loop-breaker, md-render, next-steps-pick) keep their original MIT license file in their own folder.
