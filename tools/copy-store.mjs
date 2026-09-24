#!/usr/bin/env node
/**
 * Copy one store to a new path as a **consistent single file**.
 *
 * Why this exists: the live store runs in WAL mode, so the `.db` file alone is not the database —
 * recent commits may live in `memory.db-wal`. Two things go wrong when a caller just does a file
 * copy, and this harness hit both:
 *
 *   1. **Stale data** — the copy silently misses everything still in the WAL (this is already a
 *      recorded lesson in the store: "WAL 模式下主文件不是库本身，只拷 .db 会静默拿到过期数据").
 *   2. **A corrupt copy** — if the destination already has a `-wal` left over from an earlier run,
 *      SQLite validates it against the freshly copied `.db`, the salts disagree, and every
 *      subsequent statement fails with `database disk image is malformed`. The T2 re-measurement
 *      lost six cells to exactly this, and the harness then reported it as "the wipe guard refused"
 *      because it mapped any non-zero exit to that label.
 *
 * `VACUUM INTO` is SQLite's own consistent copy: it reads through the WAL and writes one complete
 * file, with no need to stop the writer and no sidecar files to hand-copy. `tools/snapshot.mjs`
 * already used it; this is that same operation as a standalone step.
 *
 * Fail-closed rules, because this touches stores:
 *
 *   - both absolute paths are printed before anything is opened;
 *   - the target must **not** exist (no silent overwrite — delete it deliberately first);
 *   - the source is opened read-only, so this cannot write to the store it reads;
 *   - afterwards the copy is reopened read-only and its `record` count is printed, so "it copied"
 *     is a measurement rather than a claim.
 *
 *   node tools/copy-store.mjs --from <store.db> --to <new.db>
 */
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const args = process.argv.slice(2)
const flag = name => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
const from = flag('from')
const to = flag('to')
if (from === undefined || to === undefined) {
  console.error('需要 --from <store.db> --to <new.db>')
  process.exit(2)
}
const source = resolve(from)
const target = resolve(to)
console.log(`from : ${source}`)
console.log(`to   : ${target}`)

if (!existsSync(source)) {
  console.error(`源库不存在：${source}`)
  process.exit(3)
}
if (existsSync(target)) {
  console.error(`目标已存在，拒绝覆盖：${target}（要重来请先自己删掉它，别让工具替你决定）`)
  process.exit(4)
}

const db = new DatabaseSync(source, { readOnly: true })
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
db.close()

// A copy that cannot be opened and counted has not been verified, and the caller is about to build
// an experiment on top of it.
const copy = new DatabaseSync(target, { readOnly: true })
const rows = copy.prepare('select count(*) n from record').get().n
const version = copy.prepare('PRAGMA user_version').get().user_version
copy.close()
console.log(`ok   : record=${rows}  schema=${version}  ${(statSync(target).size / 1024).toFixed(0)} KB`)
