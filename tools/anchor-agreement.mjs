#!/usr/bin/env node
/**
 * G1：机器提的锚点，跟人写的锚点对不对得上？
 *
 * 为什么要有它（`docs/GROWTH.md` G1）：动手前提示这个功能的前提是记录声明"以后什么调用该把我
 * 端出来"。实测真库 209 条有资格投递的记录里，只有 48 条**自己声明**了锚点，104 条永远静默——
 * 手写覆盖不了，所以要问：能不能让机器自己提？
 *
 * 机器提这件事**已经实现了**（`tools/backfill-anchors.mjs`：从记录声明字段里点名的、工作区真实存在
 * 的文件里挑一个）。缺的不是机制，是**判定**：它提的跟人写的一不一致。这个工具就做这一件事。
 *
 * 两个会让比较变成假象的坑，都在这里挡掉：
 *
 *   1. **提案文件默认不含"已声明锚点"的记录。** `backfill-anchors.mjs` 的默认行为是跳过它们，
 *      所以拿默认输出的文件来比，交集**按构造就是空的**。要 `--include-declared` 重新生成
 *      （它同时会剥掉 trigger 里的锚点标记，否则提议就是从题干里抄答案）。
 *   2. **比的是路径级，不是字符串级。** `path:` 只比小写 basename（`a/b/x.ts` 与 `x.ts` 算同一条），
 *      `tool:` / `command:` 精确比。
 *
 * 判据**先写后跑**，且不许因为样本小而放宽：一致率 ≥70% 算过、<40% 算"必须手写"；
 * N<10 判"未答"，10≤N<30 只报"方向性读数"。
 *
 *   node tools/anchor-agreement.mjs --cwd <workspace> [--db <path>] [--proposals <json>] [--out <md>]
 *
 * Read-only：只读打开库，一个字节都不写回去。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { defaultDbPath } from '../lib/db.js'
import { resolveWorkspace } from '../lib/domain.js'
import { recordAnchors } from '../lib/criteria.js'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = name => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
const dbPath = flag('db') ?? defaultDbPath()
const cwd = flag('cwd') ?? process.cwd()
const proposalsArg = flag('proposals') ?? join(here, 'proposed-anchors-all.json')
const proposalsPath = isAbsolute(proposalsArg) ? proposalsArg : join(here, '..', proposalsArg)
const outPath = flag('out')

if (!existsSync(dbPath)) {
  console.error(`没有这个库：${dbPath}`)
  process.exit(2)
}
if (!existsSync(proposalsPath)) {
  console.error(`没有这个提案文件：${proposalsPath}`)
  console.error('先生成：node tools/backfill-anchors.mjs --cwd <workspace> --include-declared')
  process.exit(2)
}

/** 一条锚点的比较键：`path:` 看小写 basename，其余精确。 */
function compareKey(rendered) {
  const at = rendered.indexOf(':')
  const kind = at === -1 ? '' : rendered.slice(0, at)
  const token = at === -1 ? rendered : rendered.slice(at + 1)
  if (kind !== 'path') return `${kind}:${token}`
  const base = token.split(/[\\/]/).filter(Boolean).pop() ?? token
  return `path:${base.toLowerCase()}`
}

const render = anchor => `${anchor.kind}:${anchor.token}`

