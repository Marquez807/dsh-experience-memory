#!/usr/bin/env node
/**
 * Import an archived `codex-project-memory` store into experience-memory.
 *
 *   node tools/import-legacy.mjs --root "F:\GPT工作区"            # dry run, prints a report
 *   node tools/import-legacy.mjs --root "F:\GPT工作区" --apply     # writes
 *   node tools/import-legacy.mjs --root ... --db <path>           # non-default database
 *   node tools/import-legacy.mjs --root ... --selection <file>    # write only these records
 *
 * A dry run is the default because the archived tree holds both live stores and
 * copies of them, and importing all of it by accident is not a reversible mistake.
 *
 * `--selection` takes the `legacy-memory-selection.json` that
 * `tools/audit-legacy.mjs` writes. That file is the audit's recommendation, and it
 * is meant to be edited: delete entries you disagree with, then import. Deciding
 * what deserves to be remembered is a judgement about the data; this tool only
 * performs the mechanical part.
 */
import { readFileSync } from 'node:fs'
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
const selectionPath = flag('--selection')

if (root === undefined || root === '') {
  console.error('usage: node tools/import-legacy.mjs --root <directory> [--apply] '
    + '[--db <path>] [--selection <file>]')
  process.exit(2)
}

let selection
if (selectionPath !== undefined) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(selectionPath, 'utf8'))
  } catch (error) {
    console.error(`cannot read the selection file ${selectionPath}: ${error.message}`)
    process.exit(2)
  }
  const records = parsed?.records
  if (!Array.isArray(records)) {
    console.error(`the selection file ${selectionPath} has no "records" array`)
    process.exit(2)
  }
  selection = new Set(records.map(entry => `${entry.workspaceId}\u0000${entry.contentFingerprint}`))
  console.log(`selection        : ${selection.size} record(s) from ${selectionPath}`)
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
  outcome = runImport(db, scan, { apply, now, selection })
} finally {
  db.close()
}

console.log(`  records found    : ${outcome.found}`)
if (outcome.duplicateRecords > 0) {
  console.log(`  repeated in store: ${outcome.duplicateRecords} (same record stored more than once)`)
}
console.log(`  mappable         : ${outcome.mapped}`)
if (outcome.unselected > 0) {
  console.log(`  not selected     : ${outcome.unselected} (excluded by the selection file)`)
  console.log(`  to import        : ${outcome.mapped - outcome.unselected}`)
}
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
