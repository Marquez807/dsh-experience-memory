#!/usr/bin/env node
/**
 * Failure coverage: which records *should* have fired before a call that failed, and why they
 * did not.
 *
 * The pre-registered bar asks for anchors that reach ≥15% of the failures in the call corpus.
 * Coverage is not something taste can raise: a record covers a failure only if the call that
 * failed satisfies an anchor the record declares. So this tool works backwards from the
 * failures and proposes, per record, the anchor that would have reached the failures whose
 * arguments actually contain that record's subject.
 *
 * It is deliberately conservative about what counts as evidence:
 *
 *   - a failure is a call the harness marked `isError`, not a call that looks unhappy;
 *   - the anchor must come from **the failed call's own arguments** — the subject has to be
 *     genuinely in the call, not inferred from the topic;
 *   - the record must already name that subject in its **declared** fields, which is the same
 *     standard the delivery gate applies at run time.
 *
 * What it produces is a proposal, ranked by how many failures the anchor would reach, with the
 * underlying (failure, record, token) rows kept so a reader can reject any of them. `--apply`
 * writes the ones with at least `--min-failures` supporting failures.
 *
 *   node tools/coverage-candidates.mjs --cwd <workspace> [--min-failures 2] [--apply] [--out file]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { defaultDbPath } from '../lib/db.js'
import { resolveWorkspace } from '../lib/domain.js'
import { callFacts } from '../lib/anchors.js'
import { recordAnchors } from '../lib/criteria.js'
import { baseNameOf } from '../lib/anchors.js'
import { identifierKey, tokenize } from '../lib/tokenize.js'

const args = process.argv.slice(2)
const flag = name => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
const has = name => args.includes(`--${name}`)
const number = (name, fallback) => {
  const raw = flag(name)
  const parsed = raw === undefined ? Number.NaN : Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

const dbPath = flag('db') ?? defaultDbPath()
const cwd = flag('cwd') ?? process.cwd()
const callsPath = flag('calls') ?? join(process.cwd(), 'tools', 'calls.jsonl')
const outPath = flag('out') ?? join(process.cwd(), 'tools', 'coverage-candidates.json')
const minFailures = number('min-failures', 2)
const apply = has('apply')

for (const [what, path] of [['库', dbPath], ['调用语料', callsPath]]) {
  if (!existsSync(path)) {
    console.error(`没有${what}：${path}`)
    process.exit(2)
  }
}

const workspace = resolveWorkspace(cwd, '')
const db = new DatabaseSync(dbPath, { readOnly: !apply })
const calls = readFileSync(callsPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
const failures = calls.filter(call => call.failed === true)
console.log(`工作区：${workspace.root}`)
console.log(`调用 ${calls.length}，其中失败 ${failures.length}（${(failures.length / calls.length * 100).toFixed(2)}%）`)

const pool = db.prepare(
  `SELECT id, title, trigger, failure_mode, lesson, source_ref, scope, workspace_id, domain
     FROM record WHERE status = 'confirmed' AND superseded_by IS NULL`,
).all()

/** Records that cannot fire yet, with the tokens their declared fields actually name. */
const candidates = []
for (const row of pool) {
  const record = { id: row.id, trigger: String(row.trigger ?? ''), sourceRef: String(row.source_ref ?? '') }
  if (recordAnchors(record, { derived: true }).anchors.length > 0) continue
  const declared = `${row.title}\n${row.trigger ?? ''}\n${row.failure_mode ?? ''}\n${row.lesson ?? ''}`
  candidates.push({ row, terms: new Set(tokenize(declared)) })
}
console.log(`没有锚点的记录：${candidates.length}`)

