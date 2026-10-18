// The handoff document: Claude's summary under fixed headings, plus git facts the mod reads itself.
// The git facts go only into the saved file, so they cost no model tokens.

export const HANDOFF_SECTIONS = ['Goal', 'Decisions', 'Files touched', 'Done', 'Left', 'Next step', 'Rules to keep'] as const

// The compaction is there to avoid a full cache rewrite, so its own output stays short.
export const HANDOFF_INSTRUCTIONS =
  'Write this as a handoff for a fresh session, in English, under exactly these Markdown headings in this order: ' +
  HANDOFF_SECTIONS.map(name => `## ${name}`).join(', ') + '. ' +
  'Terse bullets, at most 300 words in total; write "none" under a heading with nothing to say. ' +
  'Rules to keep: standing instructions the user gave (reply language, what to ask before doing). ' +
  'Next step: the single exact action to take first. Do not restate git status; it is added separately.'

// Same launch as blast-radius's previews: bash -p skips $BASH_ENV and exported functions, and the
// absolute path means a `bash` inside the repo is never used.
export const SHELL_ARGV = ['/bin/bash', '--noprofile', '--norc', '-p', '-c']

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const EMPTY_TREE_256 = '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321'
export const MAX_FILES = 20

// Reads git without running any of the repo's own programs: no GIT_* from the session, PATH without
// relative or in-repo entries, no lazy fetch or optional locks, attributes from the empty tree (so no
// filter runs), fsmonitor off. A git too old for GIT_ATTR_SOURCE, or a repo with its own
// info/attributes, skips the status (S?) rather than risk a filter.
// Tags: B branch, H last commit, A commits ahead of upstream (? when none), S status line, S? unchecked.
export const GIT_STATE_SCRIPT =
  'unset CDPATH; export LC_ALL=C; ' +
  'for v in $(compgen -e); do case $v in GIT_*) unset "$v";; esac; done; ' +
  'export GIT_NO_LAZY_FETCH=1 GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 GIT_NO_REPLACE_OBJECTS=1; ' +
  // The repo top is found by walking up to a .git with no external command, since PATH is not safe yet.
  't_=$PWD; while [ "$t_" != / ] && [ ! -e "$t_/.git" ]; do t_=${t_%/*}; t_=${t_:-/}; done; { [ "$t_" = / ] || [ ! -e "$t_/.git" ]; } && t_=$PWD; ' +
  'p_=; o_=$IFS; IFS=:; for e_ in $PATH; do case "$e_" in "$PWD"|"$PWD"/*|"$t_"|"$t_"/*) ;; /*) p_="${p_:+$p_:}$e_";; esac; done; IFS=$o_; PATH=$p_; export PATH; ' +
  '[ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" = true ] || exit 0; ' +
  'case "$(git rev-parse --show-object-format 2>/dev/null)" in ' +
  `sha256) export GIT_ATTR_SOURCE=${EMPTY_TREE_256};; *) export GIT_ATTR_SOURCE=${EMPTY_TREE};; esac; ` +
  'echo "B $(git symbolic-ref --short -q HEAD || echo "(detached)")"; ' +
  'echo "H $(git -c log.showSignature=false log -1 --no-show-signature --format=\'%h %s\' 2>/dev/null)"; ' +
  'echo "A $(git rev-list --count @{u}..HEAD 2>/dev/null || echo ?)"; ' +
  'case "$(git --version 2>/dev/null)" in ' +
  '"git version "[1-9][0-9].*|"git version "[3-9].*|"git version 2."4[5-9]*|"git version 2."[5-9][0-9]*|"git version 2."[1-9][0-9][0-9]*) ;; *) echo "S?"; exit 0;; esac; ' +
  '[ -s "$(git rev-parse --git-path info/attributes 2>/dev/null)" ] && { echo "S?"; exit 0; }; ' +
  'out=$(git -c core.fsmonitor=false -c core.untrackedCache=false -c core.attributesFile=/dev/null ' +
  'status --porcelain --ignore-submodules=all 2>/dev/null) || { echo "S?"; exit 0; }; ' +
  'printf \'%s\\n\' "$out" | sed \'/^$/d; s/^/S /\''

export type GitState = { branch: string; head: string; ahead: string; files: string[]; isUnchecked: boolean }

export function parseGitState(stdout: string): GitState | undefined {
  const lines = stdout.split('\n')
  const tag = (t: string) => lines.find(line => line.startsWith(`${t} `))?.slice(2).trim()
  const branch = tag('B')
  if (branch === undefined) return undefined
  return {
    branch,
    head: tag('H') ?? '',
    ahead: tag('A') ?? '?',
    files: lines.filter(line => line.startsWith('S ')).map(line => line.slice(2)),
    isUnchecked: lines.includes('S?'),
  }
}

export function gitSection(git: GitState): string {
  const files = git.isUnchecked
    ? ['- uncommitted files: not checked (old git or repo attributes)']
    : git.files.length === 0
      ? ['- uncommitted files: none']
      : [
          `- uncommitted files (${git.files.length}):`,
          ...git.files.slice(0, MAX_FILES).map(file => `  - ${file}`),
          ...(git.files.length > MAX_FILES ? [`  - ...and ${git.files.length - MAX_FILES} more`] : []),
        ]
  return [
    '## Git (read by usage-keeper, not by Claude)',
    `- branch: ${git.branch}`,
    `- last commit: ${git.head || 'none'}`,
    `- unpushed commits: ${git.ahead === '?' ? 'unknown (no upstream)' : git.ahead}`,
    ...files,
  ].join('\n')
}

export function handoffDocument({ cwd, savedAt, git, summary }: { cwd: string; savedAt: string; git?: GitState; summary: string }): string {
  return [
    '# Handoff',
    `cwd: ${cwd}\nsaved: ${savedAt}`,
    ...(git ? [gitSection(git)] : []),
    summary.trim(),
  ].join('\n\n') + '\n'
}
