#!/usr/bin/env node
/**
 * Before weighting "the trap that keeps being hit", measure whether the association holds.
 *
 * `failure_shape` counts how often each `(tool, error shape)` repeats — that is what `/memory-gaps`
 * reads — but the count never reaches `importance()`. Wiring it in is only worth doing if the
 * records that would receive the weight actually talk about that shape, and the only cheap link
 * available is the anchor a record declared (`tool:<name>`), which is a **name**, not a topic.
 *
 * So this answers the question the weighting decision depends on, before anything changes: for each
 * shape that repeated at least `--min-count` times, which records in that workspace declare a
 * `tool:` anchor for the same tool, and how important are they already?
 *
 * Read-only, and its output is meant to be *read*, not trusted. If the hits are mostly records
 * about something else, then the weighting would be measuring "this tool gets used" rather than
 * "this lesson was missed" — and it should not be built.
 *
 *   node tools/remine-signal.mjs [--cwd <root>] [--min-count 3] [--per-shape 3] [--out <md>]
 */
import { writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { defaultDbPath } from '../lib/db.js'
import { recordAnchors } from '../lib/criteria.js'
import { importance } from '../lib/rank.js'

const args = process.argv.slice(2)
const flag = name => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
const dbPath = flag('db') ?? defaultDbPath()
const minCount = Number(flag('min-count') ?? 3)
const perShape = Number(flag('per-shape') ?? 3)
const outPath = flag('out')

const db = new DatabaseSync(dbPath, { readOnly: true })
const shapes = db.prepare(
  `SELECT workspace_id, tool, shape, count, sample, last_seen
     FROM failure_shape WHERE count >= ?
    ORDER BY count DESC`,
).all(minCount)
const now = Date.now()

const lines = []
const say = text => lines.push(text === undefined ? '' : text)
say(`# 重踩信号：反复发生的形态，能不能落到某条记录上`)
say('')
say(`- 库：\`${dbPath}\``)
say(`- 形态门槛：count ≥ ${minCount}（共 ${shapes.length} 个）`)
say('')

let withHits = 0
let totalHits = 0
const rows = []
for (const shape of shapes) {
  const records = db.prepare(
    `SELECT id, title, evidence, trigger, source_ref, success_count, reuse_count, fail_streak,
            distinct_workspaces, retrieve_count, last_retrieved_at, created_at, last_used_at, review_after
       FROM record
      WHERE workspace_id = ? AND status = 'confirmed' AND superseded_by IS NULL`,
  ).all(shape.workspace_id)

  const hits = records.filter(record => {
    const { anchors } = recordAnchors({
      trigger: String(record.trigger ?? ''),
      sourceRef: String(record.source_ref ?? ''),
    })
    return anchors.some(anchor => anchor.kind === 'tool' && anchor.token === shape.tool)
  }).map(record => ({
    id: String(record.id),
    title: String(record.title ?? ''),
    importance: importance({
      evidence: record.evidence,
      successCount: record.success_count,
      reuseCount: record.reuse_count,
      failStreak: record.fail_streak,
      distinctWorkspaces: record.distinct_workspaces,
      retrieveCount: record.retrieve_count,
      lastRetrievedAt: record.last_retrieved_at,
      createdAt: record.created_at,
      lastUsedAt: record.last_used_at,
      reviewAfter: record.review_after,
      now,
    }),
  }))

  if (hits.length > 0) withHits += 1
  totalHits += hits.length
  rows.push({ shape, hits })
}

say(`- **有记录能对上的形态：${withHits} / ${shapes.length}**，合计命中 ${totalHits} 条`)
say('')
say('读数提醒：命中是**靠 tool 名**对上的，不是靠主题。`tool:pwsh` 这种宽锚点会把"凡是 pwsh 上的坑"')
say('全都算进来——一个工具下有几十种形态，所以命中条数多不等于关联准确。人读这份输出，判断的正是这一点。')
say('')

for (const { shape, hits } of rows) {
  const sample = String(shape.sample ?? '').replace(/\s+/g, ' ').trim().slice(0, 70)
  say(`## ${shape.tool} · 计数 ${shape.count}`)
  say('')
  say(`形态样例：\`${sample}\``)
  if (hits.length === 0) {
    say('')
    say('**没有任何记录声明了 \`tool:' + shape.tool + '\` 锚点** —— 这一类重踩目前落不到任何记录上。')
    say('')
    continue
  }
  say('')
  for (const hit of hits.slice(0, perShape)) {
    say(`- \`${hit.id}\` 重要性 ${hit.importance.toFixed(1)} — ${hit.title.slice(0, 60)}`)
  }
  if (hits.length > perShape) say(`- …另有 ${hits.length - perShape} 条`)
  say('')
}

const text = lines.join('\n')
console.log(text)
if (outPath !== undefined) {
  writeFileSync(outPath, `${text}\n`, 'utf8')
  console.log(`\n已写入：${outPath}`)
}
db.close()
