#!/usr/bin/env node
/**
 * Replay: run a delivery judge over calls that really happened.
 *
 * The question this answers is not "does a lesson exist" but "would this rule have put one
 * in front of the agent, on which calls, and how often". It is the offline half of the
 * delivery work; the online half is `tests/delivery.test.ts` (does the hint go out) and the
 * live `delivery` table (did it).
 *
 *   node tools/replay.mjs [--calls <jsonl>] [--store <db>] [--cwd <workspace root>]
 *                         [--judge live|new|both] [--max-doc-freq N] [--json <path>]
 *                         [--only-failed] [--sample N] [--scenarios <json>] [--sweep]
 *
 * The call log comes from `tools/session-calls.py`, which reads DSH session logs. Nothing
 * is written to the store: it is opened read-only, and the judge is a pure function of
 * store contents and one call, exactly as the plugin calls it.
 *
 * `--scenarios` adds the side the call corpus cannot supply: 25 hand-written calls that
 * *should* bring up a named record, each checked as "did the right record come out". That is
 * the recall half; the corpus is the precision half. `--sweep` prints both for a grid of
 * thresholds so the choice of numbers is visible rather than asserted.
 *
 * Two honest caveats, because this tool is easy to over-read:
 *
 *   1. **The store is today's, the calls are the past's.** A call from three days ago is
 *      judged against records written since. That inflates what the judge "would" have
 *      delivered back then, so every rate here is an upper bound on the historical one.
 *   2. **A firing is not a success.** This counts deliveries, not prevented mistakes. The
 *      mistake side is `tools/prevention-ledger.mjs` plus the delivery table.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

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

const root = 'F:\\dsh主工作区\\dsh-experience-memory'
const lib = name => pathToFileURL(join(root, 'lib', name)).href
const callsPath = flag('calls') ?? join(root, 'tools', 'calls.jsonl')
const storePath = flag('store') ?? join(process.env['APPDATA'] ?? '', 'dsh-desktop', 'harness', 'experience-memory', 'memory.db')
// A missing newline here (commit 32568de) made this whole tool a SyntaxError, while the delivery
// doc still told readers to run it to check the numbers. Fixed 2026-09-24; the figures in older
// docs cannot be reproduced from the revision that was actually committed.
const cwd = flag('cwd') ?? 'F:\\dsh主工作区'
const judge = flag('judge') ?? 'both'
const maxDocFrequency = number('max-doc-freq', 2)
const jsonPath = flag('json')
const scenariosPath = flag('scenarios') ?? join(root, 'tools', 'scenarios.json')
const sweep = has('sweep')
const onlyFailed = has('only-failed')
const sampleLimit = number('sample', 12)

if (!existsSync(callsPath)) {
  console.error(`没有调用日志：${callsPath}\n先跑：python tools/session-calls.py --out tools/calls.jsonl`)
  process.exit(2)
}
if (!existsSync(storePath)) {
  console.error(`没有这个库：${storePath}`)
  process.exit(2)
}

const { recallForCallWithIdentifiers } = await import(lib('precall.js'))
const { decideForCall } = await import(lib('criteria.js'))
const { resolveWorkspace } = await import(lib('domain.js'))

const workspace = resolveWorkspace(cwd, '')
const now = Date.now()
const db = new DatabaseSync(storePath, { readOnly: true })

const all = readFileSync(callsPath, 'utf8').split('\n').filter(Boolean).map(line => {
  try { return JSON.parse(line) } catch { return undefined }
}).filter(Boolean)
const calls = onlyFailed ? all.filter(call => call.failed === true) : all

const report = { calls: calls.length, store: storePath, workspace: workspace.root, maxDocFrequency, judged: {} }

const JUDGES = {
  live: {
    label: '旧判据（词汇撞车 + 记录侧稀有）',
    run: (call) => {
      const hit = recallForCallWithIdentifiers(db, workspace.id, workspace.domain, call.arguments, now, { tool: call.name })
      return hit === undefined ? undefined : { record: hit.record, matched: hit.matched, signature: 'lexical' }
    },
  },
  new: {
    label: '新判据（只认记录自己声明的锚点）',
    run: (call) => {
      const decision = decideForCall(db, workspace.id, workspace.domain, call.arguments, now, { tool: call.name })
      return decision === undefined
        ? undefined
        : { record: decision.record, matched: decision.matched, signature: decision.via }
    },
  },
  derived: {
    label: '新判据 + 出处推断的锚点（且记录必须真的讲到这个文件）',
    run: (call) => {
      const decision = decideForCall(db, workspace.id, workspace.domain, call.arguments, now,
        { tool: call.name, derivedAnchors: true, derivedNeedsMention: true })
      return decision === undefined
        ? undefined
        : { record: decision.record, matched: decision.matched, signature: decision.via }
    },
  },
  derivedLoose: {
    label: '出处推断的锚点，不要求记录提到该文件（上一版，留作对照）',
    run: (call) => {
      const decision = decideForCall(db, workspace.id, workspace.domain, call.arguments, now,
        { tool: call.name, derivedAnchors: true, derivedNeedsMention: false })
      return decision === undefined
        ? undefined
        : { record: decision.record, matched: decision.matched, signature: decision.via }
    },
  },
}

const wanted = judge === 'both' ? ['live', 'new', 'derived'] : [judge]

/**
 * The recall side: hand-written calls that should bring up a named record.
 *
 * A miss is counted two ways on purpose — "nothing came out" and "the wrong record came
 * out" are different defects, and collapsing them would hide which one the thresholds
 * trade against.
 */
