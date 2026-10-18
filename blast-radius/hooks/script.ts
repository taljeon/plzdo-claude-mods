// Shell pieces of the previews. Plain strings, so a real shell can test them (tests/real-shell.check.mjs).
export const FILE_CAP = 5000
export const MAX_LISTED = 200

// How every preview shell is launched. `-p` (after the long options, which bash 3.2 wants first) makes
// bash skip $BASH_ENV and $ENV and ignore exported functions, so nothing from the session runs before
// SAFE_ENV does. An absolute path, so a `bash` found through a PATH entry inside the repo is never used.
export const SHELL_ARGV = ['/bin/bash', '--noprofile', '--norc', '-p', '-c']

// git's empty tree. As the attribute source it makes git read no .gitattributes at all, so no path maps
// to a filter (clean/smudge/process, git-lfs extensions) and none can run during `status`.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
// A sha256 repo rejects the sha1 id ("bad GIT_ATTR_SOURCE") as soon as it reads attributes, so each
// repo gets the empty tree of its own object format (`src`, before every status).
const EMPTY_TREE_256 = '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321'

// Start of every preview shell: no GIT_* from the session (GIT_DIR, GIT_WORK_TREE could point git at
// another repo), no lazy fetch (a partial clone would run the repo's ssh/remote helpers to fetch a
// missing blob), no credential prompt, no optional index locks, and no attributes (see EMPTY_TREE).
// GIT_ATTR_SOURCE and GIT_NO_LAZY_FETCH need a recent git (2.45 has both); an older git ignores them and
// would run filters or fetch helpers, so attr_ok gates every status below.
// GIT_NO_REPLACE_OBJECTS: refs/replace/ lives in the repo and could swap the trees status compares.
// PATH keeps only absolute entries outside the working folder: a relative one (`node_modules/.bin`,
// `.`) or one inside the repo would run the repo's own `git`, `find` or `awk`.
export const SAFE_ENV =
  // CDPATH: `bash -p` still honours it, and it would send the `cd` in ia/up to another folder.
  // LC_ALL=C: git's "not a git repository" is matched by its English text.
  'unset CDPATH; export LC_ALL=C; ' +
  'for v in $(compgen -e); do case $v in GIT_*) unset "$v";; esac; done; ' +
  `export GIT_NO_LAZY_FETCH=1 GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 GIT_NO_REPLACE_OBJECTS=1 GIT_ATTR_SOURCE=${EMPTY_TREE}; ` +
  // The repo top is found by walking up to a .git with no external command, since PATH is not safe yet.
  't_=$PWD; while [ "$t_" != / ] && [ ! -e "$t_/.git" ]; do t_=${t_%/*}; t_=${t_:-/}; done; { [ "$t_" = / ] || [ ! -e "$t_/.git" ]; } && t_=$PWD; ' +
  'p_=; o_=$IFS; IFS=:; for e_ in $PATH; do case "$e_" in "$PWD"|"$PWD"/*|"$t_"|"$t_"/*) ;; /*) p_="${p_:+$p_:}$e_";; esac; done; IFS=$o_; PATH=$p_; export PATH; ' +
  'attr_ok=0; case "$(git --version 2>/dev/null)" in ' +
  '"git version "[1-9][0-9].*|"git version "[3-9].*|"git version 2."4[5-9]*|"git version 2."[5-9][0-9]*|"git version 2."[1-9][0-9][0-9]*) attr_ok=1;; esac; ' +
  // `.git/info/attributes` is not covered by GIT_ATTR_SOURCE, so a non-empty one holds the repo.
  'ia() { (cd "$1" && [ -s "$(git rev-parse --git-path info/attributes 2>/dev/null)" ]); }; ' +
  'src() { case "$(git -C "$1" rev-parse --show-object-format 2>/dev/null)" in ' +
  `sha256) GIT_ATTR_SOURCE=${EMPTY_TREE_256};; *) GIT_ATTR_SOURCE=${EMPTY_TREE};; esac; export GIT_ATTR_SOURCE; }; `

