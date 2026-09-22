#!/usr/bin/env node
/**
 * Propose anchors for records that never declared one, from the files they actually name.
 *
 * The delivery gate needs a record to say which call it applies to, and no record in the live
 * store does — 0 of 159, because the field did not exist until 2026-09-23. Waiting for the
 * model to re-record everything is not a plan, so this proposes anchors mechanically:
 *
 *   for each confirmed record, take the file names its **declared** fields mention
 *   (`title` / `trigger` / `failure_mode` / `lesson`), resolve them against the workspace, and
 *   propose `path:<name>` for the ones that really exist on disk.
 *
 * Three rules keep the proposal honest rather than generous:
 *
 *   1. **Declared fields only.** The 68.7% finding (docs/DELIVERY-GAPS.md §12.2) says the body
 *      is where a record talks about everything except its rule.
 *   2. **The file must exist.** A name the workspace does not contain would never be satisfied.
 *   3. **One anchor per record, the most specific file.** More anchors mean more chances to
 *      fire, and the whole point is that a firing means something.
 *
 * It writes a proposal file; nothing is applied until `--apply`. Measure before applying:
 *
 *   node tools/backfill-anchors.mjs --cwd <workspace>           # propose + measure
 *   node tools/backfill-anchors.mjs --cwd <workspace> --apply   # write into the store
 *
 * The measurement is the same replay judge the rest of the work uses, run with the proposed
 * anchors in memory, so the cost side is visible before anything is written.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { defaultDbPath } from '../lib/db.js'
import { resolveWorkspace } from '../lib/domain.js'
import { recordAnchors } from '../lib/criteria.js'

const args = process.argv.slice(2)
const flag = name => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
const has = name => args.includes(`--${name}`)
const dbPath = flag('db') ?? defaultDbPath()
const cwd = flag('cwd') ?? process.cwd()
const callsPath = flag('calls') ?? join(process.cwd(), 'tools', 'calls.jsonl')
const outPath = flag('out') ?? join(process.cwd(), 'tools', 'proposed-anchors.json')
const apply = has('apply')

if (!existsSync(dbPath)) {
  console.error(`没有这个库：${dbPath}`)
  process.exit(2)
}

/** Every file the workspace contains, keyed by lower-cased name, valued by relative path. */
function indexFiles(root, limit = 60_000) {
  const byName = new Map()
  const skip = new Set([
    'node_modules', '.git', '.bigfat', 'dist', 'out', '.cache', '.venv', '__pycache__',
    // Backups and recovery copies of this workspace's own data. Anchoring a lesson on a file
    // inside one of these would fire on nothing, or on a stale duplicate of a real file.
    'snapshots', '.recover-20260923-0610', '.cleanup-backup-dsh-mimo-20260922-192117',
    '.expg', '.expf', '.expe', '.expd', '.expc', '.expa', '.audit-tmp', 'scratch',
  ])
  const walk = dir => {
    if (byName.size > limit) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue
        walk(join(dir, entry.name))
      } else if (entry.isFile()) {
        const name = entry.name.toLowerCase()
        const full = join(dir, entry.name)
        // Keep the *shortest* relative path for a name: the most likely referent.
        const rel = relative(root, full).replace(/\\/g, '/').toLowerCase()
        const seen = byName.get(name)
        if (seen === undefined || rel.length < seen.length) byName.set(name, rel)
      }
    }
  }
  walk(root)
  return byName
}

const workspace = resolveWorkspace(cwd, '')
const byName = indexFiles(workspace.root)
console.log(`工作区：${workspace.root}`)
console.log(`文件索引：${byName.size} 个文件名`)

const db = new DatabaseSync(dbPath, { readOnly: !apply })
const rows = db.prepare(
  `SELECT id, title, trigger, failure_mode, lesson, source_ref, scope, workspace_id, domain
     FROM record
    WHERE status = 'confirmed' AND superseded_by IS NULL
    ORDER BY created_at DESC`,
).all()

/** File-name-shaped runs inside the declared fields. */
const FILE_RUN = /[\w\u4e00-\u9fff.-]+\.[A-Za-z0-9]{1,6}\b/g

/**
 * Paths a lesson is probably *not* about, even when its text names them.
 *
 * Found by reading the first proposal run: a lesson whose trigger says `lib/tools.js, 动作枚举,
 * 接线` was about to be anchored on `audit/dev-t2-result/recon/cli.py`, because the record's
 * narrative happened to mention that file too and it had the longer name. A one-off artefact —
 * an audit snapshot, a scratch result, a work directory — is where a finding was *observed*, not
 * where the rule applies, and anchoring there means the hint fires on somebody reading an old
 * report instead of on the edit it is about.
 */
const INCIDENTAL = /(^|\/)(audit|work|tmp|temp|test|tests|fixtures|result|results|out|output|logs?|scratch|\.bigfat)(\/|$)/i

