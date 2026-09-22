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
  ...recordAnchors({
    trigger: String(row.trigger ?? ''),
    sourceRef: String(row.source_ref ?? ''),
  }),
}))

const declared = pool.filter(row => row.via === 'declared')
const derived = pool.filter(row => row.via === 'derived' && row.anchors.length > 0)
const silent = pool.filter(row => row.anchors.length === 0)

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
say(`- **由出处推断出锚点**（出处是代码/配置文件，用那个文件名当锚点）：**${derived.length}** 条（${pct(derived.length, pool.length)}）`)
say(`- **没有任何锚点、动手前永远静默**：**${silent.length}** 条（${pct(silent.length, pool.length)}）`)
say('')
say('自己声明的锚点是可靠的那一档；推断出来的只在调用**要动那个文件**（edit/write）时才生效，')
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
