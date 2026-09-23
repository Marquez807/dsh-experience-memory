#!/usr/bin/env node
/**
 * One command that answers "what is the state of this work", from live sources only.
 *
 * Everything here is read, not asserted: the store, the code, the corpus, the git state. Written
 * so the acceptance claims in the handoff can be re-checked in one go instead of trusted.
 *
 *   node tools/status-report.mjs --cwd <workspace root>
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { defaultDbPath } from '../lib/db.js'
import { resolveWorkspace } from '../lib/domain.js'

const args = process.argv.slice(2)
const at = args.indexOf('--cwd')
const cwd = at === -1 ? process.cwd() : args[at + 1]
const root = join(process.cwd())
const lib = name => pathToFileURL(join(root, 'lib', name)).href

const workspace = resolveWorkspace(cwd, '')
const storePath = defaultDbPath()
console.log('=== 记忆框架：状态体检 ===')
console.log(`工作区 ${workspace.root}`)
console.log(`库     ${storePath}`)

if (!existsSync(storePath)) {
  console.log('库不存在——框架还没在这个 home 下跑过。')
  process.exit(0)
}

const { recordAnchors } = await import(lib('criteria.js'))
const db = new DatabaseSync(storePath, { readOnly: true })
const rows = db.prepare(
  `SELECT id, title, trigger, source_ref, status, superseded_by, expires_at, scope, workspace_id, domain
     FROM record WHERE status = 'confirmed' AND superseded_by IS NULL ORDER BY created_at DESC`,
).all()
const now = Date.now()
const eligible = rows.filter(r =>
  (r.scope !== 'workspace' || r.workspace_id === workspace.id
    || (workspace.domain !== '' && r.domain === workspace.domain))
  && (r.expires_at === null || Number(r.expires_at) > now))
// Split by how the anchor arrived: a *declared* one is what the delivery gate uses, a *derived*
// one only fires when `derivedAnchors` is switched on and the production path does not switch it
// on. Collapsing the two made this tool report 64 anchors where the plugin's own tool said 9 —
// both numbers were right about different things and the label was missing.
const declaredCount = eligible.filter(r => recordAnchors(
  { trigger: String(r.trigger ?? ''), sourceRef: String(r.source_ref ?? '') },
  { derived: true },
).via === 'declared').length
const derivedCount = eligible.filter(r => {
  const a = recordAnchors({ trigger: String(r.trigger ?? ''), sourceRef: String(r.source_ref ?? '') }, { derived: true })
  return a.via === 'derived' && a.anchors.length > 0
}).length

const total = db.prepare('SELECT COUNT(*) n FROM record').get().n
const confirmed = db.prepare("SELECT COUNT(*) n FROM record WHERE status='confirmed'").get().n
const index = db.prepare('SELECT COUNT(*) n FROM record_fts').get().n
const orphans = db.prepare('SELECT COUNT(*) n FROM record_fts f WHERE NOT EXISTS (SELECT 1 FROM record r WHERE r.id = f.id)').get().n
const dangling = db.prepare('SELECT COUNT(*) n FROM record r WHERE r.superseded_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM record x WHERE x.id = r.superseded_by)').get().n
const delivery = db.prepare('SELECT COUNT(*) n FROM delivery').get().n
db.close()

console.log('')
console.log('--- 库 ---')
console.log(`记录 ${total}（已确认 ${confirmed}）；本工作区可投递 ${eligible.length}`)
console.log(`  其中动手前**真会送**的（自己声明的锚点）：${declaredCount}`)
console.log(`  有备用锚点但默认不启用的（从出处推断）：${derivedCount}`)
console.log(`  动手前永远静默的：${eligible.length - declaredCount - derivedCount}`)
console.log(`索引 ${index} 行（孤儿 ${orphans}）；悬空引用 ${dangling}；投递痕迹 ${delivery} 行`)

console.log('')
console.log('--- 代码 ---')
try {
  const check = execFileSync('node', [join(root, 'tools', 'build.mjs'), '--check'], { encoding: 'utf8' })
  console.log(check.trim().split('\n').pop())
} catch (error) {
  console.log('构建检查失败：', String(error.stdout ?? error.message).slice(0, 160))
}
try {
  const git = execFileSync('git', ['log', '--oneline', '-1'], { cwd: root, encoding: 'utf8' }).trim()
  const ahead = execFileSync('git', ['rev-list', '--count', 'origin/main..HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  console.log(`最后提交 ${git}；未推送 ${ahead} 个`)
} catch {
  console.log('（读不到 git 状态）')
}

console.log('')
console.log('--- 判据（预注册，见 docs/DELIVERY-GAPS.md 第五节）---')
console.log('投递率 ≤2% · 单记录误触发 <300 · 每轮固定开销不变')
console.log('（原第四条「失败覆盖 ≥15%」已于 2026-09-23 13:00 撤除，换成「这条经验写下之后，同类事件还犯不犯」——见第五节末尾）')
console.log('同坑有经验时正确率显著更高：单轮 0/12 → 9/12，跨会话 0/6 → 5/6；第二场景 0/6 → 6/6（docs §19、§21、§22）')
console.log('')
console.log('回放这四个数：node tools/replay.mjs --judge both')
console.log('看覆盖率三个分母：node tools/coverage-honest.mjs')
console.log('看锚点覆盖：node tools/anchors.mjs --cwd <workspace>')
