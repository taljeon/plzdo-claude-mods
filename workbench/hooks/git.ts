// Each mod loads on its own; keep the launch boundary local to workbench.
export const SHELL_ARGV = ['/bin/bash', '--noprofile', '--norc', '-p', '-c']
export const UNCHECKED = 78
export const UNCHECKED_TEXT = '변경 파일을 확인하지 않음: git 2.45 미만이거나 저장소 attributes 때문에 안전하게 읽을 수 없어요'

const LAUNCH =
  'unset CDPATH; export LC_ALL=C; ' +
  'for v in $(compgen -e); do case $v in GIT_*) unset "$v";; esac; done; ' +
  'w_=$(pwd -P); t_=$w_; while [ "$t_" != / ] && [ ! -e "$t_/.git" ]; do t_=${t_%/*}; t_=${t_:-/}; done; { [ "$t_" = / ] || [ ! -e "$t_/.git" ]; } && t_=$w_; ' +
  // Resolve directory aliases before deciding whether a PATH entry belongs to this repo.
  'p_=; o_=$IFS; IFS=:; for e_ in $PATH; do case "$e_" in /*) e_=$(cd -- "$e_" 2>/dev/null && pwd -P) || continue;; *) continue;; esac; ' +
  'case "$e_" in "$w_"|"$w_"/*|"$t_"|"$t_"/*) ;; *) p_="${p_:+$p_:}$e_";; esac; done; IFS=$o_; PATH=$p_; export PATH; ' +
  'export GIT_TERMINAL_PROMPT=0; '

// Pin before core.worktree can move later reads away from the session repo.
const RESOLVE_GIT =
  'g_=$(type -P git) || exit 78; case "$g_" in /*) ;; *) exit 78;; esac; ' +
  'd_=$(cd -- "${g_%/*}" 2>/dev/null && pwd -P) || exit 78; g_=$d_/${g_##*/}; ' +
  'git() { "$g_" "$@"; }; '
const PINNED = LAUNCH +
  'g_=$1; shift; case "$g_" in /*) ;; *) exit 78;; esac; ' +
  'd_=$(cd -- "${g_%/*}" 2>/dev/null && pwd -P) || exit 78; ' +
  'case "$d_" in "$w_"|"$w_"/*|"$t_"|"$t_"/*) exit 78;; esac; ' +
  'g_=$d_/${g_##*/}; [ -x "$g_" ] && [ ! -d "$g_" ] || exit 78; ' +
  'git() { "$g_" "$@"; }; '

const READ_ENV =
  'export GIT_NO_LAZY_FETCH=1 GIT_OPTIONAL_LOCKS=0 GIT_NO_REPLACE_OBJECTS=1; ' +
  'case "$(git rev-parse --show-object-format 2>/dev/null)" in ' +
  'sha256) export GIT_ATTR_SOURCE=6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321;; ' +
  '*) export GIT_ATTR_SOURCE=4b825dc642cb6eb9a060e54bf8d69288fbee4904;; esac; '

// info/attributes overrides GIT_ATTR_SOURCE; old git ignores it altogether.
const READ = PINNED + READ_ENV +
  'case "$(git --version 2>/dev/null)" in ' +
  '"git version "[1-9][0-9].*|"git version "[3-9].*|"git version 2."4[5-9]*|"git version 2."[5-9][0-9]*|"git version 2."[1-9][0-9][0-9]*) ;; *) exit 78;; esac; ' +
  'a_=$(git rev-parse --git-path info/attributes 2>/dev/null) || exit 78; ' +
  '[ -s "$a_" ] && exit 78; '
// File names are literal: a path named `*` must not select every file.
const GIT = 'git --literal-pathspecs -c core.fsmonitor=false -c core.untrackedCache=false -c core.attributesFile=/dev/null '
const DIFF = GIT + 'diff --no-ext-diff --no-textconv --ignore-submodules=all '

export const TOP_SCRIPT = LAUNCH + RESOLVE_GIT + READ_ENV + GIT + `rev-parse --show-toplevel && printf '%s\\n' "$g_"`
export const STATUS_SCRIPT = READ + GIT + 'status --porcelain=v1 -z --ignore-submodules=all'
// Before the first commit, compare the index/worktree with the empty tree.
const BASE = READ + 'base_=HEAD; git rev-parse --verify HEAD >/dev/null 2>&1 || base_=$GIT_ATTR_SOURCE; '
export const NUMSTAT_SCRIPT = BASE + DIFF + '"$base_" --numstat -z'
export const DIFF_SCRIPT = BASE + DIFF + '"$base_" -- "$1"'
export const UNTRACKED_SCRIPT = READ + DIFF + '--no-index -- /dev/null "$1"'
// Explicit staging must still use the repository's clean filters (for example git-lfs).
export const STAGE_SCRIPT = PINNED + 'git --literal-pathspecs add -- "$1"'
export const UNSTAGE_SCRIPT = PINNED + 'git --literal-pathspecs restore --staged -- "$1"'
