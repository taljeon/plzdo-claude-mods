// Importance: which files in a delete would really hurt to lose, said in a few lines.
import type { Highlight } from '../types'
import { MAX_LISTED } from './script'

// Folders a build or an install makes again: losing them costs a reinstall, not work.
const REGENERABLE = /(^|\/)(node_modules|dist|build|out|\.next|\.nuxt|\.turbo|\.cache|__pycache__|\.pytest_cache|\.venv|venv|target|coverage|\.gradle|DerivedData)(\/|$)/

const KINDS: { level: Highlight['level']; label: string; test: RegExp }[] = [
  {
    level: 'high',
    label: '비밀키·환경변수',
    test: /(^|\/)(?![^/]*\.(example|sample|template|dist)$)(\.env(\..+)?|\.npmrc|\.netrc|\.pgpass|\.htpasswd|id_(rsa|ed25519|ecdsa)(\.pub)?|credentials(\.json)?|[^/]+\.(pem|key|p8|p12|pfx|jks|keystore|kdbx|gpg|tfstate))$/i,
  },
  { level: 'high', label: 'SSH·클라우드 설정', test: /(^|\/)(\.ssh\/[^/]+|\.kube\/config|\.aws\/config|\.gnupg\/.+)$/ },
  { level: 'mid', label: '개인 설정 파일', test: /(^|\/)\.(zshrc|zshenv|zprofile|bashrc|bash_profile|profile|gitconfig|vimrc|tmux\.conf)$/ },
  { level: 'mid', label: '노트북·압축', test: /\.(ipynb|zip|7z|tar|gz|tgz|rar|dmg)$/i },
  { level: 'mid', label: '문서', test: /\.(pdf|docx?|hwpx?|xls[xm]?|pptx?|od[tsp]|pages|numbers|md|txt|rtf)$/i },
  // A SQLite -wal or -journal file holds writes not yet in the main file: losing it loses data.
  { level: 'mid', label: '데이터·DB', test: /\.((db|sqlite3?)(-(wal|shm|journal))?|csv|tsv|parquet|sql)$/i },
  { level: 'mid', label: '사진·영상', test: /\.(jpe?g|png|heic|gif|webp|mov|mp4|m4a|mp3|wav)$/i },
  { level: 'low', label: '소스코드', test: /\.(tsx?|jsx?|mjs|cjs|py|java|kt|go|rs|swift|c|cc|cpp|h|rb|php|cs|vue|svelte)$/i },
]

// Scratch space: a file there being new says nothing about its worth.
const SCRATCH = /^(\/private)?\/tmp\/|^\/var\/folders\//

// Git's own files are covered by the repository line; listing them is noise.
const GIT_INTERNAL = /(^|\/)\.git\//

const base = (path: string) => path.slice(path.lastIndexOf('/') + 1)

// The path from the deleted target down (its own name first), so a build/ folder above the target
// (`rm /work/build/.env`) does not make what is deleted look regenerable.
function inside(path: string, roots: string[]): string {
  const root = roots.filter(r => path === r || path.startsWith(`${r.replace(/\/+$/, '')}/`)).sort((a, b) => b.length - a.length)[0]
  if (root === undefined) return base(path)
  const trimmed = root.replace(/\/+$/, '')
  return path === root ? base(path) : `${base(trimmed)}/${path.slice(trimmed.length + 1)}`
}

function examples(paths: string[]): string {
  const names = [...new Set(paths.map(base))]
  return names.slice(0, 3).join(', ') + (names.length > 3 ? ' …' : '')
}

// Paths are listed in the detail rows; keep multiple names out of the UI's highlight row.
function exampleText(label: string, paths: string[]): Pick<Highlight, 'text' | 'uiText'> {
  return { text: `${label}: ${examples(paths)}`, ...(new Set(paths.map(base)).size > 1 ? { uiText: label } : {}) }
}

export type Scan = {
  files: string[]
  dates: { path: string; birth?: number; modified?: number }[]
  // The deleted targets themselves, as the preview found them.
  roots: string[]
  // Files changed in the last 24 hours.
  recent: string[]
  // Git repositories (their .git) inside what is deleted.
  repos: string[]
  // Modified or staged tracked files under what is deleted: their changes are not in any commit.
  uncommitted: number
  // Files git has never seen under what is deleted: no copy anywhere.
  untracked: number
  // Repositories whose own config runs filters, so their changes were not checked.
  unchecked: string[]
  // More than 50 repos under what is deleted: the rest were neither counted nor checked.
  hasMoreRepos?: boolean
  // The file list stopped at its cap, so counts are a floor.
  isCapped: boolean
}

