/**
 * Repair the search index after the restore, and report what the restore could not bring back.
 *
 * `record_fts` is a plain (non-external-content) FTS5 table that the plugin writes to explicitly,
 * so after any out-of-band data change it has to be rebuilt from `record` or search returns rows
 * whose record no longer exists — a stale hit that would surface as a wrong or empty result.
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const apply = args.includes('--apply')

const lib = name => pathToFileURL(join('F:\\dsh主工作区\\dsh-experience-memory\\lib', name)).href
const { openDb, defaultDbPath, indexRow, toRecord } = await import(lib('db.js'))

const live = openDb(defaultDbPath())
const before = live.prepare('select count(*) n from record_fts').get().n
const records = live.prepare('SELECT * FROM record').all().map(toRecord)
console.log(`records: ${records.length}; index rows before: ${before}; ${apply ? 'APPLY' : 'dry run'}`)

// Which indexed ids belong to no record?
const ids = new Set(records.map(r => r.id))
const indexed = live.prepare('select id from record_fts').all().map(r => r.id)
const orphans = indexed.filter(id => !ids.has(id))
const unindexed = records.filter(r => !indexed.includes(r.id))
console.log(`index rows whose record is gone: ${orphans.length}`)
console.log(`records with no index row: ${unindexed.length}`)

if (apply) {
  live.exec('DELETE FROM record_fts')
  const insert = live.prepare('INSERT INTO record_fts VALUES (?,?,?,?,?,?)')
  for (const record of records) insert.run(record.id, ...indexRow(record))
  const after = live.prepare('select count(*) n from record_fts').get().n
  const stillOrphan = live.prepare('select id from record_fts').all().filter(r => !ids.has(r.id)).length
  console.log(`rebuilt: ${after} index rows, orphans now ${stillOrphan}`)
} else {
  console.log('(nothing written; pass --apply)')
}

// Anchors: the mechanism's wiring, and what it looks like now.
const anchored = records.filter(r => String(r.trigger ?? '').includes('--- anchors ---'))
console.log(`\nrecords with an anchor block: ${anchored.length}`)
for (const r of anchored) console.log('  ', r.id, r.status, '|', String(r.title).slice(0, 56))
live.close()
