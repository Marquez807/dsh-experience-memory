#!/usr/bin/env node
/**
 * Legacy memory audit — command-line front end.
 *
 * The analysis lives in `lib/audit.js` (built from `src/audit.ts`) so that it is
 * covered by the test suite and reachable from the plugin's own slash commands.
 * This file only parses arguments, calls it, and writes the reports.
 *
 * It imports the built library rather than the TypeScript sources on purpose: a
 * script that imports `src/*.ts` cannot run from an installed package, because
 * Node refuses to strip types under `node_modules`.
 *
 *   node tools/audit-legacy.mjs --root <dir> [--out <dir>]
 *
 * Reports: the audit, the grouped recommendation, the import selection, and a TSV
 * of every mappable record.
 */
import { resolve } from 'node:path'
import { auditLegacy, summarizeAudit, writeAuditReports } from '../lib/audit.js'

const args = process.argv.slice(2)
const flag = name => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
const root = flag('root')
if (root === undefined || root === '') {
  console.error('usage: node tools/audit-legacy.mjs --root <dir> [--out <dir>]')
  process.exit(2)
}
const out = flag('out')

const result = auditLegacy({ root: resolve(root), now: Date.now() })
const dir = out === undefined ? resolve(process.cwd(), 'audit') : resolve(out)
const paths = writeAuditReports(result, dir)

console.log(summarizeAudit(result))
console.log('')
console.log(`report: ${paths.audit}`)
console.log(`picks:  ${paths.selection}`)
console.log(`list:   ${paths.recommended}`)
console.log(`tsv:    ${paths.tsv}`)
