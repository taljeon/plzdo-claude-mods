// Real repositories and harmless marker helpers; all fixtures stay in one temporary folder.
// Run: node workbench/tests/real-git.check.mjs (Node 24).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DIFF_SCRIPT, NUMSTAT_SCRIPT, SHELL_ARGV, STAGE_SCRIPT, STATUS_SCRIPT, TOP_SCRIPT, UNCHECKED, UNSTAGE_SCRIPT, UNTRACKED_SCRIPT } from '../hooks/git.ts'
import { parseNumstat, parseStatus } from '../hooks/parse.ts'

const source = readFileSync(new URL('../hooks/register.tsx', import.meta.url), 'utf8')
// Red-green: when HEAD's register is temporarily restored, exercise its original argv boundary.
const original = source.includes("e.process.run(['git', ...args], { cwd })")
const usesPin = readFileSync(new URL('../hooks/git.ts', import.meta.url), 'utf8').includes('const PINNED =')
const oldArgs = new Map([
  [TOP_SCRIPT, ['rev-parse', '--show-toplevel']], [STATUS_SCRIPT, ['status', '--porcelain=v1', '-z']],
  [NUMSTAT_SCRIPT, ['diff', 'HEAD', '--numstat', '-z']], [DIFF_SCRIPT, ['diff', 'HEAD', '--']],
  [UNTRACKED_SCRIPT, ['diff', '--no-index', '--', '/dev/null']], [STAGE_SCRIPT, ['add', '--']],
  [UNSTAGE_SCRIPT, ['restore', '--staged', '--']],
])
const env = { ...process.env }
for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
env.GIT_CONFIG_NOSYSTEM = '1'
env.GIT_CONFIG_GLOBAL = '/dev/null'
const run = (cwd, argv, extra = {}) => spawnSync(argv[0], argv.slice(1), { cwd, env: { ...env, ...extra }, encoding: 'utf8' })
const git = (cwd, ...args) => run(cwd, ['git', ...args])
const pinnedRead = (cwd, script, binary, path, extra = {}) => run(cwd,
  [...SHELL_ARGV, script, 'workbench-git', binary, ...(path === undefined ? [] : [path])], extra)
