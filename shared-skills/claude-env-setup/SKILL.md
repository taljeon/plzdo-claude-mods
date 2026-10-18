---
name: claude-env-setup
description: Set up this user's Claude Code mods and shared skills on a new or work machine from the claude-mods repo. Use when the user asks to set up / 셋업 / 적용 their Claude environment on another PC.
---

# Claude environment setup

Set up only this repo's mods and shared skills. Other plugins, global CLAUDE.md/agents, personal hooks, and Codex are out of scope and managed elsewhere.

1. Check `claude --version`. If Claude Code is unavailable, report that prerequisite before continuing.
2. Locate the repo on disk. If it is missing, ask before cloning (this uses the network). Use the repo URL the user names; the public one is:

   ```bash
   git clone https://github.com/taljeon/plzdo-claude-mods.git ~/.claude/mods
   ```

3. Run the dry run and show its output:

   ```bash
   python3 ~/.claude/mods/install.py
   ```

4. After the user approves the preview, apply it:

   ```bash
   python3 ~/.claude/mods/install.py --apply
   ```

   If the checkout is elsewhere, use its actual path. The target defaults to `$CLAUDE_CONFIG_DIR` when set, otherwise `~/.claude`. For a custom target, pass the same `--claude-dir PATH` to the preview and apply commands. If settings validation fails, report the error and stop.

5. Discover each top-level mod folder by its `.claude-plugin/plugin.json`, run `claude plugin validate <mod>` for each, and report the results. Report skill conflicts as well, including when the installer exits 3 after applying other changes.
6. Tell the user to restart Claude Code to load the mods.

Never push. Never delete or overwrite conflicting skill paths; report them and leave them untouched. If the user wants to undo a settings change, restore the appropriate `settings.json.bak-*` file to `settings.json` in the target directory. Backups restore settings only; they do not remove skill symlinks. When settings.json was first created, there is no backup.
