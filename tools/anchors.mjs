#!/usr/bin/env node
/**
 * Anchor coverage: how many records can be delivered at the moment of action, and why not
 * for the ones that cannot.
 *
 * Since the anchors change, a record is delivered just before a tool call only if it says
 * where it applies (`path:` / `tool:` / `command:`), or if it was verified against a code
 * file whose name can stand in for that. Everything else is silent by design. This tool
 * prints that split for a real store, so "why did that lesson never appear" has an answer
 * that is not a guess.
 *
 *   node tools/anchors.mjs [--db <path>] [--cwd <workspace root>] [--out <md path>]
 *
 * Read-only.
 */
import { existsSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { defaultDbPath } from '../lib/db.js'
import { resolveWorkspace } from '../lib/domain.js'
import { recordAnchors } from '../lib/criteria.js'
import { ANCHOR_COST_TABLE } from '../lib/anchor-cost-table.js'
import { overCostAnchors } from '../lib/anchor-cost.js'

const args = process.argv.slice(2)
const flag = name => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
const dbPath = flag('db') ?? defaultDbPath()
const cwd = flag('cwd') ?? process.cwd()
const outPath = flag('out')

if (!existsSync(dbPath)) {
  console.error(`没有这个库：${dbPath}`)
  process.exit(2)
}

const workspace = resolveWorkspace(cwd, '')
const now = Date.now()
const db = new DatabaseSync(dbPath, { readOnly: true })

let records
try {
  records = db.prepare(
    `SELECT id, title, trigger, source_ref, workspace_id, domain, scope, status, superseded_by, expires_at, created_at
       FROM record
      WHERE status = 'confirmed' AND superseded_by IS NULL AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at DESC`,
  ).all(now)
} finally {
  db.close()
}

const visibleTo = row => row.scope !== 'workspace'
  || row.workspace_id === workspace.id
  || (workspace.domain !== '' && row.domain === workspace.domain)

const pool = records.filter(visibleTo).map(row => ({
  id: row.id,
  title: String(row.title),
  createdAt: Number(row.created_at),
  sourceRef: String(row.source_ref ?? ''),
  // `derived: true` is what makes the source_ref fallback visible at all. Without it the
  // derived count silently reads 0 and the tool under-reports the store — which is exactly
  // what happened the first time it ran.
  ...recordAnchors({
    trigger: String(row.trigger ?? ''),
    sourceRef: String(row.source_ref ?? ''),
  }, { derived: true }),
}))

const declared = pool.filter(row => row.via === 'declared')
const derived = pool.filter(row => row.via === 'derived' && row.anchors.length > 0)
const silent = pool.filter(row => row.anchors.length === 0)

// ── 存量锚点的成本审计（2026-09-25 加）───────────────────────────────────────
// 为什么要有这一段：成本闸门（`anchorCostTable`）只在**写入时**生效，所以**闸门存在之前写的记录
// 会被祖父条款放行**。实测就这么撞上过：4 条记录带着 `tool:pwsh`（命中 5,936 = 全部调用的 37.3%），
// 闸门建好之后它们照样在库里、照样在几乎每次 shell 调用上参与投递。
// 当时是用一段临时脚本查出来的——临时脚本会丢，所以固化到这里：**只看存量，不改任何东西**。
// 判据本身在 `src/anchor-cost.ts:overCostAnchors` —— 和写入闸门同一张表、同一个界限值、同一套比较，
// 免得审计脚本自己再实现一遍（两处实现必然分叉）。
const costThreshold = ANCHOR_COST_TABLE.thresholdHits ?? 300
const overCost = declared.flatMap(row =>
  overCostAnchors(row.anchors).map(found => ({ id: row.id, title: row.title, ...found })))

const pct = (n, d) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`)
const stamp = ms => new Date(Number(ms)).toLocaleString('sv-SE').slice(0, 16)
const clip = (text, max) => {
  const clean = String(text).replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}

const lines = []
const say = text => lines.push(text === undefined ? '' : text)

say('# 锚点覆盖：多少条经验在动手前送得出去')
say('')
say(`- 库：\`${dbPath}\``)
say(`- 工作区：\`${workspace.root}\`（标识 \`${workspace.id}\`）`)
say(`- 生成时间：${stamp(now)}`)
say('')
say('## 结论')
say('')
say(`- 有资格被投递的记录：**${pool.length}** 条（已确认、未被取代、未过期、本工作区可见）`)
say(`- **自己声明了锚点**（写记录时填了"以后什么调用该把它端出来"）：**${declared.length}** 条（${pct(declared.length, pool.length)}）`)
say(`- **由出处推断出锚点**（出处是代码/配置文件，用那个路径当锚点）：**${derived.length}** 条（${pct(derived.length, pool.length)}）`)
say(`- **没有任何锚点、动手前永远静默**：**${silent.length}** 条（${pct(silent.length, pool.length)}）`)
say(`- **存量里"太宽"的锚点（写入闸门管不到的老记录）**：**${overCost.length}** 个${overCost.length > 0 ? ' ⚠️ 见下面一节' : ''}`)
say('')
say(`**只有"自己声明"的那 ${declared.length} 条会在动手前真的送出去。** 推断出来的那 ${derived.length} 条`)
say('是备用的一档：默认**关着**（`decideForCall` 的 `derivedAnchors` 选项，生产路径不传它），')
say('而且即使打开也只在调用**要动那个文件**（edit/write）时才生效——实测它会把"记录提到过这个文件"')
say('当成"这条记录讲的就是这次改动"，单条撞过 247 次，所以默认不开。要复核：')
say('`node tools/replay.mjs --judge derived`。')
say('因为"这个文件在记录的出处里"比"这条记录讲的就是这个文件"弱一档。')
say('')