const read = (cwd, script, path, extra = {}, binary) => {
  if (original) return run(cwd, ['git', ...oldArgs.get(script), ...(path === undefined ? [] : [path])], extra)
  if (usesPin && script !== TOP_SCRIPT) {
    const pin = binary ?? read(cwd, TOP_SCRIPT, undefined, extra).stdout.trimEnd().split('\n')[1] ?? ''
    return pinnedRead(cwd, script, pin, path, extra)
  }
  return run(cwd, [...SHELL_ARGV, script, 'workbench-git', ...(path === undefined ? [] : [path])], extra)
}
let passed = 0, failed = 0
const check = (name, ok) => {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}`)
  if (ok) passed++; else failed++
}
const must = result => {
  if (result.status !== 0) throw new Error(`${result.status}: ${result.stderr}`)
  return result.stdout
}
const dir = mkdtempSync(join(realpathSync(tmpdir()), 'workbench-git-'))
let sequence = 0
const put = (path, content) => writeFileSync(path, content)
const repo = (format) => {
  const cwd = join(dir, `repo-${sequence++}`)
  mkdirSync(cwd)
  must(git(cwd, 'init', '-q', '-b', 'main', ...(format ? [`--object-format=${format}`] : [])))
  must(git(cwd, 'config', 'user.name', 'test'))
  must(git(cwd, 'config', 'user.email', 'test@example.invalid'))
  put(join(cwd, 'f.txt'), 'before\n')
  put(join(cwd, 'rename.txt'), 'rename\n')
  must(git(cwd, 'add', '.'))
  must(git(cwd, 'commit', '-qm', 'initial'))
  put(join(cwd, 'f.txt'), 'after!\n')
  put(join(cwd, 'untracked.txt'), 'untracked\n')
  utimesSync(join(cwd, 'f.txt'), 2_000_000_000, 2_000_000_000)
  return cwd
}
const marker = join(dir, 'HELPER_RAN')
const helper = (name, body = 'cat') => {
  const path = join(dir, name)
  put(path, `#!/bin/sh\n: > '${marker}'\n${body}\n`)
  run(dir, ['/bin/chmod', '+x', path])
  return path
}
const reset = () => rmSync(marker, { force: true })
const allReads = (cwd, extra = {}) => [
  read(cwd, TOP_SCRIPT, undefined, extra), read(cwd, STATUS_SCRIPT, undefined, extra),
  read(cwd, NUMSTAT_SCRIPT, undefined, extra), read(cwd, DIFF_SCRIPT, 'f.txt', extra),
  read(cwd, UNTRACKED_SCRIPT, 'untracked.txt', extra),
]
try {
  for (const kind of ['fsmonitor', 'clean', 'external', 'env external', 'textconv']) {
    const cwd = repo()
    const executable = helper(kind.replaceAll(' ', '-'), kind === 'fsmonitor' ? "printf 'token\\0'" : kind === 'textconv' ? 'cat "$1"' : 'cat')
    let extra = {}
    if (kind === 'fsmonitor') must(git(cwd, 'config', 'core.fsmonitor', executable))
    if (kind === 'clean') {
      put(join(cwd, '.gitattributes'), '* filter=x\n')
      must(git(cwd, 'config', 'filter.x.clean', executable))
    }
    if (kind === 'external') must(git(cwd, 'config', 'diff.external', executable))
    if (kind === 'env external') extra = { GIT_EXTERNAL_DIFF: executable }
    if (kind === 'textconv') {
      put(join(cwd, '.gitattributes'), '* diff=tc\n')
      must(git(cwd, 'config', 'diff.tc.textconv', executable))
    }
    reset()
    run(cwd, ['git', ...(kind === 'clean' || kind === 'fsmonitor' ? ['status', '--porcelain'] : ['diff', 'HEAD', '--', 'f.txt'])], extra)
    check(`control: plain git runs ${kind}`, existsSync(marker))
    reset()
    utimesSync(join(cwd, 'f.txt'), 2_100_000_000, 2_100_000_000)
    const results = allReads(cwd, extra)
    check(`all workbench reads suppress ${kind}`, !existsSync(marker) && results.every((r, i) => r.status === (i === 4 ? 1 : 0)))
  }

  const parent = repo()
  const child = repo()
  must(git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'child'))
  must(git(parent, 'add', '.gitmodules', 'child'))
  must(git(parent, 'commit', '-qm', 'submodule'))
  const sub = join(parent, 'child')
  put(join(sub, 'f.txt'), 'submodule change\n')
  must(git(sub, 'config', 'core.fsmonitor', helper('sub-monitor', "printf 'token\\0'")))
  reset()
  git(parent, 'status', '--porcelain', '--ignore-submodules=none')
  check('control: plain status runs a submodule helper', existsSync(marker))
  reset()
  const subReads = allReads(parent)
  check('all workbench reads ignore submodule helpers', !existsSync(marker) && subReads.every((r, i) => r.status === (i === 4 ? 1 : 0)))

  const pathRepo = repo()
  mkdirSync(join(pathRepo, 'bin'))
  put(join(pathRepo, 'bin/git'), `#!/bin/sh\n: > '${marker}'\nexit 99\n`)
  must(run(dir, ['/bin/chmod', '+x', join(pathRepo, 'bin/git')]))
  mkdirSync(join(pathRepo, 'sub'))
  const alias = join(dir, 'alias-bin')
  symlinkSync(join(pathRepo, 'bin'), alias)
  mkdirSync(join(dir, 'innocent'))
  const folded = `${dir}/innocent/../${pathRepo.split('/').at(-1)}/bin`
  for (const entry of ['bin', join(pathRepo, 'bin'), '../bin', alias, folded]) {
    reset()
    const cwd = entry === '../bin' ? join(pathRepo, 'sub') : pathRepo
    const out = read(cwd, TOP_SCRIPT, undefined, { PATH: `${entry}:${env.PATH}` })
    check(`PATH drops ${entry === '../bin' ? 'parent-relative' : entry === 'bin' ? 'relative' : entry === alias ? 'symlink alias' : entry === folded ? 'dot-segment alias' : 'absolute in-repo'} git`, !existsSync(marker) && out.stdout.trimEnd().split('\n')[0] === pathRepo)
  }

  const moved = repo()
  must(git(pathRepo, 'config', 'core.worktree', moved))
  const poisoned = { PATH: `${pathRepo}/bin:${env.PATH}` }
  reset()
  run(moved, ['/bin/bash', '--noprofile', '--norc', '-p', '-c', 'git --version'], poisoned)
  check('control: moved cwd PATH runs the original repository git without a pin', existsSync(marker))
  reset()
  const top = read(pathRepo, TOP_SCRIPT, undefined, poisoned)
  const [movedRoot, binary] = top.stdout.trimEnd().split('\n')
  check('TOP pins an absolute git outside the original repo before core.worktree changes cwd',
    top.status === 0 && movedRoot === moved && binary?.startsWith('/') && !binary.startsWith(`${pathRepo}/`) && !existsSync(marker))
  const scripts = [[STATUS_SCRIPT], [NUMSTAT_SCRIPT], [DIFF_SCRIPT, 'f.txt'],
    [UNTRACKED_SCRIPT, 'untracked.txt'], [STAGE_SCRIPT, 'f.txt'], [UNSTAGE_SCRIPT, 'f.txt']]
  for (const [i, [script, path]] of scripts.entries()) {
    reset()
    const out = read(moved, script, path, poisoned, binary)
    check(`core.worktree pinned ${['status', 'numstat', 'diff', 'untracked diff', 'stage', 'unstage'][i]} never runs repository git`,
      !existsSync(marker) && out.status === (script === UNTRACKED_SCRIPT ? 1 : 0))
  }
  for (const bad of [join(pathRepo, 'bin/git'), `${alias}/git`, `${folded}/git`, 'bin/git', '', join(dir, 'missing-git'), dir]) {
    reset()
    check(`every later script refuses invalid pin ${bad || '(empty)'}`,
      scripts.every(([script, path]) => pinnedRead(pathRepo, script, bad, path, poisoned).status === UNCHECKED) && !existsSync(marker))
  }

  const cwd = repo()
  const other = repo()
  put(join(other, 'other-only'), 'other\n')
  const redirected = { GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other }
  check('GIT_DIR/GIT_WORK_TREE do not change the cwd repo',
    read(cwd, TOP_SCRIPT, undefined, redirected).stdout.trimEnd().split('\n')[0] === cwd
    && !read(cwd, STATUS_SCRIPT, undefined, redirected).stdout.includes('other-only'))

  const wrapperDir = join(dir, 'outside-bin')
  mkdirSync(wrapperDir)
  const realGit = must(run(dir, ['/bin/bash', '-c', 'command -v git'])).trim()
  put(join(wrapperDir, 'git'), `#!/bin/sh\nif [ "$1" = --version ]; then echo 'git version 2.30.0'; exit 0; fi\nfor arg do case "$arg" in status|diff) : > '${marker}';; esac; done\nexec '${realGit}' "$@"\n`)
  must(run(dir, ['/bin/chmod', '+x', join(wrapperDir, 'git')]))
  reset()
  const old = allReads(cwd, { PATH: `${wrapperDir}:${env.PATH}` })
  check('old git reports unchecked for every status/diff without running them', !existsSync(marker) && old.slice(1).every(r => r.status === UNCHECKED))
  must(git(cwd, 'config', 'core.fsmonitor', helper('info-monitor', "printf 'token\\0'")))
  put(join(cwd, '.git/info/attributes'), '* filter=x\n')
  reset()
  check('info/attributes reports unchecked for every status/diff', allReads(cwd).slice(1).every(r => r.status === UNCHECKED) && !existsSync(marker))
  check('outside a repo stays not-a-repo', read(dir, TOP_SCRIPT).status !== 0)

  const normal = repo()
  put(join(normal, 'staged.txt'), 'staged\n')
  must(git(normal, 'add', 'staged.txt'))
  must(git(normal, 'mv', 'rename.txt', 'renamed.txt'))
  const files = parseStatus(read(normal, STATUS_SCRIPT).stdout)
  check('normal modified, staged, untracked and renamed files',
    files.some(f => f.path === 'f.txt' && f.worktree === 'M') && files.some(f => f.path === 'staged.txt' && f.index === 'A')
    && files.some(f => f.path === 'untracked.txt' && f.index === '?') && files.some(f => f.path === 'renamed.txt' && f.index === 'R'))
  const counts = parseNumstat(read(normal, NUMSTAT_SCRIPT).stdout)
  check('numstat counts modified, staged and renamed files', counts.get('f.txt')?.added === 1 && counts.get('f.txt')?.removed === 1
    && counts.get('staged.txt')?.added === 1 && counts.get('renamed.txt')?.added === 0)
  check('tracked diff contains actual text', read(normal, DIFF_SCRIPT, 'f.txt').stdout.includes('+after!'))
  const untracked = read(normal, UNTRACKED_SCRIPT, 'untracked.txt')
  check('untracked diff preserves exit 1 and text', untracked.status === 1 && untracked.stdout.includes('+untracked'))
  const literal = 'a $(touch INJECTED); quote\' file.txt'
  put(join(normal, literal), 'literal\n')
  check('literal path is passed as one positional argument', read(normal, UNTRACKED_SCRIPT, literal).stdout.includes('+literal') && !existsSync(join(normal, 'INJECTED')))

  const staged = repo()
  must(git(staged, 'add', '--', 'f.txt'))
  const expected = must(git(staged, 'write-tree'))
  must(git(staged, 'restore', '--staged', '--', 'f.txt'))
  const restored = must(git(staged, 'write-tree'))
  must(read(staged, STAGE_SCRIPT, 'f.txt'))
  check('stage matches plain git add index', must(git(staged, 'write-tree')) === expected)
  must(read(staged, UNSTAGE_SCRIPT, 'f.txt'))
  check('unstage matches plain git restore --staged index', must(git(staged, 'write-tree')) === restored)
  put(join(staged, '.gitattributes'), '*.txt filter=upper\n')
  must(git(staged, 'config', 'filter.upper.clean', "tr '[:lower:]' '[:upper:]'"))
  must(git(staged, 'add', '--', 'f.txt'))
  const filtered = must(git(staged, 'show', ':f.txt'))
  must(git(staged, 'restore', '--staged', '--', 'f.txt'))
  must(read(staged, STAGE_SCRIPT, 'f.txt'))
  check('explicit stage preserves clean filters and their blob', filtered === 'AFTER!\n' && must(git(staged, 'show', ':f.txt')) === filtered)
  const glob = repo()
  put(join(glob, '*'), 'star\n')
  must(read(glob, STAGE_SCRIPT, '*'))
  check('a file named * stages only itself', must(git(glob, 'diff', '--cached', '--name-only')) === '*\n')
  must(read(glob, UNSTAGE_SCRIPT, '*'))
  check('a file named * unstages only itself', must(git(glob, 'diff', '--cached', '--name-only')) === '')
  const unborn = join(dir, 'unborn')
  mkdirSync(unborn)
  must(git(unborn, 'init', '-q', '-b', 'main'))
  put(join(unborn, 'new.txt'), 'new\n')
  check('unborn HEAD keeps untracked files readable', read(unborn, STATUS_SCRIPT).stdout.includes('?? new.txt')
    && read(unborn, NUMSTAT_SCRIPT).status === 0 && read(unborn, UNTRACKED_SCRIPT, 'new.txt').stdout.includes('+new'))
  must(read(unborn, STAGE_SCRIPT, 'new.txt'))
  check('unborn HEAD can stage and show the new file diff', read(unborn, STATUS_SCRIPT).stdout.includes('A  new.txt')
    && parseNumstat(read(unborn, NUMSTAT_SCRIPT).stdout).get('new.txt')?.added === 1 && read(unborn, DIFF_SCRIPT, 'new.txt').stdout.includes('+new'))
  const sha = repo('sha256')
  put(join(sha, '.gitattributes'), '* filter=x\n')
  must(git(sha, 'config', 'filter.x.clean', helper('sha-filter')))
  reset()
  check('sha256 uses its own empty tree', allReads(sha).every((r, i) => r.status === (i === 4 ? 1 : 0)) && !existsSync(marker))
} catch (error) {
  check(`fixture error: ${error.message}`, false)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log(`workbench real-git: ${passed} pass, ${failed} fail`)
process.exit(failed ? 1 : 0)
