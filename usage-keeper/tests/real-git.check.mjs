// Runs the handoff's git read in a real bash on real repos. The mocked test engine cannot show these.
// Run: node tests/real-git.check.mjs   (Node 22.6+ with type stripping)
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GIT_STATE_SCRIPT, parseGitState, SHELL_ARGV } from '../hooks/handoff.ts'

const sh = (cwd, cmd) => spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' })
const read = cwd => spawnSync(SHELL_ARGV[0], [...SHELL_ARGV.slice(1), GIT_STATE_SCRIPT], { cwd, encoding: 'utf8' })
const git = 'git -c user.email=a@b.c -c user.name=n'
let failed = 0
const check = (name, ok) => {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}`)
  if (!ok) failed++
}

const dir = mkdtempSync(join(realpathSync(tmpdir()), 'handoff-'))
try {
  check('outside a repo prints nothing', read(dir).stdout === '' && read(dir).status === 0)

  sh(dir, `git init -q -b main r && cd r && echo a > f.txt && git add . && ${git} commit -qm first && echo b > f.txt && echo c > new.txt`)
  const r = parseGitState(read(join(dir, 'r')).stdout)
  check('branch, last commit, no upstream, two changed files', r?.branch === 'main' && /^[0-9a-f]+ first$/.test(r.head) && r.ahead === '?' && r.files.length === 2 && !r.isUnchecked)

  sh(dir, `git init -q --object-format=sha256 s && cd s && echo '*.x text' > .gitattributes && echo a > f.txt && git add . && ${git} commit -qm i && echo b > f.txt`)
  const s = parseGitState(read(join(dir, 's')).stdout)
  check('sha256 repo with attributes is read', s?.files.length === 1 && !s.isUnchecked)

  // Same size, new mtime: status must re-read the file, so a plain `git status` runs the clean filter.
  const control = join(dir, 'CONTROL_RAN')
  const flag = join(dir, 'FILTER_RAN')
  sh(dir, `git init -q e && cd e && echo 'f.txt filter=evil' > .gitattributes && echo a > f.txt && git add . && ${git} commit -qm i`)
  sh(join(dir, 'e'), `git config filter.evil.clean 'touch ${control}; cat' && touch -t 203001010000 f.txt && git status --porcelain`)
  check('control: plain git status runs the filter', existsSync(control))
  sh(join(dir, 'e'), `git config filter.evil.clean 'touch ${flag}; cat' && touch -t 203101010000 f.txt`)
  read(join(dir, 'e'))
  check('repo filter did not run', !existsSync(flag))
} finally {
  rmSync(dir, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
