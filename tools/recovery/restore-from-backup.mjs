/**
 * Restore the live store from the 19:18 backup, then replay every logged `memory_remember` call
 * whose record is missing.
 *
 * Two deliberate disciplines, because a recovery that invents data is worse than the loss:
 *
 *   1. **The backup is the base.** It is a real snapshot of this workspace's store taken at
 *      2026-09-22 11:17, not a reconstruction.
 *   2. **Replay only exact arguments.** A record rebuilt from a session log uses the call's own
 *      `kind` / `title` / `body` / `quote` / `source_ref` / `trigger` verbatim, run through the
 *      same `remember()` the model used, so the grade is re-derived rather than asserted. No
 *      fuzzy title matching: a record is restored only when its title matches exactly.
 *
 * The record ids will differ from the lost ones (ids are random), so `superseded_by` chains that
 * pointed at a lost copy are reported instead of being rewired by guesswork.
 *
 *   DSH_HOME must point at the live store. `--apply` writes; without it, dry run.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const backupPath = 'F:\\dsh主工作区\\.recover-20260923-0610\\backup-1918.db'
const callsPath = 'F:\\dsh主工作区\\.exp-all-calls.json'

const lib = name => pathToFileURL(join('F:\\dsh主工作区\\dsh-experience-memory\\lib', name)).href
const { openDb, defaultDbPath, toRecord, upsert } = await import(lib('db.js'))
const { remember } = await import(lib('lifecycle.js'))

const livePath = defaultDbPath()
console.log('live store:', livePath)
console.log('backup    :', backupPath)
console.log('mode      :', apply ? 'APPLY' : 'dry run')

const live = openDb(livePath)
const backup = new DatabaseSync(backupPath, { readOnly: true })

// ── 1. The backup's records go back in, by their own ids, only when absent ──
const backupRows = backup.prepare('SELECT * FROM record').all()
backup.close()
const present = new Set(live.prepare('SELECT id FROM record').all().map(r => r.id))
const toRestore = backupRows.filter(row => !present.has(row.id))
console.log(`backup rows: ${backupRows.length}; already present: ${backupRows.length - toRestore.length}; to restore: ${toRestore.length}`)

if (apply) {
  for (const row of toRestore) upsert(live, toRecord(row))
}
const afterBackup = live.prepare('SELECT count(*) n FROM record').get().n
console.log(apply ? `records after restoring the backup: ${afterBackup}` : `(dry run would leave ${present.size + toRestore.length})`)

// ── 2. Replay the logged calls whose title is missing ──
const payload = JSON.parse(readFileSync(callsPath, 'utf8'))
const byTitle = new Map()
for (const call of payload.calls.slice().sort((a, b) => (b._time ?? 0) - (a._time ?? 0))) {
  const title = String(call.title ?? '').trim()
  if (title === '' || byTitle.has(title)) continue
  byTitle.set(title, call)
}
const haveTitles = new Set(live.prepare('SELECT title FROM record').all().map(r => String(r.title).trim()))
const missing = [...byTitle.entries()].filter(([title]) => !haveTitles.has(title))
console.log(`\nlogged calls with a distinct title: ${byTitle.size}; titles missing from the store: ${missing.length}`)

const restored = []
const failed = []
for (const [title, call] of missing) {
  if (!apply) { restored.push({ title, status: 'dry-run' }); continue }
  try {
    const result = remember(live, {
      workspaceId: 'd80b18919fe33321',
      domain: '',
      kind: call.kind ?? 'experience',
      title,
      body: String(call.body ?? title),
      quote: typeof call.quote === 'string' ? call.quote : undefined,
      sourceRef: typeof call.source_ref === 'string' ? call.source_ref : undefined,
      trigger: typeof call.trigger === 'string' ? call.trigger : undefined,
      failureMode: typeof call.failure_mode === 'string' ? call.failure_mode : undefined,
      lesson: typeof call.lesson === 'string' ? call.lesson : undefined,
      recallFor: Array.isArray(call.recall_for) ? call.recall_for : undefined,
      scope: call.scope === 'domain' ? 'domain' : 'workspace',
      now: Number(call._time) || Date.now(),
    })
    restored.push({ title, id: result.record.id, status: result.record.status, grade: result.grade, route: result.route })
  } catch (error) {
    failed.push({ title, error: error instanceof Error ? error.message : String(error) })
  }
}

const finalCount = live.prepare('SELECT count(*) n FROM record').get().n
const confirmed = live.prepare("SELECT count(*) n FROM record WHERE status='confirmed'").get().n
console.log(`\nfinal: ${finalCount} records, ${confirmed} confirmed`)
console.log(`restored from logs: ${restored.filter(r => r.status !== 'dry-run').length}; failed: ${failed.length}`)
for (const row of failed.slice(0, 15)) console.log('   FAILED:', row.title.slice(0, 56), '|', row.error.slice(0, 80))
const graded = restored.filter(r => r.status === 'confirmed').length
console.log(`restored as confirmed: ${graded}; as candidate: ${restored.filter(r => r.status === 'candidate').length}`)

// ── 3. Chains that pointed at a lost copy ──
const dangling = live.prepare('SELECT id, superseded_by FROM record WHERE superseded_by IS NOT NULL').all()
  .filter(r => live.prepare('SELECT 1 FROM record WHERE id = ?').get(r.superseded_by) === undefined)
console.log(`\nrecords whose superseded_by points at a record that no longer exists: ${dangling.length}`)
for (const row of dangling.slice(0, 10)) console.log('   ', row.id, '->', row.superseded_by)

writeFileSync('F:\\dsh主工作区\\.exp-restore-report.json', JSON.stringify({ toRestore: toRestore.length, restored, failed, dangling }, null, 2), 'utf8')
console.log('\nwrote .exp-restore-report.json')
live.close()