// ── 人写的一侧：记录自己声明的锚点 ──────────────────────────────────────────
const workspace = resolveWorkspace(cwd, '')
const now = Date.now()
const db = new DatabaseSync(dbPath, { readOnly: true })
let rows
try {
  rows = db.prepare(
    `SELECT id, title, trigger, source_ref, workspace_id, domain, scope, status, superseded_by, expires_at
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

const declaredById = new Map()
for (const row of rows.filter(visibleTo)) {
  const { anchors, via } = recordAnchors({ trigger: String(row.trigger ?? ''), sourceRef: String(row.source_ref ?? '') })
  // 只算**自己声明**的：`via === 'derived'` 是"出处推断"，那是另一档（默认关着），拿它来比会
  // 把"人写的"偷偷换成"机器推的"，两边就同源了。
  if (via !== 'declared' || anchors.length === 0) continue
  declaredById.set(String(row.id), {
    title: String(row.title),
    anchors: anchors.map(render),
    keys: new Set(anchors.map(render)),
  })
}

// ── 机器的一侧：提案文件 ────────────────────────────────────────────────────
const proposals = JSON.parse(readFileSync(proposalsPath, 'utf8'))
const proposedById = new Map()
for (const p of Array.isArray(proposals) ? proposals : []) {
  if (p === null || typeof p !== 'object' || typeof p.id !== 'string') continue
  const named = Array.isArray(p.named) ? p.named.map(String) : []
  const machine = named.length > 0 ? named.map(n => `path:${n}`) : [String(p.anchor ?? '')].filter(Boolean)
  proposedById.set(p.id, { anchor: String(p.anchor ?? ''), keys: new Set(machine.map(compareKey)) })
}

// ── 比对 ────────────────────────────────────────────────────────────────────
const both = []
for (const [id, human] of declaredById) {
  const machine = proposedById.get(id)
  if (machine === undefined) continue
  const humanKeys = new Set(human.anchors.map(compareKey))
  const hit = [...humanKeys].filter(k => machine.keys.has(k))
  const union = new Set([...humanKeys, ...machine.keys])
  both.push({
    id,
    title: human.title,
    human: human.anchors,
    machine: [...machine.keys],
    agree: hit.length > 0,
    jaccard: union.size === 0 ? 0 : hit.length / union.size,
  })
}

const agreed = both.filter(r => r.agree)
const rate = both.length === 0 ? 0 : agreed.length / both.length
const meanJaccard = both.length === 0 ? 0 : both.reduce((s, r) => s + r.jaccard, 0) / both.length
const pct = n => `${(n * 100).toFixed(1)}%`

// 判据先写后跑（docs/GROWTH.md G1）：阈值不因样本小而放宽，样本不足就判"未答"。
// 注意 10≤N<30 那一档**不许说"过"**——样本不够时，78.6% 和 40% 的区别本身就不稳。
let verdict
if (both.length < 10) {
  verdict = `未答（样本 ${both.length} < 10）：这一点样本量回答不了"机器能不能替代手写"，不拿放宽判据去换一个结论`
} else if (both.length < 30) {
  const lean = rate >= 0.7 ? '倾向"能自动"' : (rate < 0.4 ? '倾向"必须手写"' : '落在中间带，方向不明')
  verdict = `⚠️ **只作方向性读数，不算通过也不算失败**（样本 ${both.length} < 30）：一致率 ${pct(rate)} ⇒ ${lean}`
} else if (rate >= 0.7) {
  verdict = `✅ 过（一致率 ${pct(rate)} ≥ 70%，样本 ${both.length} ≥ 30）：机器提的锚点与人写的**路径级一致**，自动推导这条路可以继续投`
} else if (rate < 0.4) {
  verdict = `❌ 不过（一致率 ${pct(rate)} < 40%）：机器看不出来，**必须手写**——这也是一条结论，别再往自动学索引上投时间`
} else {
  verdict = `⚠️ 中间带（一致率 ${pct(rate)}）：既不过也不算失败，需要更多样本或改提议规则`
}

const lines = []
const say = text => {
  lines.push(text === undefined ? '' : text)
  console.log(text)
}

say('# G1：机器提的锚点 vs 人写的锚点')
say('')
say(`- 库：\`${dbPath}\``)
say(`- 提案文件：\`${relative(join(here, '..'), proposalsPath).replace(/\\/g, '/')}\``)
say(`- 工作区：\`${workspace.root}\`（标识 \`${workspace.id}\`）`)
say(`- 生成时间：${new Date(now).toLocaleString('sv-SE').slice(0, 16)}`)
say('')
say('## 读数')
say('')
say(`- 自己声明了锚点的记录：**${declaredById.size}** 条`)
say(`- 提案文件里的记录：**${proposedById.size}** 条`)
say(`- **两边都有（可比对的样本）：${both.length} 条**`)
say(`- 一致（路径级有交集）：**${agreed.length} / ${both.length}** = **${pct(rate)}**`)
say(`- 交并比均值：${meanJaccard.toFixed(3)}（1.0 = 两侧完全同一组锚点）`)
say('')
say(`**判定**：${verdict}`)
say('')
if (both.length === 0) {
  say('> 交集为空**多半不是结论，是提案文件的生成方式**：`backfill-anchors.mjs` 默认**跳过**已经声明过')
  say('> 锚点的记录，所以默认输出的文件里根本不会出现这些记录。重新生成：')
  say('> `node tools/backfill-anchors.mjs --cwd <workspace> --include-declared --out tools/proposed-anchors.json`')
  say('')
}
if (both.length > 0) {
  say('## 逐条（不一致的排前面，两边都列出来供人判）')
  say('')
  const ordered = [...both].sort((a, b) => Number(a.agree) - Number(b.agree) || a.id.localeCompare(b.id))
  for (const r of ordered.slice(0, 40)) {
    say(`- ${r.agree ? '✓' : '✗'} \`${r.id}\` ${r.title.slice(0, 46)}`)
    say(`    - 人写：\`${r.human.join('`、`')}\``)
    say(`    - 机器：\`${r.machine.join('`、`')}\``)
  }
  if (ordered.length > 40) say(`- …另有 ${ordered.length - 40} 条`)
  say('')
}

if (outPath !== undefined) {
  const target = isAbsolute(outPath) ? outPath : join(process.cwd(), outPath)
  writeFileSync(target, `${lines.join('\n')}\n`, 'utf8')
  console.log(`\n已写入：${target}`)
}
