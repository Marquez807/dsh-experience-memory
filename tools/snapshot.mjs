#!/usr/bin/env node
/**
 * Snapshot the memory store, and refuse to do anything ambiguous.
 *
 * Written after an experiment's per-trial wipe cleared the live store (271 records → 0) because
 * the script trusted `DSH_HOME` to point somewhere disposable. Two habits come out of that, and
 * this tool exists to make them cheap:
 *
 *   1. **A destructive or bulk operation announces its target first.** Any tool that can change the
 *      store prints the absolute path it resolved before it resolves anything else, so a wrong
 *      path is visible before it costs anything.
 *   2. **The live store gets a snapshot before and after.** Recovery was possible last time only
 *      because another session happened to have left a backup; that is luck, not process.
 *
 * The snapshot is written as a consistent single file via SQLite's own backup, so it does not
 * depend on copying a WAL correctly while another process writes.
 *
 *   node tools/snapshot.mjs [--note "before backfill"] [--out <path>] [--list]
 *
 * Snapshots land next to the store in `snapshots/`, named by UTC timestamp and note.
 */
import { mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { defaultDbPath } from '../lib/db.js'

const args = process.argv.slice(2)
const flag = name => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
const listOnly = args.includes('--list')

const storePath = flag('store') ?? defaultDbPath()
const note = (flag('note') ?? 'manual').replace(/[^\w\u4e00-\u9fff-]+/g, '-').slice(0, 40)
const dir = join(storePath, '..', 'snapshots')

console.log(`store    : ${storePath}`)
console.log(`snapshots: ${dir}`)

if (listOnly) {
  let names = []
  try { names = readdirSync(dir).filter(n => n.endsWith('.db')) } catch { /* none yet */ }
  for (const name of names.sort()) {
    const info = statSync(join(dir, name))
    console.log(`  ${name}  ${(info.size / 1024).toFixed(0)} KB  ${new Date(info.mtimeMs).toISOString().slice(0, 16)}`)
  }
  if (names.length === 0) console.log('  (none)')
  process.exit(0)
}

mkdirSync(dir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const out = flag('out') ?? join(dir, `${stamp}-${note}.db`)

const source = new DatabaseSync(storePath, { readOnly: true })
const counts = {}
for (const table of ['record', 'delivery', 'usage', 'failure_shape', 'correction']) {
  try { counts[table] = source.prepare(`select count(*) n from ${table}`).get().n } catch { counts[table] = 'n/a' }
}
// `VACUUM INTO` writes a consistent copy of the database including the WAL, without needing the
// writer to stop and without hand-copying sidecar files.
source.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`)
source.close()

const written = statSync(out)
console.log(`wrote    : ${out}  (${(written.size / 1024).toFixed(0)} KB)`)
console.log('contents :', Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  '))