function runScenarios(name, options) {
  if (!existsSync(scenariosPath)) return undefined
  const spec = JSON.parse(readFileSync(scenariosPath, 'utf8'))
  const judgeFn = JUDGES[name]
  if (judgeFn === undefined) return undefined
  const rows = []
  for (const scenario of spec.cases) {
    let hit
    try { hit = judgeFn.run(scenario, options) } catch { hit = undefined }
    const got = hit?.record?.id
    rows.push({
      id: scenario.id,
      expect: scenario.expect,
      got,
      title: hit?.record?.title ?? '',
      matched: hit?.matched ?? [],
      verdict: got === undefined ? '没送' : got === scenario.expect ? '对' : '送错',
    })
  }
  return rows
}

for (const name of wanted) {
  const spec = JUDGES[name]
  if (spec === undefined) {
    console.error(`未知判据：${name}（可用：live / new / both）`)
    process.exit(2)
  }
  const stats = {
    label: spec.label,
    delivered: 0,
    onFailed: 0,
    failedCalls: 0,
    signatures: {},
    perRecord: new Map(),
    samples: [],
  }
  for (const call of calls) {
    if (call.failed === true) stats.failedCalls += 1
    let hit
    try { hit = spec.run(call) } catch (error) {
      console.error(`  (判据 ${name} 在 ${call.name} 上抛错：${error instanceof Error ? error.message : String(error)})`)
      hit = undefined
    }
    if (hit === undefined) continue
    stats.delivered += 1
    stats.signatures[hit.signature] = (stats.signatures[hit.signature] ?? 0) + 1
    stats.perRecord.set(hit.record.id, (stats.perRecord.get(hit.record.id) ?? 0) + 1)
    if (call.failed === true) {
      stats.onFailed += 1
      if (stats.samples.length < sampleLimit) {
        stats.samples.push({ tool: call.name, record: hit.record.title, matched: hit.matched, signature: hit.signature })
      }
    }
  }
  const ranked = [...stats.perRecord.entries()].sort((a, b) => b[1] - a[1])
  const total = stats.delivered
  const scenarios = runScenarios(name)
  report.judged[name] = {
    label: stats.label,
    calls: calls.length,
    delivered: total,
    deliveryRate: calls.length === 0 ? 0 : total / calls.length,
    failedCalls: stats.failedCalls,
    onFailed: stats.onFailed,
    failedRate: stats.failedCalls === 0 ? 0 : stats.onFailed / stats.failedCalls,
    signatures: stats.signatures,
    distinctRecords: ranked.length,
    topRecords: ranked.slice(0, 5).map(([id, count]) => ({ id, count, share: total === 0 ? 0 : count / total })),
    concentration: total === 0 ? 0 : ranked.slice(0, 3).reduce((sum, [, count]) => sum + count, 0) / total,
    worstRecord: ranked.length === 0 ? 0 : (ranked[0]?.[1] ?? 0),
    samples: stats.samples,
    scenarios: scenarios === undefined ? undefined : {
      total: scenarios.length,
      right: scenarios.filter(r => r.verdict === '对').length,
      wrong: scenarios.filter(r => r.verdict === '送错').length,
      missed: scenarios.filter(r => r.verdict === '没送').length,
      recall: scenarios.length === 0 ? 0 : scenarios.filter(r => r.verdict === '对').length / scenarios.length,
      rows: scenarios,
    },
  }
}