// Shell test: true when `git status` in the repo at "dir" cannot be made safe, so it is reported
// unchecked (X) instead of run.
export const isUnsafeStatus = (dir: string) => `[ "$attr_ok" != 1 ] || ia ${dir}`
// Git flags that keep `status` from running the repo's own programs or rewriting its index.
// core.attributesFile=/dev/null: a repo's config must not point attributes at a file of its own.
export const SAFE_STATUS = 'git -c core.fsmonitor=false -c core.untrackedCache=false -c core.attributesFile=/dev/null'

// Literal argv paths only. Keep failed GNU stdout separate from the BSD fallback.
export const FILE_SCRIPT = SAFE_ENV +
  'f="$1"; case "$f" in -*) f="./$f";; esac; ' +
  'if [ -d "$f" ]; then echo directory; ' +
  'elif [ -f "$f" ]; then ' +
  'dt=$(stat -c \'%W %Y %s\' "$f" 2>/dev/null) || dt=$(stat -f \'%B %m %z\' "$f" 2>/dev/null) || dt="? ? ?"; ' +
  '[[ "$dt" =~ ^-?[0-9]+\\ -?[0-9]+\\ [0-9]+$ ]] || dt="? ? ?"; printf \'file %s\\n\' "$dt"; ' +
  'elif [ -e "$f" ] || [ -L "$f" ]; then echo other; else echo missing; fi'

// Encode bytes so NULs survive the process boundary. The caller checks secret names before running this.
export const CONTENT_SCRIPT = SAFE_ENV +
  'f="$1"; case "$f" in -*) f="./$f";; esac; ' +
  // A link is never read: its own name can look harmless while it points at a secret file.
  '[ -L "$f" ] && { echo SKIP; exit 0; }; ' +
  '[ -f "$f" ] || { echo SKIP; exit 0; }; ' +
  'n=$(stat -c \'%s\' "$f" 2>/dev/null) || n=$(stat -f \'%z\' "$f" 2>/dev/null) || exit 1; ' +
  '[[ "$n" =~ ^[0-9]+$ ]] || exit 1; [ "$n" -le 1048576 ] || { echo SKIP; exit 0; }; ' +
  'set -o pipefail; head -c 512 -- "$f" | od -An -v -tu1'