/** For each failure, the anchors that would have reached it. */
const rows = []
for (const call of failures) {
  const facts = callFacts(String(call.name ?? ''), call.arguments)
  const fileNames = new Set(facts.paths.map(path => baseNameOf(path)).filter(name => name !== ''))
  for (const { row, terms } of candidates) {
    // A path anchor: the failure touched that exact file *and* the record names it.
    for (const name of fileNames) {
      if (!terms.has(name)) continue
      rows.push({ record: row.id, title: String(row.title).slice(0, 70), anchor: `path:${name}`, tool: call.name, kind: 'path' })
    }
    // A tool anchor: the record names the tool, and the tool is rare enough to mean something.
    const tool = String(call.name ?? '').toLowerCase()
    if (tool !== '' && terms.has(tool)) {
      rows.push({ record: row.id, title: String(row.title).slice(0, 70), anchor: `tool:${tool}`, tool: call.name, kind: 'tool' })
    }
    // A command anchor: the first word of the call's command line, if the record names it.
    const verb = (facts.command.match(/^[\s&|;(]*([a-z][a-z0-9_-]{3,})/i) ?? [])[1]
    if (verb !== undefined && terms.has(verb.toLowerCase())) {
      rows.push({ record: row.id, title: String(row.title).slice(0, 70), anchor: `command:${verb.toLowerCase()}`, tool: call.name, kind: 'command' })
    }
  }
}

/** Rank by how many *distinct failures* an anchor would reach. */
const byAnchor = new Map()
for (const row of rows) {
  const key = `${row.record}|${row.anchor}`
  const entry = byAnchor.get(key) ?? { ...row, failures: 0, tools: new Set() }
  entry.failures += 1
  entry.tools.add(row.tool)
  byAnchor.set(key, entry)
}
const ranked = [...byAnchor.values()]
  .map(entry => ({ ...entry, tools: [...entry.tools] }))
  .sort((a, b) => b.failures - a.failures)

console.log(`\n候选锚点（按能覆盖的失败次数排序，至少 ${minFailures} 次才考虑）：`)
let proposals = 0
for (const entry of ranked.slice(0, 40)) {
  const keep = entry.failures >= minFailures
  if (keep) proposals += 1
  console.log(`  ${keep ? '✓' : ' '} ${String(entry.failures).padStart(3)} 次  ${entry.anchor.padEnd(30)} ${entry.title}`)
  console.log(`       失败时用的工具：${entry.tools.join(', ')}`)
}
const kept = ranked.filter(entry => entry.failures >= minFailures)
console.log(`\n过线的候选：${kept.length} 条（覆盖 ${kept.reduce((sum, e) => sum + e.failures, 0)} 次失败调用）`)

writeFileSync(outPath, `${JSON.stringify({ failures: failures.length, kept, all: ranked }, null, 2)}\n`, 'utf8')
console.log(`已写入：${outPath}`)

if (apply) {
  const update = db.prepare('UPDATE record SET trigger = ?, updated_at = ? WHERE id = ?')
  const now = Date.now()
  const seen = new Set()
  let written = 0
  for (const entry of kept) {
    if (seen.has(entry.record)) continue
    seen.add(entry.record)
    const current = db.prepare('SELECT trigger FROM record WHERE id = ?').get(entry.record)
    const trigger = String(current?.trigger ?? '')
    if (trigger.includes('--- anchors ---')) continue
    update.run(`${trigger.trim()}\n--- anchors ---\n${entry.anchor}`.trim(), now, entry.record)
    written += 1
  }
  console.log(`\n已写入 ${written} 条记录`)
} else {
  console.log('（未写入。加 --apply 才写库。）')
}
db.close()

// ── What the proposal buys, measured with the shipped judge ──
const lib = name => pathToFileURL(join(process.cwd(), 'lib', name)).href
const { recallForCallWithIdentifiers } = await import(lib('precall.js'))
const read = new DatabaseSync(dbPath, { readOnly: true })
const now = Date.now()
let delivered = 0
let onFailed = 0
const perRecord = new Map()
for (const call of calls) {
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
console.log('\n回放（与 docs/DELIVERY-GAPS.md 第五节同一批门槛）：')
console.log(`  投递率 ${pct(delivered, calls.length)}（≤2%）`)
console.log(`  失败覆盖 ${pct(onFailed, failures.length)}（≥15%）`)
console.log(`  单记录最大误触发 ${worst}（<300）`)
console.log(apply ? '（已写库之后的结果）' : '（提案未写库，所以这是现状）')
