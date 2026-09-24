#!/usr/bin/env node
/**
 * Show what the store actually delivered, and why — read-only.
 *
 * A deletion test can only be read correctly if the delivery itself is visible. "The arm with the
 * record behaved no differently" has two very different causes: the hint never fired (a delivery
 * problem) or it fired and changed nothing (a knowledge problem). Without this, the two get
 * conflated — and T2's wipeguard scenario is exactly the case where the distinction decides what to
 * do next (`tools/t2-plan.md` §4.11 makes checking this mandatory before reading the result).
 *
 *   node tools/delivery-report.mjs                                   # the live store, summary
 *   node tools/delivery-report.mjs --db <store> --record <id>         # one record's deliveries
 *   node tools/delivery-report.mjs --db <store> --limit 40            # more rows
 *
 * `reason` is why the record was offered (`anchor` = matched a declared trigger, `identifier`,
 * `resident`), `tool` is the call it was offered before, and `matched` is the text that matched.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { defaultDbPath } from '../lib/db.js'

const args = process.argv.slice(2)
const flag = name => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
const storePath = resolve(flag('db') ?? defaultDbPath())
const recordId = flag('record')
const limit = Number(flag('limit') ?? 20)

console.log(`store  : ${storePath}`)
if (!existsSync(storePath)) {
  console.error('没有这个库文件。')
  process.exit(2)
}
const db = new DatabaseSync(storePath, { readOnly: true })

const scoped = recordId === undefined ? '' : ' WHERE record_id = ?'
const bind = recordId === undefined ? [] : [recordId]
const total = db.prepare(`select count(*) n from delivery${scoped}`).get(...bind).n
console.log(`record : ${recordId ?? '(全部)'}`)
console.log(`投递行 : ${total}`)
if (total === 0) {
  console.log('（这个库/这条记录没有任何投递记录。锚点没命中，或者这条记录只走了每轮摘要——'
    + '摘要不写 delivery 表，所以"摘要送过"不会出现在这里。）')
  db.close()
  process.exit(0)
}

console.log('')
console.log('按原因：')
for (const row of db.prepare(`select reason, count(*) n from delivery${scoped} group by reason order by n desc`).all(...bind)) {
  console.log(`  ${String(row.reason).padEnd(12)} ${row.n}`)
}
console.log('按工具：')
for (const row of db.prepare(`select coalesce(tool, '(无)') tool, count(*) n from delivery${scoped} group by tool order by n desc`).all(...bind)) {
  console.log(`  ${String(row.tool).padEnd(12)} ${row.n}`)
}
console.log('')
console.log(`最近 ${limit} 条：`)
for (const row of db.prepare(`select record_id, session_id, tool, matched, reason, at from delivery${scoped} order by at desc limit ?`).all(...bind, limit)) {
  const when = new Date(Number(row.at)).toISOString().replace('T', ' ').slice(0, 19)
  console.log(`  ${when}  ${row.reason.padEnd(10)} ${String(row.tool ?? '-').padEnd(8)} matched=${JSON.stringify(String(row.matched).slice(0, 60))}  record=${String(row.record_id).slice(0, 12)}`)
}
db.close()