// The few lines a person needs before saying yes, most dangerous first.
export function highlights(scan: Scan, now?: number, offsetMinutes?: number): Highlight[] {
  const out: Highlight[] = []
  const own = scan.files.filter(path => !GIT_INTERNAL.test(path))
  const isRegenerable = (path: string) => REGENERABLE.test(inside(path, scan.roots))
  const kept = own.filter(path => !isRegenerable(path))
  const regenerable = own.length - kept.length
  const more = scan.isCapped ? '+' : ''

  if (scan.repos.length > 0) {
    const names = scan.repos.map(path => base(path.replace(/\/\.git\/?$/, '')))
    out.push({ level: 'high', ...exampleText(`git 저장소 ${scan.repos.length}${scan.hasMoreRepos ? '+' : ''}개가 통째로 삭제됨`, names) })
  }
  if (scan.hasMoreRepos) {
    out.push({ level: 'high', text: '저장소가 50개를 넘어 나머지는 커밋 안 된 변경을 확인 안 함' })
  }
  if (scan.uncommitted > 0) {
    out.push({ level: 'high', text: `커밋 안 된 수정 ${scan.uncommitted}개: git으로도 복구 불가` })
  }
  // `rm .git/index` targets git's own files directly; only a whole-repo delete already says this.
  const gitTargets = scan.roots.filter(root => /(^|\/)\.git(\/|$)/.test(root))
  if (gitTargets.length > 0 && scan.repos.length === 0) {
    out.push({ level: 'high', ...exampleText('git 내부 파일 직접 삭제', gitTargets) })
  }
  if (scan.unchecked.length > 0) {
    out.push({ level: 'high', ...exampleText('변경 사항 확인 안 함(저장소가 자체 실행 설정을 가짐)', scan.unchecked) })
  }
  for (const kind of KINDS) {
    const hits = kept.filter(path => kind.test.test(path))
    if (hits.length > 0) out.push({ level: kind.level, ...exampleText(`${kind.label} ${hits.length}${more}개`, hits) })
  }
  // Context, not a reason to stop on its own: a file the agent just wrote is always new.
  if (scan.untracked > 0) out.push({ level: 'low', text: `git에 없는 새 파일 ${scan.untracked}개` })
  const recent = scan.recent.filter(path => !isRegenerable(path) && !GIT_INTERNAL.test(path) && !SCRATCH.test(path))
  if (recent.length > 0) out.push({ level: 'low', ...exampleText(`24시간 안에 수정한 파일 ${recent.length}${more}개`, recent) })
  if (regenerable > 0) out.push({ level: 'low', text: `재생성 가능(node_modules, build 등) ${regenerable}${more}개` })
  if (now !== undefined) {
    const today = calendar(now, offsetMinutes).day
    const created = scan.dates.filter(d => d.birth !== undefined && calendar(d.birth * 1000, offsetMinutes).day === today).length
    if (created > 0) out.push({ level: 'low', text: `오늘 생성된 파일 ${created}개` })
  }

  return out
}

// A file name that is a secret on its own (.env, id_rsa, *.pem), judged without its folder.
export function isSecretName(name: string, literal = false): boolean {
  return (literal || !/[$`]/.test(name)) && KINDS.some(kind => kind.level === 'high' && kind.test.test(name))
}

// Whether anything here is worth stopping a plain, non-recursive rm for.
export function isWorthHolding(found: Highlight[]): boolean {
  return found.some(one => one.level === 'high' || one.level === 'mid')
}

// Parses the preview script's tagged lines (see the script in register.tsx for the tags).
export function parseScan(stdout: string, cap: number): Scan & { kb: number } {
  const lines = stdout.split('\n')
  const tagged = (tag: string) => lines.filter(line => line.startsWith(`${tag} `)).map(line => line.slice(2))
  const files = tagged('F')
  const timestamp = (value: string, birth: boolean) => {
    const n = Number(value)
    return Number.isFinite(n) && (birth ? n > 0 : n >= 0) ? n : undefined
  }
  const listed = new Set(files.slice(0, MAX_LISTED))
  const dates = tagged('D').flatMap(line => {
    const m = /^(\S+) (\S+) (.*)$/.exec(line)
    return m && listed.delete(m[3]!) ? [{ path: m[3]!, birth: timestamp(m[1]!, true), modified: timestamp(m[2]!, false) }] : []
  }).slice(0, MAX_LISTED)

  return {
    files,
    dates,
    roots: tagged('T'),
    recent: tagged('R'),
    repos: tagged('G'),
    uncommitted: tagged('U').reduce((sum, n) => sum + (Number(n) || 0), 0),
    untracked: tagged('N').reduce((sum, n) => sum + (Number(n) || 0), 0),
    unchecked: tagged('X'),
    hasMoreRepos: tagged('M').length > 0,
    isCapped: files.length >= cap,
    kb: tagged('S').reduce((sum, n) => sum + (Number(n) || 0), 0),
  }
}

// Positive offsets are east of UTC; omitted offsets use the session host's local timezone.
function calendar(ms: number, offsetMinutes?: number): { day: string; time: string } {
  const d = new Date(ms + (offsetMinutes ?? 0) * 60_000)
  const [y, m, day, h, min] = offsetMinutes === undefined
    ? [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()] as const
    : [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()] as const
  const pad = (n: number) => String(n).padStart(2, '0')
  return { day: `${y}/${m}/${day}`, time: `${pad(m)}/${pad(day)} ${pad(h)}:${pad(min)}` }
}

// stat timestamps are seconds, whereas the engine clock is milliseconds.
export function formatDeleteDetail(path: string, birth?: number, modified?: number, offsetMinutes?: number): string {
  const show = (n: number | undefined, isBirth: boolean) => n !== undefined && Number.isFinite(n) && (isBirth ? n > 0 : n >= 0)
    ? calendar(n * 1000, offsetMinutes).time : '?'
  return `${path}  생성 ${show(birth, true)} · 수정 ${show(modified, false)}`
}
