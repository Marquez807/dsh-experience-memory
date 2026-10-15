#!/usr/bin/env node
/**
 * 存量候选按新标准清一遍：**"报错里已经写着做法"的失败，不该占候选位**。
 *
 * 2026-10-15 起 `gapCandidates` 不再为这类形态产候选（`src/failure.ts` 的 `statesItsOwnFix`），
 * 但更早产生的候选还在池子里。实测那天：73 条候选里绝大多数是自动采集的重踩，而这条通道
 * **一条都没被确认成经验过**——池子堆着没人看也不该看的东西，正是候选池失去作用的原因。
 *
 * 判定复用的就是插件自己那一个函数（`statesItsOwnFix`），不另写一份判据；写完先干跑看数字，
 * `--apply` 才退役。
 *
 *   node tools/sweep-candidates.mjs                 # 只报告
 *   node tools/sweep-candidates.mjs --apply         # 退役那些"自带做法"的候选
 */
import { DatabaseSync } from 'node:sqlite'
import { defaultDbPath } from '../lib/db.js'
import { statesItsOwnFix } from '../lib/failure.js'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const db = new DatabaseSync(defaultDbPath(), { readOnly: !apply })
const rows = db.prepare(
  "SELECT id, title, body, created_at FROM record WHERE status = 'candidate' ORDER BY created_at",
).all()

const guilty = []
const kept = []
for (const row of rows) {
  const title = String(row.title ?? '')
  const body = String(row.body ?? '')
  // 只判**由反复失败形态产生**的候选。`gapCandidateTitle` 的格式是机械的 `<工具>: <形态>`，
  // 正文由 `gapCandidateText` 写成「本工作区反复出现的失败 …」。别的候选（采集来的用户语句、
  // 任务片段）不是这条通道的产物，而 `statesItsOwnFix` 的判据是**照着错误信息写的**——拿它去判
  // 任意文本会误伤：实测一条讲配置项 `is REQUIRED` 的知识候选就被 `/is required/i` 判进去了。
  const fromFailure = /^[a-z_]+: /.test(title) && body.startsWith('本工作区反复出现的失败')
  if (fromFailure && statesItsOwnFix(`${title}\n${body}`)) guilty.push(row)
  else kept.push(row)
}

console.log(`候选共 ${rows.length} 条`)
console.log(`  报错自带做法（新标准下不该存在）：${guilty.length} 条`)
console.log(`  其他（保留）：${kept.length} 条`)
console.log('')
for (const row of guilty.slice(0, 20)) {
  console.log(`  ${row.id}  ${String(row.title ?? '').slice(0, 78)}`)
}
if (guilty.length > 20) console.log(`  …另有 ${guilty.length - 20} 条`)

if (!apply) {
  console.log('\n（未写入。加 --apply 才退役；退役可逆，内容不删。）')
  db.close()
  process.exit(0)
}

let retired = 0
for (const row of guilty) {
  db.prepare(
    "UPDATE record SET status = 'retired', needs_review = ? WHERE id = ?",
  ).run('维护：报错自带做法，按 0.5.9 的新标准不该占用候选位', row.id)
  retired += 1
}
console.log(`\n已退役 ${retired} 条（可逆：状态改回 candidate 即可；内容未删）。`)
db.close()
