# claude-mods

Personal Claude Code mods. Each folder is one mod.

- `blast-radius`: holds risky Bash commands (rm -rf, force-push, migrations) and shows what would be lost first. Fork of hamzafer/claude-code-mods (MIT).
- `usage-keeper`: sends keep-alives every 55 idle minutes to refresh the 1-hour prompt cache, then compacts and saves a handoff after the configured number (default 3).
- `where-am-i`: fork of hamzafer/claude-code-mods (MIT).
- `workbench`: a side pane with the changed files, their diff, stage and open-in-VS Code buttons, the status of running agents and Codex, and the first line of each Codex run's last answer; settings ask-rule requests wait in a placed pane for approval or refusal for 30 s, then fall back to the chat dialog, with the tool, agent, input, and rule shown.
- `loop-breaker`: tells Claude to stop and rethink when the same command keeps failing or the same code keeps being rewritten. Fork of mishgoldenberg/claude-mods (MIT), messages in Korean.
- `md-render`: redraws Claude's finished replies as colored markdown (headings, bold, code, lists, quotes); tables and code blocks keep the built-in renderer. Fork of deepskyblue86/claude-markdown-mod (MIT).
- `duo-quiz`: Duolingo-style multiple-choice quiz below the workbench pane, made by Haiku from the current prompt and the last answer (architecture, design, terms). Up to 10 questions, explanations, missed ones asked once more at the end, skip and stop. Quiz generation is an extra Haiku call, billed like any other model use.
- `next-steps-pick`: next-step suggestions above the prompt; pressing one puts that request in the prompt box (Enter sends it). Fork of shijieli708-ship-it/claude-mods inline-next-steps (MIT); if you also have `inline-next-steps@claude-mods`, turn it off in `enabledPlugins`.

## Requirements

- Claude Code with mod support; tested on 2.1.300.
- macOS or Linux with `bash` and `git` (blast-radius runs its checks through `/bin/bash`).
- UI strings are in Korean.

## Use

Clone at a pinned commit, then load the mods you want for a session with `--plugin-dir` (repeatable). Nothing is installed or written to your settings.

```bash
git clone https://github.com/taljeon/plzdo-claude-mods.git
claude --plugin-dir plzdo-claude-mods/blast-radius --plugin-dir plzdo-claude-mods/md-render
claude --plugin-dir plzdo-claude-mods      # a folder of plugins loads every mod in it
```

`duo-quiz` depends on `workbench`, which depends on `blast-radius`: load all three together.

What runs and what leaves the machine:

- No model calls: `loop-breaker`, `blast-radius`, `md-render`, `next-steps-pick`, `workbench`.
- `where-am-i`: a Haiku call after every main turn with part of the last prompt, recent tool descriptions and the reply.
- `duo-quiz`: a Haiku call on each new prompt while no quiz is running, with up to 4,000 characters each of the prompt and the previous answer.
- `usage-keeper`: sends prompts by itself after 55 idle minutes (only with 20,000+ context tokens), then compacts and writes a handoff under `~/.claude/handoffs`.
- `loop-breaker` adds a note to the conversation after 3 repeated failures or rewrites; `next-steps-pick` adds about 1,000 characters of instructions to each eligible prompt.
- Permission decisions: `blast-radius` only returns deny; `workbench` can return allow or deny for settings ask rules you answer in its pane, and reads recent `~/.codex/sessions` files.

## License

MIT (see [LICENSE](LICENSE)). Forked mods (blast-radius, where-am-i, loop-breaker, md-render, next-steps-pick) keep their original MIT license file in their own folder.
