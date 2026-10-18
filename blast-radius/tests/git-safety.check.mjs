// Codex review findings replayed against real git repos (the mocked engine cannot run git).
// Run: node tests/git-safety.check.mjs   (Node 22.6+ with type stripping). Exits 1 on any FAIL.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'
import { DELETE_SCRIPT, SHELL_ARGV } from '../hooks/script.ts'
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'br-repro-'))
const home = path.join(root, 'home'); fs.mkdirSync(home)
const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
const git = (d, ...a) => spawnSync('git', ['-C', d, ...a], { env, encoding: 'utf8' })
const put = (f, t = 'x\n') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t) }
const repo = name => { const d = path.join(root, name); fs.mkdirSync(d); git(d, 'init', '-q'); git(d, 'config', 'user.email', 'r@e.invalid'); git(d, 'config', 'user.name', 'r'); put(path.join(d, 'main.ts'), 'old\n'); put(path.join(d, '.gitattributes'), '*.txt text\n'); git(d, 'add', '.'); git(d, 'commit', '-qm', 'i'); put(path.join(d, 'main.ts'), 'new\n'); const t = new Date(Date.now() + 2000); fs.utimesSync(path.join(d, 'main.ts'), t, t); return d }
const run = (d, target, extra = {}) => spawnSync(SHELL_ARGV[0], [...SHELL_ARGV.slice(1), DELETE_SCRIPT, 'blast-radius', '0', target], { cwd: d, env: { ...env, ...extra }, encoding: 'utf8' }).stdout
const preview = (d, extra = {}) => run(d, 'main.ts', extra)
let failed = 0
const show = (name, ok, out) => { if (!ok) failed++; console.log(`${ok ? 'pass' : 'FAIL'}  ${name}   ${JSON.stringify(out.split('\n').filter(l => /^[UNX] /.test(l)))}`) }
const ran = (d, f = 'MARKER') => fs.existsSync(path.join(d, f))
const map = (d, rule = 'main.ts filter=evil') => put(path.join(d, '.gitattributes'), rule + '\n')
const helper = d => put(path.join(d, 'filter-helper.sh'), '#!/bin/sh\ntouch MARKER\ncat\n')

// 1. partial clone lazy fetch must not run core.sshCommand
const pc = repo('partial'); const blob = git(pc, 'rev-parse', 'HEAD:.gitattributes').stdout.trim()
fs.unlinkSync(path.join(pc, '.gitattributes')); fs.unlinkSync(path.join(pc, '.git/objects', blob.slice(0, 2), blob.slice(2)))
git(pc, 'config', 'remote.origin.promisor', 'true'); git(pc, 'config', 'remote.origin.url', 'ssh://example.invalid/r'); git(pc, 'config', 'core.sshCommand', `touch ${path.join(pc, 'FETCHED')}; exit 1`)
let o = preview(pc); show('1 lazy fetch helper not run', !ran(pc, 'FETCHED'), o)