// $t globs but never splits (IFS empty), so "my app" stays one path.
// Tags: S size in KB, F file, D birth/modified seconds + path, R changed in 24 h, G a .git, U modified tracked count,
// N untracked count, X a repo skipped because its own config runs filters, M more than 50 repos (rest unchecked).
// Git safety: no attributes are read (so no filter runs), fsmonitor is forced off, and optional locks
// are off so the index is not rewritten.
export const DELETE_SCRIPT =
  SAFE_ENV +
  'shopt -s nullglob; IFS=; r="$1"; shift; dated=0; ' +
  'up() { a=$(cd "$1" && pwd -P); while :; do [ -e "$a/.git" ] && { echo "X $1"; return; }; [ "$a" = / ] && return; a=$(dirname "$a"); done; }; ' +
  'gs() { src "$1"; ' +
  `if ${isUnsafeStatus('"$1"')}; then echo "X $1"; return; fi; ` +
  // --ignore-submodules=all: a submodule's own filter config must not run either.
  // A failed status (unknown repo extension, dubious ownership) is reported, never read as "clean".
  `out=$(${SAFE_STATUS.replace('git ', 'git -C "$1" ')} ` +
  `status --porcelain --untracked-files=all --ignore-submodules=all -- "$2" 2>/dev/null) || { echo "X $1"; return; }; ` +
  // assume-unchanged (lowercase tag) and skip-worktree (S) hide edits from status: not "clean".
  `if git -C "$1" ls-files -v -- "$2" 2>/dev/null | grep -q '^[a-zS] '; then echo "X $1"; return; fi; ` +
  `printf '%s\n' "$out" | awk 'NF { if ($1 == "??") n++; else m++ } END { print "U " m+0; print "N " n+0 }'; ` +
  '}; ' +
  'for t in "$@"; do for p in $t; do ' +
  'case "$p" in .|..|*/.|*/..) continue;; esac; ' +
  'case "$p" in -*) p="./$p";; esac; ' +
  '[ -e "$p" ] || continue; ' +
  // A plain rm refuses folders, so do not count what it will not delete.
  'if [ -d "$p" ] && [ "$r" != 1 ]; then continue; fi; ' +
  'echo "T $p"; echo "S $(du -sk "$p" | cut -f1)"; ' +
  'while IFS= read -r f; do echo "F $f"; ' +
  `if [ "$dated" -lt ${MAX_LISTED} ]; then ` +
  // GNU -f can print filesystem data before failing. Keep each attempt's stdout separate.
  'dt=$(stat -c \'%W %Y\' "$f" 2>/dev/null) || dt=$(stat -f \'%B %m\' "$f" 2>/dev/null) || dt="? ?"; ' +
  '[[ "$dt" =~ ^-?[0-9]+\\ -?[0-9]+$ ]] || dt="? ?"; ' +
  'printf \'D %s %s\\n\' "${dt:-? ?}" "$f"; dated=$((dated+1)); fi; ' +
  `done < <(find "$p" -name .git -prune -o -type f -print | head -n ${FILE_CAP}); ` +
  `find "$p" -name .git -prune -o -type f -mtime -1 -print | head -n ${FILE_CAP} | sed "s/^/R /"; ` +
  // Past 50 repos the rest are neither listed nor checked: M says so instead of a silent stop.
  'find "$p" -name .git -print -prune | head -n 51 | { c=0; while IFS= read -r g; do c=$((c+1)); if [ $c -gt 50 ]; then echo "M $p"; break; fi; echo "G $g"; done; }; ' +
  'if [ -d "$p" ]; then d="$p"; s=.; else d=$(dirname "$p"); s=":(literal)$(basename "$p")"; fi; ' +
  // Outside any repo is fine; a repo git cannot read is reported as unchecked. "not a git repository"
  // or `false` (core.worktree elsewhere, or inside .git) with a .git in an ancestor is such a repo, not "outside".
  'rp=$(git -C "$d" rev-parse --is-inside-work-tree 2>&1); ' +
  'case "$rp" in true) gs "$d" "$s";; false|*"not a git repository"*) up "$d";; *) echo "X $d";; esac; ' +
  'n=0; find "$p" -mindepth 2 -name .git -prune -print0 | ' +
  'while IFS= read -r -d "" g; do n=$((n+1)); if [ $n -gt 50 ]; then echo "M $p"; break; fi; gs "$(dirname "$g")" .; done; ' +
  'done; done'

// Uncommitted files before a migration. The same guards as the delete preview: no attributes, so a
// repo's own filter or fsmonitor config never runs, and a failed status prints X, never an empty
// "clean" list. Outside any repo there is nothing to check (O), unless a .git above says git just
// cannot read it (X), as in the delete preview.
export const MIGRATION_SCRIPT =
  SAFE_ENV +
  'rp=$(git rev-parse --is-inside-work-tree 2>&1); case "$rp" in ' +
  `true) src .; if ${isUnsafeStatus('.')}; then echo X; else ${SAFE_STATUS} status --porcelain --ignore-submodules=all 2>/dev/null || echo X; fi;; ` +
  'false|*"not a git repository"*) a=$(pwd -P); while :; do [ -e "$a/.git" ] && { echo X; break; }; [ "$a" = / ] && { echo O; break; }; a=$(dirname "$a"); done;; ' +
  '*) echo X;; esac'
