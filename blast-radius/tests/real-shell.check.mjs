// Runs the preview script in a real bash on real folders. The mocked test engine cannot show these.
// Run: node tests/real-shell.check.mjs   (Node 22.6+ with type stripping)
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CONTENT_SCRIPT, DELETE_SCRIPT, FILE_SCRIPT, MAX_LISTED, MIGRATION_SCRIPT, SHELL_ARGV } from '../hooks/script.ts'

const sh = (cwd, cmd) => spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' })
const preview = (cwd, recursive, ...patterns) =>
  spawnSync(SHELL_ARGV[0], [...SHELL_ARGV.slice(1), DELETE_SCRIPT, 'blast-radius', recursive, ...patterns], { cwd, encoding: 'utf8' }).stdout
const fixture = () => mkdtempSync(join(realpathSync(tmpdir()), 'blast-'))
const runScript = (cwd, script, file, options = {}) => spawnSync(SHELL_ARGV[0], [
  ...SHELL_ARGV.slice(1), script, 'blast-radius', file,
], { cwd, encoding: 'utf8', ...options })
const contentBytes = output => output.trim() ? output.trim().split(/\s+/).map(Number) : []

let failed = 0
let passed = 0
const check = (name, ok) => {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}`)
  if (!ok) failed++
  else passed++
}

// Literal file metadata and bounded content previews never evaluate a path or run repo tools.
{
  const dir = fixture()
  try {
    writeFileSync(join(dir, 'text [1].txt'), '\n\nfirst line\nsecond line\n')
    writeFileSync(join(dir, '-file.txt'), 'option-like name')
    writeFileSync(join(dir, '$(touch PWNED).txt'), 'literal name')
    writeFileSync(join(dir, 'binary.bin'), Buffer.from([65, 0, 66]))
    writeFileSync(join(dir, 'one-MB.txt'), Buffer.alloc(1048576, 65))
    writeFileSync(join(dir, 'large.txt'), Buffer.alloc(1048577, 65))
    writeFileSync(join(dir, 'empty.txt'), '')
    mkdirSync(join(dir, 'folder'))
    check('file metadata includes birth, modification and byte size', /^file \d+ \d+ 25$/.test(runScript(dir, FILE_SCRIPT, 'text [1].txt').stdout.trim()))
    check('missing write target is reported as missing', runScript(dir, FILE_SCRIPT, 'new.txt').stdout.trim() === 'missing')
    check('directory write target is reported as a directory', runScript(dir, FILE_SCRIPT, 'folder').stdout.trim() === 'directory')
    const text = runScript(dir, CONTENT_SCRIPT, 'text [1].txt')
    check('text content preserves lines and literal bracket names', text.status === 0 && Buffer.from(contentBytes(text.stdout)).toString() === '\n\nfirst line\nsecond line\n')
    check('binary content preserves NUL bytes', JSON.stringify(contentBytes(runScript(dir, CONTENT_SCRIPT, 'binary.bin').stdout)) === JSON.stringify([65, 0, 66]))
    check('1 MB files are eligible and only 512 bytes are read', contentBytes(runScript(dir, CONTENT_SCRIPT, 'one-MB.txt').stdout).length === 512)
    check('files larger than 1 MB are skipped', runScript(dir, CONTENT_SCRIPT, 'large.txt').stdout.trim() === 'SKIP')
    check('directory content is skipped', runScript(dir, CONTENT_SCRIPT, 'folder').stdout.trim() === 'SKIP')
    writeFileSync(join(dir, '.env'), 'KEY=secret')
    symlinkSync(join(dir, '.env'), join(dir, 'notes.txt'))
    check('a link is never read, even one with a harmless name', runScript(dir, CONTENT_SCRIPT, 'notes.txt').stdout.trim() === 'SKIP')
    check('empty regular files yield zero bytes', runScript(dir, CONTENT_SCRIPT, 'empty.txt').stdout.trim() === '')
    check('option-like file names are safe for stat and head', /^file \d+ \d+ 16$/.test(runScript(dir, FILE_SCRIPT, '-file.txt').stdout.trim()) && Buffer.from(contentBytes(runScript(dir, CONTENT_SCRIPT, '-file.txt').stdout)).toString() === 'option-like name')
    runScript(dir, FILE_SCRIPT, '$(touch PWNED).txt')
    const literal = runScript(dir, CONTENT_SCRIPT, '$(touch PWNED).txt')
    check('file names are never evaluated as shell code', !existsSync(join(dir, 'PWNED')) && Buffer.from(contentBytes(literal.stdout)).toString() === 'literal name')
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const flag = join(dir, 'REPO_TOOL_RAN')
    for (const name of ['stat', 'head', 'od']) {
      writeFileSync(join(bin, name), `#!/bin/sh\ntouch '${flag}'\n`)
      chmodSync(join(bin, name), 0o755)
    }
    const env = { ...process.env, PATH: `${bin}:bin:.:${process.env.PATH}` }
    const metadata = runScript(dir, FILE_SCRIPT, 'text [1].txt', { env })
    const content = runScript(dir, CONTENT_SCRIPT, 'text [1].txt', { env })
    check('repo stat, head and od executables never run', !existsSync(flag) && metadata.status === 0 && content.status === 0 && contentBytes(content.stdout).length === 25)
    const startup = join(dir, 'startup.sh')
    writeFileSync(startup, `touch '${flag}'\n`)
    const startupEnv = { ...process.env, BASH_ENV: startup, ENV: startup,
      'BASH_FUNC_head%%': `() { touch '${flag}'; }` }
    runScript(dir, FILE_SCRIPT, 'text [1].txt', { env: startupEnv })
    runScript(dir, CONTENT_SCRIPT, 'text [1].txt', { env: startupEnv })
    check('file and content shells skip startup files and exported functions', !existsSync(flag))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// The new stat calls support both dialects and discard output from failed attempts.
{
  const dir = fixture()
  try {
    writeFileSync(join(dir, 'f.txt'), 'sample')
    const metadataWith = body => runScript(dir, `stat() { ${body}; }; ${FILE_SCRIPT}`, 'f.txt').stdout.trim()
    check('file metadata tries GNU stat first', metadataWith('if [ "$1" = -c ]; then echo "10 20 6"; else return 1; fi') === 'file 10 20 6')
    check('file metadata falls back to BSD stat without failed stdout', metadataWith('if [ "$1" = -c ]; then echo garbage; return 1; else echo "30 40 6"; fi') === 'file 30 40 6')
    check('file metadata with failed or invalid stat reports unknown values', metadataWith('echo garbage; return 1') === 'file ? ? ?' && metadataWith('echo garbage') === 'file ? ? ?')
    const contentWith = body => runScript(dir, `stat() { ${body}; }; ${CONTENT_SCRIPT}`, 'f.txt')
    const gnu = contentWith('if [ "$1" = -c ]; then echo 6; else return 1; fi')
    const bsd = contentWith('if [ "$1" = -c ]; then echo garbage; return 1; else echo 6; fi')
    check('content size check supports GNU and BSD stat', gnu.status === 0 && bsd.status === 0 && Buffer.from(contentBytes(bsd.stdout)).toString() === 'sample')
    check('failed content stat never reads the file', contentWith('echo garbage; return 1').status !== 0 && contentWith('echo garbage; return 1').stdout.trim() === '')
    check('invalid successful content stat never reads the file', contentWith('echo garbage').status !== 0 && contentWith('echo garbage').stdout.trim() === '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// 1. A quoted [ is a literal name; a file named like an option is not read as one.
{
  const dir = fixture()
  writeFileSync(join(dir, 'Thesis [v2].pdf'), 'x')
  writeFileSync(join(dir, '-delete'), 'x')
  check('quoted [ finds the file', preview(dir, '0', 'Thesis [[]v2].pdf').includes('F Thesis [v2].pdf'))
  check('unquoted glob still matches', preview(dir, '0', 'Thesis*.pdf').includes('F Thesis [v2].pdf'))
  check('-delete is a file, not an option', preview(dir, '0', '-delete').includes('F ./-delete') && existsSync(join(dir, '-delete')))
  rmSync(dir, { recursive: true, force: true })
}

// 2. A submodule's filter never runs (no attributes are read, so the repo is measured, not held).
{
  const dir = fixture()
  const flag = join(dir, 'PWNED')
  const git = 'git -c user.email=a@b.c -c user.name=n'
  sh(dir, `git init -q sub && cd sub && echo a > f.txt && git add . && ${git} commit -qm i`)
  sh(dir, `git init -q outer && cd outer && git -c protocol.file.allow=always submodule add -q ../sub sub && ${git} commit -qm s`)
  sh(dir, `git -C outer/sub config filter.evil.clean 'touch ${flag}; cat' && echo 'f.txt filter=evil' > outer/sub/.gitattributes && echo bb > outer/sub/f.txt`)
  const out = preview(dir, '1', 'outer')
  check('submodule filter did not run', !existsSync(flag))
  check('submodule repo still measured', /^U 1$/m.test(out) && !/^X /m.test(out))
  rmSync(dir, { recursive: true, force: true })
}

// 3. A filter written to the worktree config never runs, and the repo is still measured.
{
  const dir = fixture()
  const flag = join(dir, 'PWNED')
  const git = 'git -c user.email=a@b.c -c user.name=n'
  sh(dir, `git init -q wt && cd wt && git config extensions.worktreeConfig true && git config --worktree filter.evil.clean 'touch ${flag}; cat' && echo 'f.txt filter=evil' > .gitattributes && echo a > f.txt && git add .gitattributes && ${git} commit -qm i && echo bbbbbbbb > f.txt`)
  const out = preview(dir, '1', 'wt')
  check('worktree filter did not run', !existsSync(flag))
  check('worktree repo still measured', /^N 1$/m.test(out) && !/^X /m.test(out))
  rmSync(dir, { recursive: true, force: true })
}

// 4. A plain repo is still measured (the guards do not blind the preview).
{
  const dir = fixture()
  const git = 'git -c user.email=a@b.c -c user.name=n'
  sh(dir, `git init -q r && cd r && echo a > f.txt && git add . && ${git} commit -qm i && echo b > f.txt && echo c > new.txt`)
  const out = preview(dir, '1', 'r')
  check('plain repo counts 1 modified, 1 untracked', /^U 1$/m.test(out) && /^N 1$/m.test(out))
  rmSync(dir, { recursive: true, force: true })
}

// 5. The preview shell skips $BASH_ENV and exported functions.
{
  const dir = fixture()
  const flag = join(dir, 'BASHENV')
  writeFileSync(join(dir, 'be.sh'), `touch '${flag}'\n`)
  writeFileSync(join(dir, 'f.txt'), 'x')
  spawnSync(SHELL_ARGV[0], [...SHELL_ARGV.slice(1), DELETE_SCRIPT, 'blast-radius', '0', 'f.txt'], { cwd: dir, encoding: 'utf8', env: { ...process.env, BASH_ENV: join(dir, 'be.sh') } })
  check('BASH_ENV not sourced', !existsSync(flag))
  rmSync(dir, { recursive: true, force: true })
}

// Dates are bounded across targets, and stat uses the same clean PATH as the other preview tools.
{
  const dir = fixture()
  mkdirSync(join(dir, 'a'))
  mkdirSync(join(dir, 'b'))
  for (let i = 0; i < 205; i++) writeFileSync(join(dir, i < 102 ? 'a' : 'b', `file ${i}.txt`), 'x')
  const out = preview(dir, '1', 'a', 'b')
  check('all 205 files remain listed', out.split('\n').filter(l => l.startsWith('F ')).length === 205)
  check('date collection stops at 200 across targets', out.split('\n').filter(l => l.startsWith('D ')).length === MAX_LISTED)
  check('stat dates include timestamps and paths with spaces', /^D \d+ \d+ [ab]\/file \d+\.txt$/m.test(out))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const flag = join(dir, 'STAT_RAN')
  writeFileSync(join(bin, 'stat'), `#!/bin/sh\ntouch '${flag}'\n`)
  chmodSync(join(bin, 'stat'), 0o755)
  spawnSync(SHELL_ARGV[0], [...SHELL_ARGV.slice(1), DELETE_SCRIPT, 'blast-radius', '1', 'a'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  })
  check('repo stat executable did not run', !existsSync(flag))
  rmSync(dir, { recursive: true, force: true })
}

// Simulate both stat dialects, including failed commands that leave stdout behind.
{
  const dir = fixture()
  writeFileSync(join(dir, 'dated.txt'), 'x')
  const datesWith = body => spawnSync(SHELL_ARGV[0], [
    ...SHELL_ARGV.slice(1), `stat() { ${body}; }; ${DELETE_SCRIPT}`, 'blast-radius', '0', 'dated.txt',
  ], { cwd: dir, encoding: 'utf8' }).stdout.split('\n').filter(l => l.startsWith('D '))
  check('GNU stat is tried first', JSON.stringify(datesWith('if [ "$1" = -c ]; then echo "10 20"; else echo garbage; return 1; fi')) === JSON.stringify(['D 10 20 dated.txt']))
  check('BSD stat fallback discards failed GNU stdout', JSON.stringify(datesWith('if [ "$1" = -c ]; then echo garbage; return 1; else echo "30 40"; fi')) === JSON.stringify(['D 30 40 dated.txt']))
  check('two failed stat attempts report unknown dates without garbage', JSON.stringify(datesWith('echo garbage; return 1')) === JSON.stringify(['D ? ? dated.txt']))
  check('invalid successful stat stdout reports unknown dates', JSON.stringify(datesWith('echo "not a timestamp"')) === JSON.stringify(['D ? ? dated.txt']))
  rmSync(dir, { recursive: true, force: true })
}

// A sha256 repo with attributes rejects the sha1 empty tree; each repo gets its own format's.
{
  const dir = fixture()
  const git = 'git -c user.email=a@b -c user.name=a'
  sh(dir, `git init -q --object-format=sha256 r && cd r && echo '*.x text' > .gitattributes && echo a > f.txt && git add . && ${git} commit -qm i && echo b > f.txt`)
  const out = preview(dir, '1', 'r')
  check('sha256 repo is checked, not reported as X', !/^X /m.test(out) && /^U 1$/m.test(out))
  const mig = spawnSync(SHELL_ARGV[0], [...SHELL_ARGV.slice(1), MIGRATION_SCRIPT], { cwd: join(dir, 'r'), encoding: 'utf8' }).stdout
  check('migration status reads a sha256 repo', /f\.txt/.test(mig) && !/^X$/m.test(mig))
  rmSync(dir, { recursive: true, force: true })
}

// More than 50 repos: the preview says so (M) instead of stopping silently.
{
  const dir = fixture()
  sh(dir, 'for i in $(seq 1 51); do mkdir -p many/r$i && git init -q many/r$i; done')
  const out = preview(dir, '1', 'many')
  check('51 repos print M', /^M many$/m.test(out))
  check('repo list stays capped at 50', out.split('\n').filter(l => l.startsWith('G ')).length === 50)
  const few = preview(dir, '1', 'many/r1')
  check('one repo prints no M', !/^M /m.test(few))
  rmSync(dir, { recursive: true, force: true })
}

// A migration run outside any repo has nothing to check (O); inside .git, git cannot read it (X).
{
  const dir = fixture()
  const mig = cwd => spawnSync(SHELL_ARGV[0], [...SHELL_ARGV.slice(1), MIGRATION_SCRIPT], { cwd, encoding: 'utf8' }).stdout.trim()
  check('migration outside a repo prints O', mig(dir) === 'O')
  sh(dir, 'git init -q r')
  check('migration inside .git prints X', mig(join(dir, 'r', '.git')) === 'X')
  check('migration in a clean repo prints nothing', mig(join(dir, 'r')) === '')
  rmSync(dir, { recursive: true, force: true })
}

console.log(`real-shell: ${passed} pass, ${failed} fail`)
process.exit(failed ? 1 : 0)