// 2. user-level filter running a relative helper in the repo: never run, status still measured
const gf = repo('global-filter'); map(gf); helper(gf)
put(env.GIT_CONFIG_GLOBAL, '[filter "evil"]\n clean = sh ./filter-helper.sh\n')
o = preview(gf); show('2 relative global filter not run', !ran(gf) && /^U 1$/m.test(o), o)
// 2a. round 5 #1: bare filename (no slash) resolves in the repo too
put(env.GIT_CONFIG_GLOBAL, '[filter "evil"]\n clean = sh filter-helper.sh\n')
const bare = repo('bare-filter'); map(bare); helper(bare); o = preview(bare); show('2a bare-name global filter not run', !ran(bare) && /^U 1$/m.test(o), o)
// 2b. a git-lfs style global filter is still fine (status measured)
put(env.GIT_CONFIG_GLOBAL, '[filter "lfs"]\n clean = git-lfs clean -- %f\n process = git-lfs filter-process\n')
const lf = repo('lfs-ok'); o = preview(lf); show('2b plain global filter (git-lfs) still checked', /^U 1$/m.test(o), o)
// 2c. round 5 #2: lfs.extension.* in the repo with the allowed global lfs filter must not run its helper.
// Weak here: git-lfs is not installed, so this passes even without the fix; 2g is the real proof (a mapped filter never runs).
const ext = repo('lfs-ext'); map(ext, 'main.ts filter=lfs'); helper(ext)
git(ext, 'config', 'lfs.extension.evil.clean', 'sh ./filter-helper.sh'); git(ext, 'config', 'lfs.extension.evil.smudge', 'cat'); git(ext, 'config', 'lfs.extension.evil.priority', '0')
o = preview(ext); show('2c lfs.extension helper not run (weak: no git-lfs)', !ran(ext), o)
// 2d. round 5 #7: quoted absolute filter path with a space is not a reason to reject the repo
put(env.GIT_CONFIG_GLOBAL, `[filter "tool"]\n clean = "${path.join(root, 'My Tools', 'filter')}" clean\n`)
const sp = repo('space-filter'); map(sp, 'main.ts filter=tool'); o = preview(sp); show('2d quoted absolute filter not falsely held', /^U 1$/m.test(o), o)
// 2e. a filter mapped from .git/info/attributes (not covered by the attribute source) holds the repo
put(env.GIT_CONFIG_GLOBAL, '[filter "evil"]\n clean = sh filter-helper.sh\n')
const inf = repo('info-attrs'); helper(inf); put(path.join(inf, '.git/info/attributes'), 'main.ts filter=evil\n'); o = preview(inf); show('2e info/attributes filter -> X, not run', !ran(inf) && /^X /m.test(o), o)
// 2f. core.attributesFile pointed at a repo file by the repo's own config
const caf = repo('attrs-file'); helper(caf); put(path.join(caf, 'my-attrs'), 'main.ts filter=evil\n'); git(caf, 'config', 'core.attributesFile', path.join(caf, 'my-attrs'))
o = preview(caf); show('2f repo core.attributesFile ignored', !ran(caf), o)
fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '')
// 2g. repo-local filter config is inert too (no attributes read)
const loc = repo('local-filter'); map(loc); helper(loc); git(loc, 'config', 'filter.evil.clean', 'sh ./filter-helper.sh'); o = preview(loc); show('2g local filter not run', !ran(loc), o)

// 3. round 5 #3: BASH_ENV and exported functions from the session do not run in the preview shell
const be = repo('bash-env'); put(path.join(root, 'be.sh'), `touch '${path.join(be, 'BASHENV')}'\n`)
o = preview(be, { BASH_ENV: path.join(root, 'be.sh'), ENV: path.join(root, 'be.sh') }); show('3 BASH_ENV not sourced', !ran(be, 'BASHENV') && /^U 1$/m.test(o), o)
o = preview(be, { 'BASH_FUNC_git%%': `() { touch '${path.join(be, 'FUNC')}'; command git "$@"; }` }); show('3b exported git function ignored', !ran(be, 'FUNC') && /^U 1$/m.test(o), o)

// 5. round 5 #5: unreadable .git/HEAD is a broken repo, not "outside git"
const bh = repo('broken-head'); fs.chmodSync(path.join(bh, '.git/HEAD'), 0o000)
o = preview(bh); show('5 unreadable HEAD -> X (held)', /^X /m.test(o), o); fs.chmodSync(path.join(bh, '.git/HEAD'), 0o644)
const outside = path.join(root, 'plain'); put(path.join(outside, 'main.ts')); o = preview(outside); show('5b plain folder outside git stays quiet', !/^X /m.test(o), o)

// 7. unreadable repo (unknown extension) reported as unchecked
const ux = repo('unknown-ext'); git(ux, 'config', 'core.repositoryformatversion', '1'); git(ux, 'config', 'extensions.madeUpExtension', 'true')
o = preview(ux); show('7 unreadable repo -> X (held), not clean', /^X /m.test(o), o)

// 8. ambient GIT_DIR/GIT_WORK_TREE ignored
const pr = repo('primary'); const other = path.join(root, 'other'); fs.mkdirSync(other); git(other, 'init', '-q'); put(path.join(other, 'main.ts'), 'z'); git(other, 'add', '.'); git(other, '-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-qm', 'i')
o = preview(pr, { GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other }); show('8 GIT_DIR ignored, real repo modified file seen', /^U 1$/m.test(o), o)

