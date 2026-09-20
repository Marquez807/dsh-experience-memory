/**
 * Suite runner. Plain Node, no test framework, so the plugin's tests run with
 * the same interpreter the plugin will (DSH's bundled Node) and need no
 * install step of their own.
 *
 * Suites may be async: the plugin suite mounts a real Cordis Context and
 * registers real services.
 */
import { run as tokenize } from './tokenize.test.ts'
import { run as rank } from './rank.test.ts'
import { run as db } from './db.test.ts'
import { run as retrieve } from './retrieve.test.ts'
import { run as domain } from './domain.test.ts'
import { run as evidence } from './evidence.test.ts'
import { run as lifecycle } from './lifecycle.test.ts'
import { run as importLegacy } from './import.test.ts'
import { run as audit } from './audit.test.ts'
import { run as census } from './census.test.ts'
import { run as commands } from './commands.test.ts'
import { run as plugin } from './plugin.test.ts'

const suites: ReadonlyArray<readonly [string, () => void | Promise<void>]> = [
  ['tokenize', tokenize],
  ['rank', rank],
  ['db', db],
  ['retrieve', retrieve],
  ['domain', domain],
  ['evidence', evidence],
  ['lifecycle', lifecycle],
  ['import', importLegacy],
  ['audit', audit],
  ['census', census],
  ['commands', commands],
  ['plugin', plugin],
]

let failed = 0
for (const [name, run] of suites) {
  try {
    await run()
  } catch (error) {
    failed += 1
    console.error(`  ${name}  FAILED\n${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log(failed === 0 ? `\nPASS ${suites.length} suites` : `\nFAIL ${failed}/${suites.length} suites`)
process.exit(failed === 0 ? 0 : 1)
