#!/usr/bin/env node
/**
 * Import an archived `codex-project-memory` store into experience-memory.
 *
 * The scanning, mapping and reporting live in `lib/import.js`; this file parses
 * arguments and prints. It loads the built library rather than the TypeScript
 * sources so it runs from an installed package as well as from the repository.
 *
 *   node tools/import-legacy.mjs --root "F:\GPT工作区"            # dry run, prints a report
 *   node tools/import-legacy.mjs --root "F:\GPT工作区" --apply     # writes
 *   node tools/import-legacy.mjs --root ... --db <path>           # non-default database
 *   node tools/import-legacy.mjs --root ... --selection <file>    # write only these records
 *
 * A dry run is the default because the archived tree holds both live stores and
 * copies of them, and importing all of it by accident is not a reversible mistake.
 *
 * `--selection` takes the `legacy-memory-selection.json` the audit writes. That
 * file is the audit's recommendation and is meant to be edited: delete entries you
 * disagree with, then import. Deciding what deserves to be remembered is a
 * judgement about the data; this tool only performs the mechanical part.
 */
import { readFileSync } from 'node:fs'
import { openDb } from '../lib/db.js'
import { parseSelection, runImport, scanForStores, summarizeImport } from '../lib/import.js'

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
  try {
    const parsed = JSON.parse(readFileSync(selectionPath, 'utf8'))
    selection = parseSelection(parsed)
  } catch (error) {
    console.error(`selection file ${selectionPath} is unusable: ${error.message}`)
    process.exit(2)
  }
  console.log(`selection        : ${selection.size} record(s) from ${selectionPath}`)
}

const scan = scanForStores(root)
const db = openDb(dbPath)
let outcome
try {
  outcome = runImport(db, scan, { apply, now: Date.now(), selection })
} finally {
  db.close()
}

console.log(summarizeImport(outcome, { apply }))