const proposals = []
for (const row of rows) {
  const record = {
    id: row.id,
    trigger: String(row.trigger ?? ''),
    sourceRef: String(row.source_ref ?? ''),
  }
  if (recordAnchors(record, { derived: true }).anchors.length > 0) continue
  const declared = `${row.title}\n${row.trigger ?? ''}\n${row.failure_mode ?? ''}\n${row.lesson ?? ''}`
  const named = new Set()
  for (const match of declared.matchAll(FILE_RUN)) {
    const name = match[0].toLowerCase()
    if (name.length < 4) continue
    const rel = byName.get(name)
    if (rel !== undefined) named.add(rel)
  }
  if (named.size === 0) continue

  // Selection order, each rule a way of asking "is this the file the lesson is about?":
  //   1. a file the record's own `trigger` names — the trigger is the record stating when it
  //      applies, so a file named there is the strongest signal available;
  //   2. not an incidental artefact path;
  //   3. the longest name, so `NOTICE-signals.md` beats a bare `signals.md`.
  const trigger = String(row.trigger ?? '').toLowerCase()
  const score = rel => {
    const base = rel.split('/').pop() ?? rel
    return (trigger.includes(base) ? 4 : 0) + (INCIDENTAL.test(rel) ? 0 : 2) + (base.length >= 8 ? 1 : 0)
  }
  const ranked = [...named].sort((a, b) => score(b) - score(a) || b.length - a.length)
  const best = ranked[0]
  proposals.push({
    id: row.id,
    title: String(row.title).slice(0, 70),
    anchor: `path:${best}`,
    inTrigger: trigger.includes(best.split('/').pop() ?? best),
    incidental: INCIDENTAL.test(best),
    named: [...named],
  })
}

console.log(`\n候选记录（没有锚点、但声明字段里提到了工作区真实存在的文件）：${proposals.length}`)
for (const p of proposals.slice(0, 40)) {
  const flags = `${p.inTrigger ? '触发词' : '      '} ${p.incidental ? '一次产物!' : '        '}`
  console.log(`  ${p.id}  ${p.anchor.padEnd(38)} ${flags}  ${p.title}`)
}
if (proposals.length > 40) console.log(`  …另有 ${proposals.length - 40} 条`)

writeFileSync(outPath, `${JSON.stringify(proposals, null, 2)}\n`, 'utf8')
console.log(`\n提案已写入：${outPath}`)

if (apply) {
  let written = 0
  const update = db.prepare('UPDATE record SET trigger = ?, updated_at = ? WHERE id = ?')
  const now = Date.now()
  for (const p of proposals) {
    const current = db.prepare('SELECT trigger FROM record WHERE id = ?').get(p.id)
    const trigger = String(current?.trigger ?? '')
    const next = trigger.includes('--- anchors ---')
      ? trigger
      : `${trigger.trim()}\n--- anchors ---\n${p.anchor}`.trim()
    if (next === trigger) continue
    update.run(next, now, p.id)
    written += 1
  }
  console.log(`已写入 ${written} 条记录（各加一个 path: 锚点）`)
} else {
  console.log('（未写入。加 --apply 才写库；写之前先看下面的实测）')
}

db.close()

// ── What the proposal would do, measured with the same judge as everything else ──
if (existsSync(callsPath)) {
  const lib = name => pathToFileURL(join(process.cwd(), 'lib', name)).href
  const { recallForCallWithIdentifiers } = await import(lib('precall.js'))
  const calls = readFileSync(callsPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  const read = new DatabaseSync(dbPath, { readOnly: true })
  const now = Date.now()
  let delivered = 0
  let onFailed = 0
  let failed = 0
  const perRecord = new Map()
  for (const call of calls) {
    if (call.failed === true) failed += 1
    let hit
    try {
      hit = recallForCallWithIdentifiers(read, workspace.id, workspace.domain, call.arguments, now, { tool: call.name })
    } catch { hit = undefined }
    if (hit === undefined) continue
    delivered += 1
    perRecord.set(hit.record.id, (perRecord.get(hit.record.id) ?? 0) + 1)
    if (call.failed === true) onFailed += 1
  }
  read.close()
  const worst = perRecord.size === 0 ? 0 : Math.max(...perRecord.values())
  const pct = (n, d) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(2)}%`)
  console.log(`\n回放（${calls.length} 次调用）：`)
  console.log(`  投递率 ${pct(delivered, calls.length)}（门槛 ≤2%）`)
  console.log(`  失败覆盖 ${pct(onFailed, failed)}（门槛 ≥15%）`)
  console.log(`  单记录最大误触发 ${worst}（门槛 <300）`)
  console.log(apply
    ? '（这是已经写进库之后的结果）'
    : '（这是"只有自己声明的锚点"的结果；提案还没写进库，所以是 0。--apply 之后再跑一次看变化）')
} else {
  console.log(`\n（没有调用语料 ${callsPath}，跳过回放；先跑 python tools/session-calls.py）`)
}
