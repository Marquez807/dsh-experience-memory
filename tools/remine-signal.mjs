#!/usr/bin/env node
/**
 * What to do about the failures that keep repeating — classified, not assumed.
 *
 * `failure_shape` counts how often each `(tool, error shape)` repeats. That count on its own does
 * not say what to do about it, and the obvious answer ("weight the related records") was measured
 * and rejected on 2026-10-15: the shapes with the highest counts have no record to weight, and
 * where a record did attach, the link was by tool *name* and about half wrong.
 *
 * So this tool sorts every repeated shape into the three outcomes that actually have different
 * fixes, and prints the count of each:
 *
 *   - **self-explaining** — the message already says what to do (`file has not been read`). Not a
 *     knowledge gap; it is workflow friction, and `gapCandidates` no longer files these at all.
 *   - **covered** — a record exists *and* declares a `tool:` anchor for the same tool, so it can
 *     actually be shown just before that call. If the shape still repeats, the problem is the
 *     record's content or its delivery, not its absence.
 *   - **needs an anchor** — a record comes close but declares no anchor for this tool, so it never
 *     fires at the moment of the mistake. This is the actionable list: add the anchor.
 *   - **needs a record** — nothing in the store comes close. `/memory-gaps` and the automatic
 *     candidate path already handle these.
 *
 * Read-only. Output is meant to be read: it says which bucket each shape is in and why.
 *
 *   node tools/remine-signal.mjs [--min-count 3] [--per-shape 3] [--out <md>]
 */
import { writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { defaultDbPath } from '../lib/db.js'
import { recordAnchors } from '../lib/criteria.js'
import { gapReport, statesItsOwnFix } from '../lib/failure.js'
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
  `SELECT workspace_id, tool, shape, count, sample FROM failure_shape WHERE count >= ? ORDER BY count DESC`,
).all(minCount)
const now = Date.now()

/** Records of this workspace that declare `tool:<name>`, with their current standing. */
const anchoredRecords = (workspaceId, tool) => {
  const rows = db.prepare(
    `SELECT id, title, evidence, trigger, source_ref, success_count, reuse_count, fail_streak,
            distinct_workspaces, retrieve_count, last_retrieved_at, created_at, last_used_at, review_after
       FROM record
      WHERE workspace_id = ? AND status = 'confirmed' AND superseded_by IS NULL`,
  ).all(workspaceId)
  return rows.filter(row => recordAnchors({
    trigger: String(row.trigger ?? ''),
    sourceRef: String(row.source_ref ?? ''),
  }).anchors.some(anchor => anchor.kind === 'tool' && anchor.token === tool))
    .map(row => ({
      id: String(row.id),
      title: String(row.title ?? ''),
      importance: importance({
        evidence: row.evidence,
        successCount: row.success_count,
        reuseCount: row.reuse_count,
        failStreak: row.fail_streak,
        distinctWorkspaces: row.distinct_workspaces,
        retrieveCount: row.retrieve_count,
        lastRetrievedAt: row.last_retrieved_at,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
        reviewAfter: row.review_after,
        now,
      }),
    }))
}

const buckets = { selfExplaining: [], covered: [], needsAnchor: [], needsRecord: [] }
for (const shape of shapes) {
  if (statesItsOwnFix(String(shape.sample ?? ''))) {
    buckets.selfExplaining.push(shape)
    continue
  }
  const anchored = anchoredRecords(shape.workspace_id, shape.tool)
  if (anchored.length > 0) {
    buckets.covered.push({ shape, anchored })
    continue
  }
  // Nothing declares an anchor for this tool — so: is there a record that comes close at all?
  const report = gapReport(db, {
    workspaceId: shape.workspace_id, domain: '', now, limit: 200, minCount,
  })
  const row = report.find(candidate => candidate.shape.tool === shape.tool
    && candidate.shape.shape === shape.shape)
  if (row?.closest !== undefined) {
    buckets.needsAnchor.push({
      shape, closest: row.closest, score: row.bestScore, keywords: row.keywords.length,
    })
  } else buckets.needsRecord.push(shape)
}

const lines = []
const say = text => lines.push(text === undefined ? '' : text)
const total = shapes.length

say('# 重踩的失败：该怎么处理（分类，不猜）')
say('')
say(`- 库：\`${dbPath}\``)
say(`- 形态门槛：count ≥ ${minCount}（共 **${total}** 个）`)
say('')
say('| 类别 | 个数 | 该怎么办 |')
say('|---|---|---|')
say(`| **报错自带做法** | ${buckets.selfExplaining.length} | 不记、不加权——它是流程摩擦，不是知识缺口（\`gapCandidates\` 已不再为它们产候选） |`)
say(`| **已覆盖（挂了对应锚点）** | ${buckets.covered.length} | 记录存在且能在动作前弹出；若仍重踩，问题在内容或投递，不在"没有记录" |`)
say(`| **该补锚点（但要先人读）** | ${buckets.needsAnchor.length} | "有记录"是**词面重叠**判出来的，而它很松：重叠一个词就算有关。下面的得分一栏就是让你判这一点的 |`)
say(`| **该记一条** | ${buckets.needsRecord.length} | 库里没有任何词面重叠的记录；自动候选通道已在处理 |`)
say('')
say('读法：这张表替代了"重踩就加权"的想法（2026-10-15 实测否掉：计数最高的几类没有任何记录可加权，')
say('而能对上的靠工具名关联、约一半是错的）。四个类别各有各的修法，第一类通常占大头，而它**不需要**记忆插件做任何事。')
say('')
say('**已知局限（别读过头）**：`gapReport` 的"有没有相关记录"是**关键词重叠**判的，阈值极低——')
say('重叠一个词就落到"有关"那一侧。所以"该补锚点"里混着词面巧合（实测多为 1–2 分），')
say('而"该记一条"那一侧则可能漏掉真正需要记录的形状。看得分再下判断，别照单执行。')
say('')

const show = (title, items, render) => {
  if (items.length === 0) return
  say(`## ${title}`)
  say('')
  for (const item of items.slice(0, 12)) say(render(item))
  if (items.length > 12) say(`- …另有 ${items.length - 12} 个`)
  say('')
}

show('报错自带做法（列前几条，说明为什么不算缺口）', buckets.selfExplaining, shape =>
  `- \`${shape.tool}\` 计数 ${shape.count} — \`${String(shape.sample ?? '').replace(/\s+/g, ' ').trim().slice(0, 68)}\``)

show('关联很弱（词面重叠，可能是巧合——低分多半不是同一件事）', buckets.needsAnchor, item =>
  `- \`${item.shape.tool}\` 计数 ${item.shape.count} → 最近记录 \`${item.closest.id}\` ${String(item.closest.title ?? '').slice(0, 40)}　**得分 ${item.score}/${item.keywords}**`)

show('该记一条（库里没有接近的记录）', buckets.needsRecord, shape =>
  `- \`${shape.tool}\` 计数 ${shape.count} — \`${String(shape.sample ?? '').replace(/\s+/g, ' ').trim().slice(0, 68)}\``)

show('已覆盖（挂了对的锚点）', buckets.covered, item =>
  `- \`${item.shape.tool}\` 计数 ${item.shape.count} → ${item.anchored.slice(0, perShape).map(hit => `\`${hit.id}\`（重要性 ${hit.importance.toFixed(1)}）`).join('、')}`)

const text = lines.join('\n')
console.log(text)
if (outPath !== undefined) {
  writeFileSync(outPath, `${text}\n`, 'utf8')
  console.log(`\n已写入：${outPath}`)
}
db.close()
