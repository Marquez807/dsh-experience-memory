#!/usr/bin/env node
/**
 * Retire one record and point it at the record that replaces it — the sanctioned way to change what
 * a lesson says.
 *
 * Why not simply edit the old record's text: this project's rule is that a record **may be superseded,
 * never silently rewritten** (`docs/GROWTH.md` §五.2 — rewriting in place would break the evidence
 * chain: `verified-file` means "this passage is in that file", and editing the claim afterwards makes
 * that grade a lie). The store already has the machinery — `supersededBy` makes retrieval drop the
 * old row while keeping it for history, and the `correction` table records who replaced what with a
 * `replacement_id` — but nothing in `tools/` could apply it to a chosen pair, so this file is that
 * step and nothing more.
 *
 * The case that produced it: a safety lesson whose wording could be copied into a guard that does not
 * actually protect the user's real store (`docs/DELIVERY-GAPS.md` §27). The fix was a new record in
 * operative form plus an honest pointer from the old one — not a quiet edit of the old text.
 *
 * Narrow on purpose, like its siblings `add-anchor.mjs` / `replace-anchor.mjs`:
 *
 *   - the store path, both ids and both titles are printed before anything is written;
 *   - both records must exist; the replacement must not itself be retired or superseded;
 *   - re-running the same pair is refused (already superseded by that same record), so the audit log
 *     does not fill with identical rows;
 *   - dry run by default; `--apply` writes `status='retired'`, `supersededBy`, clears `needsReview`,
 *     leaves one audit row with `replacement_id`, and re-reads to check.
 *
 *   node tools/supersede-record.mjs --id <old-id> --by <new-id>
 *   node tools/supersede-record.mjs --id <old-id> --by <new-id> --apply
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = name => pathToFileURL(join(here, '..', 'lib', name)).href
const { defaultDbPath, getRecord, noteCorrection, openDb, upsert } = await import(lib('db.js'))

const args = process.argv.slice(2)
const flag = name => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
const apply = args.includes('--apply')
const id = flag('id')
const by = flag('by')

// Habit from the 271-record incident: announce the target before resolving anything else.
const storePath = flag('db') ?? defaultDbPath()
console.log(`store : ${storePath}`)
console.log(`mode  : ${apply ? 'APPLY（会写库）' : 'dry run（不写库）'}`)
if (id === undefined || by === undefined) {
  console.error('需要 --id <被取代的记录 id> --by <取代它的记录 id>')
  process.exit(2)
}
if (id === by) {
  console.error('--id 与 --by 是同一条记录：取代自己没有任何意义。')
  process.exit(2)
}

const db = openDb(storePath)
const old = getRecord(db, id)
const next = getRecord(db, by)
if (old === undefined) {
  console.error(`没有这条记录：${id}`)
  db.close()
  process.exit(3)
}
if (next === undefined) {
  console.error(`没有取代它的那条记录：${by}`)
  db.close()
  process.exit(3)
}
console.log(`old   : ${old.id}  [${old.status}]  ${old.title}`)
console.log(`new   : ${next.id}  [${next.status}]  ${next.title}`)

if (old.supersededBy === by) {
  console.error(`这条记录已经指向 ${by} 了，不重复写审计。`)
  db.close()
  process.exit(4)
}
if (next.status !== 'confirmed') {
  console.error(`取代它的那条记录不是 confirmed（是 ${next.status}）：被取代的记录会立刻从检索里消失，`)
  console.error('而顶上来的那条还不是确认状态 —— 先确认新记录，再来取代。')
  db.close()
  process.exit(5)
}

console.log(`after : ${old.id} → status=retired, supersededBy=${next.id}（老记录留在库里可查，检索不再取它）`)
if (!apply) {
  db.close()
  console.log('\n（dry run。加 --apply 才写库；写前建议先跑一次 node tools/snapshot.mjs。）')
  process.exit(0)
}

upsert(db, {
  ...old,
  status: 'retired',
  supersededBy: next.id,
  needsReview: null,
  updatedAt: Date.now(),
})
noteCorrection(db, id, 'supersede-record', `superseded by ${next.id}`, Date.now(), next.id)
const reread = getRecord(db, id)
db.close()

const ok = reread !== undefined && reread.status === 'retired' && reread.supersededBy === next.id
console.log(`\n回读: status=${String(reread?.status)} supersededBy=${String(reread?.supersededBy)}`)
console.log(ok ? '✅ 已取代，并记了一条带 replacement_id 的审计' : '❌ 回读与预期不符——请检查')
process.exit(ok ? 0 : 6)
