#!/usr/bin/env node
/**
 * Import an archived `codex-project-memory` store into experience-memory.
 *
 *   node tools/import-legacy.mjs --root "F:\GPT工作区"            # dry run, prints a report
 *   node tools/import-legacy.mjs --root "F:\GPT工作区" --apply     # writes
 *   node tools/import-legacy.mjs --root ... --db <path>           # non-default database
 *
 * A dry run is the default because the archived tree holds thirteen separate
 * installs of the old runtime, and importing all of them by accident is not a
 * reversible mistake.
 */
import { openDb } from '../src/db.ts'
import { runImport, scanForStores } from '../src/import.ts'

function flag(name) {
  const argv = process.argv.slice(2)
  const inline = argv.find(arg => arg.startsWith(`${name}=`))
  if (inline !== undefined) return inline.slice(name.length + 1)
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1] : undefined
}

const root = flag('--root')
const apply = process.argv.includes('--apply')
const dbPath = flag('--db')

if (root === undefined || root === '') {
  console.error('usage: node tools/import-legacy.mjs --root <directory> [--apply] [--db <path>]')
  process.exit(2)
}

const scan = scanForStores(root)
console.log(`scanned ${root}`)
console.log(`  live stores      : ${scan.stores.length}`)
if (scan.excluded.length > 0) {
  const byReason = {}
  for (const item of scan.excluded) byReason[item.reason] = (byReason[item.reason] ?? 0) + 1
  console.log(`  copies excluded  : ${scan.excluded.length}`)
  for (const [reason, count] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
    console.log(`      ${reason} (${count})`)
  }
  console.log('      (backup/eval copies of a live store; importing them multiplies one')
  console.log('       lesson by however many snapshots exist)')
}
if (scan.errors.length > 0) {
  console.log(`  unreadable paths : ${scan.errors.length}`)
  for (const error of scan.errors.slice(0, 10)) console.log(`      ${error}`)
}

const now = Date.now()
const db = openDb(dbPath)
let outcome
try {
  outcome = runImport(db, scan, { apply, now })
} finally {
  db.close()
}

console.log(`  records found    : ${outcome.found}`)
if (outcome.duplicateRecords > 0) {
  console.log(`  repeated in store: ${outcome.duplicateRecords} (same record stored more than once)`)
}
console.log(`  mappable         : ${outcome.mapped}`)
console.log(`  legacy global→local : ${outcome.globalDowngraded}`)
const skipped = Object.entries(outcome.skipped)
if (skipped.length > 0) {
  console.log('  skipped          :')
  for (const [reason, count] of skipped) console.log(`      ${reason} (${count})`)
}
if (apply) {
  console.log(`  inserted         : ${outcome.inserted}`)
  console.log(`  merged           : ${outcome.merged}`)
  if (outcome.merged > 0) {
    console.log('      (a merge means the store already held that content at the same scope;')
    console.log('       the stronger evidence grade wins and the counters add up)')
  }
  console.log('\nimported.')
} else {
  console.log('\ndry run — nothing written. Re-run with --apply to import.')
  console.log('note: imported records are written directly, so a legacy `global` record')
  console.log('      becomes workspace-local and must be re-scoped deliberately.')
}