const pct = value => `${(value * 100).toFixed(2)}%`
console.log(`调用日志：${callsPath}（${calls.length} 次${onlyFailed ? '，只看失败调用' : ''}）`)
console.log(`库：${storePath}`)
console.log(`工作区：${workspace.root}（${workspace.id}），域：${workspace.domain || '(空)'}`)
console.log(`记录侧稀有界限值：≤${maxDocFrequency} 条记录\n`)

for (const name of wanted) {
  const r = report.judged[name]
  console.log(`── ${name}：${r.label}`)
  console.log(`   投递次数 ${r.delivered}（占调用 ${pct(r.deliveryRate)}）`)
  console.log(`   失败调用 ${r.failedCalls} 次，其中投到 ${r.onFailed}（${pct(r.failedRate)}）`)
  console.log(`   命中过的记录 ${r.distinctRecords} 条；误触发最多的那条撞了 ${r.worstRecord} 次`)
  console.log(`   前三条记录占了全部投递的 ${pct(r.concentration)}`)
  console.log(`   信号构成：${Object.entries(r.signatures).map(([k, v]) => `${k}=${v}`).join('  ') || '（无）'}`)
  if (r.topRecords.length > 0) {
    console.log('   撞车最多的记录：')
    for (const t of r.topRecords) {
      const row = db.prepare('select title from record where id = ?').get(t.id)
      console.log(`     ${String(t.count).padStart(5)} 次（${pct(t.share)}）  ${String(row?.title ?? '?').slice(0, 58)}`)
    }
  }
  if (r.samples.length > 0) {
    console.log('   失败调用上投出去的样本：')
    for (const s of r.samples) console.log(`     ${String(s.tool).padEnd(12)} [${s.signature}] matched=${s.matched.slice(0, 3).join(',')} → ${String(s.record).slice(0, 52)}`)
  }
  if (r.scenarios !== undefined) {
    console.log(`   场景集（人工标注 ${r.scenarios.total} 条"该送哪条"）：对 ${r.scenarios.right} · 送错 ${r.scenarios.wrong} · 没送 ${r.scenarios.missed} → 召回 ${pct(r.scenarios.recall)}`)
    for (const row of r.scenarios.rows) {
      const mark = row.verdict === '对' ? '✓' : row.verdict === '送错' ? '✗' : '·'
      console.log(`     ${mark} ${row.id.padEnd(24)} ${row.verdict.padEnd(4)} 期望 ${row.expect}${row.got === undefined ? '' : ` 实得 ${row.got}`}  ${String(row.title).slice(0, 40)}`)
    }
  }
  console.log('')
}

if (sweep) {
  console.log('阈值扫描：新判据没有可扫的阈值——它读的是记录自己声明的锚点。')
  console.log('这一栏保留下来是为了说明"调参数"为什么不是答案：旧判据在整条曲线上，')
  console.log('送得少的时候召回也低到不可用（见 docs/DELIVERY-GAPS.md 第十二节实测）。\n')
}

console.log('判据（预注册，见 docs/DELIVERY-GAPS.md 第五节）：投递率 ≤2% · 失败覆盖 ≥15% · 单记录误触发 <300')
for (const name of wanted) {
  const r = report.judged[name]
  const recall = r.scenarios === undefined ? undefined : r.scenarios.recall
  const wrong = r.scenarios === undefined ? 0 : r.scenarios.wrong
  const pass = r.deliveryRate <= 0.02 && r.failedRate >= 0.15 && r.worstRecord < 300 && (recall === undefined || recall >= 0.8)
  console.log(`  ${name}: 投递率 ${pct(r.deliveryRate)} ${r.deliveryRate <= 0.02 ? '✓' : '✗'}`
    + ` · 失败覆盖 ${pct(r.failedRate)} ${r.failedRate >= 0.15 ? '✓' : '✗'}`
    + ` · 最大误触发 ${r.worstRecord} ${r.worstRecord < 300 ? '✓' : '✗'}`
    + (recall === undefined ? '' : ` · 场景召回 ${pct(recall)} ${recall >= 0.8 ? '✓' : '✗'}（送错 ${wrong}）`)
    + `  → ${pass ? '达标' : '未达标'}`)
}

db.close()
if (jsonPath !== undefined) {
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`\n已写入：${jsonPath}`)
}
