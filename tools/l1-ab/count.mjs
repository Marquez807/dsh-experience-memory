/** 读隔离库里的检索计数：判据 2 看的就是这个（摘要薄了，读者到底去不去取）。 */
import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync(process.argv[2], { readOnly: true })
const scalar = sql => {
  const row = db.prepare(sql).get()
  return Number(row?.n ?? 0)
}
console.log(JSON.stringify({
  retrieve: scalar('SELECT SUM(retrieve_count) AS n FROM record'),
  records: scalar('SELECT COUNT(*) AS n FROM record'),
  usage: scalar('SELECT COUNT(*) AS n FROM usage WHERE record_id IS NOT NULL'),
}))
db.close()
