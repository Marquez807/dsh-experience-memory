#!/usr/bin/env node
/**
 * Empty a *disposable* store. Refuses to touch anything else.
 *
 * This file exists because of one incident: an experiment's per-trial wipe resolved `DSH_HOME`
 * to the user's live store and cleared 271 records. The rule since is that a destructive script
 * announces its target and refuses unless the target is unmistakably disposable — here, it must
 * live under the OS temp directory. A path in `AppData`, a path named `harness`, a path that is
 * the user's real memory: none of those pass.
 *
 *   DSH_HOME=<isolated home> node wipe.mjs
 */
import { tmpdir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

// Resolved from this file, not from `process.cwd()`: the caller may be anywhere, and a wipe
// that resolved its own store through the caller's working directory is the same fragility
// that produced the incident this guard exists for.
const here = fileURLToPath(new URL('.', import.meta.url))
const lib = name => pathToFileURL(resolve(here, '..', '..', 'lib', name)).href
const { defaultDbPath } = await import(lib('db.js'))
const { DatabaseSync } = await import('node:sqlite')

const target = resolve(defaultDbPath())
const disposable = resolve(tmpdir())
console.log(`wipe target : ${target}`)
console.log(`must be under: ${disposable}`)

// The guard, and it is the point of this file: a destructive step states its target and stops
// unless that target is unmistakably one it owns. Two signals, both about the *path*, because
// the file layout under a disposable home is deliberately identical to a real one — the name
// `experience-memory/memory.db` cannot distinguish them:
//   1. it must live under the OS temp directory (a real store lives in AppData\Roaming);
//   2. it must not name the real harness home (`dsh-desktop/harness`).
// An earlier version refused on `experience-memory/memory.db` and so refused the very file it
// creates: a guard that always fires is a guard nobody can use.
if (!isAbsolute(target) || !target.toLowerCase().startsWith(disposable.toLowerCase())) {
  console.error('REFUSED: that store is not under the OS temp directory. Nothing was touched.')
  process.exit(3)
}
if (/dsh-desktop[\\/]+harness/i.test(target)) {
  console.error('REFUSED: that is the real harness home. Nothing was touched.')
  process.exit(3)
}

const db = new DatabaseSync(target)
db.exec('DELETE FROM record')
db.exec('DELETE FROM delivery')
console.log('wiped ->', db.prepare('select count(*) n from record').get().n, 'records')
db.close()