if (declared.length > 0) {
  say('## 自己声明了锚点的记录')
  say('')
  for (const row of declared) {
    say(`- \`${row.id}\` ${clip(row.title, 66)}`)
    say(`  - 锚点：${row.anchors.map(a => `\`${a.kind}:${a.token}\``).join('、')}`)
  }
  say('')
}

// 存量里"太宽"的锚点。不改库、只报出来 —— 修法在下面写清楚，人决定。
say('## 存量里"太宽"的锚点（写入闸门管不到的老记录）')
say('')
if (overCost.length === 0) {
  say(`没有。当前库里**没有**任何一个"自己声明"的锚点命中数 ≥ ${costThreshold}（统计口径：`)
  say(`\`${ANCHOR_COST_TABLE.corpus ?? 'tools/calls.jsonl'}\`，${ANCHOR_COST_TABLE.calls} 次真实调用，`)
  say(`表生成于 ${ANCHOR_COST_TABLE.generatedAt}）。`)
} else {
  say(`**有 ${overCost.length} 个**（命中数 ≥ ${costThreshold}，而闸门是写入时才拦，这些是闸门之前写的）：`)
  say('')
  for (const row of overCost) {
    say(`- \`${row.id}\` 锚点 \`${row.anchor}\` 命中 **${row.hits}** 次（占全部调用的 ${(row.share * 100).toFixed(1)}%）`)
    say(`  - ${clip(row.title, 62)}`)
  }
  say('')
  say('修法（一条一改、可回退、会写审计行，先干跑看一眼）：')
  say('')
  say('```powershell')
  say('node tools/snapshot.mjs                       # 先快照')
  say(`node tools/replace-anchor.mjs --id <上面某个 id> --from <那个锚点> --drop    # 干跑`)
  say(`node tools/replace-anchor.mjs --id <上面某个 id> --from <那个锚点> --drop --apply`)
  say('```')
  say('')
  say('**别急着全删**：先看那条记录是不是还有一条更窄的锚点（多数是有的），有就只删宽的那条。')
}
say('')

if (derived.length > 0) {
  say('## 靠出处推断出锚点的记录（只在 edit/write 时生效）')
  say('')
  for (const row of derived) {
    say(`- \`${row.id}\` ${clip(row.title, 66)}`)
    say(`  - 推断锚点：${row.anchors.map(a => `\`${a.kind}:${a.token}\``).join('、')}　出处：\`${clip(row.sourceRef, 60)}\``)
  }
  say('')
}

say('## 静默的记录（有前 40 条）')
say('')
say('这些不是坏记录——它们照样进常驻摘要、照样能被 `memory_recall` 搜到、照样能被复用计分。')
say('它们失去的只是"在一次工具调用前打断你"的资格，因为没人写清楚该在什么时候打断。')
say('要补：重新记一次并填 `recall_for`，或者把出处补成代码/配置文件路径。')
say('')
for (const row of silent.slice(0, 40)) {
  const why = String(row.sourceRef).trim() === ''
    ? '没有出处'
    : `出处不是代码文件（\`${clip(row.sourceRef, 46)}\`）`
  say(`- \`${row.id}\` ${clip(row.title, 60)} — ${why}`)
}
if (silent.length > 40) say(`- …另有 ${silent.length - 40} 条，原因相同。`)

const text = lines.join('\n')
console.log(text)
if (outPath !== undefined) {
  writeFileSync(outPath, `${text}\n`, 'utf8')
  console.log('')
  console.log(`已写入：${outPath}`)
}