// 9. round 6 #2: a refs/replace/ entry cannot swap the tree status compares or revive a filter mapping
const rp = repo('replace-ref'); put(path.join(rp, '.gitattributes'), 'main.ts filter=evil\n'); helper(rp); git(rp, 'config', 'filter.evil.clean', 'sh filter-helper.sh'); git(rp, 'add', '.'); git(rp, 'commit', '-qm', 'a')
git(rp, 'replace', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', 'HEAD^{tree}'); put(path.join(rp, 'main.ts'), 'newer\n'); { const t = new Date(Date.now() + 2000); fs.utimesSync(path.join(rp, 'main.ts'), t, t) }
fs.rmSync(path.join(rp, 'MARKER'), { force: true }) // setup's own `git add` ran the filter
o = preview(rp); show('9 replace ref: filter not run, change seen', !ran(rp) && /^U 1$/m.test(o), o)

// 10. round 6 #4: assume-unchanged / skip-worktree hide edits from status, so the repo is held, not "clean"
const au = repo('assume-unchanged'); git(au, 'update-index', '--assume-unchanged', 'main.ts'); o = preview(au); show('10 assume-unchanged -> X', /^X /m.test(o), o)
const sw = repo('skip-worktree'); git(sw, 'update-index', '--skip-worktree', 'main.ts'); o = preview(sw); show('10b skip-worktree -> X', /^X /m.test(o), o)

// 11. round 6 #5: core.worktree pointing elsewhere makes rev-parse say "false"; an ancestor .git still holds it
const cw = repo('core-worktree'); const away = path.join(root, 'away'); fs.mkdirSync(away); git(cw, 'config', 'core.worktree', away)
o = preview(cw); show('11 core.worktree elsewhere -> X', /^X /m.test(o), o)

// 12. round 6 #3: a git wrapper in a repo PATH entry (absolute or relative) never runs
const pw = repo('path-hijack'); const bin = path.join(pw, 'bin'); const real = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim()
put(path.join(bin, 'git'), `#!/bin/sh\ntouch '${path.join(pw, 'HIJACK')}'\nexec '${real}' "$@"\n`); fs.chmodSync(path.join(bin, 'git'), 0o755)
o = preview(pw, { PATH: `${bin}:${process.env.PATH}` }); show('12 repo PATH entry (absolute) ignored', !ran(pw, 'HIJACK') && /^U 1$/m.test(o), o)
o = preview(pw, { PATH: `bin:.:${process.env.PATH}` }); show('12b relative PATH entries ignored', !ran(pw, 'HIJACK') && /^U 1$/m.test(o), o)

// 13. review round 6: CDPATH must not send the preview's `cd` to another folder (bash -p still honours it)
{
  const w = path.join(root, 'cdw'); fs.mkdirSync(w); const sub = path.join(w, 'sub'); fs.mkdirSync(sub); git(sub, 'init', '-q'); git(sub, 'config', 'user.email', 'a@b.c'); git(sub, 'config', 'user.name', 'n')
  put(path.join(sub, 'main.ts'), 'old\n'); put(path.join(sub, 'filter-helper.sh'), 'touch MARKER\ncat\n'); git(sub, 'add', '.'); git(sub, 'commit', '-qm', 'i'); put(path.join(sub, 'main.ts'), 'new!\n')
  put(path.join(sub, '.git/info/attributes'), 'main.ts filter=evil\n'); git(sub, 'config', 'filter.evil.clean', 'sh filter-helper.sh')
  const elsewhere = path.join(root, 'cdelse'); fs.mkdirSync(path.join(elsewhere, 'sub'), { recursive: true })
  o = spawnSync(SHELL_ARGV[0], [...SHELL_ARGV.slice(1), DELETE_SCRIPT, 'br', '0', 'sub/main.ts'], { cwd: w, env: { ...env, CDPATH: elsewhere }, encoding: 'utf8' }).stdout
  show('13 CDPATH ignored: info/attributes seen, filter not run', !ran(sub) && /^X /m.test(o), o)
}

// baseline: ordinary modified file still counted, index untouched
const base = repo('baseline'); o = preview(base); show('baseline modified tracked file -> U 1', /^U 1$/m.test(o), o)
const idx = path.join(base, '.git/index'); const before = fs.statSync(idx).mtimeMs; preview(base); show('index not rewritten', fs.statSync(idx).mtimeMs === before, '')
fs.rmSync(root, { recursive: true, force: true })
process.exitCode = failed ? 1 : 0
