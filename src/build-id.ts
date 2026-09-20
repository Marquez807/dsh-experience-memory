/**
 * Which build this process is actually running.
 *
 * A copy of this plugin cannot be identified by version (`0.1.0` throughout) or by
 * mtime (a tarball restores 1985 timestamps for every file). Hashing the files on disk
 * answers a different question than the one a caller has: under a `link:` install those
 * files *are* the working tree, so a matching hash proves only that the checkout is
 * current — never that the running process loaded it. A caller asked for exactly this
 * and could not close the loop: it could confirm the fix was on disk and still had no
 * way to confirm the restart had picked it up.
 *
 * So the hash is computed here, at activation, by the process itself. Comparing it
 * against the repository answers "did the restart load the fix", and comparing two
 * processes' ids answers "are these two sessions running the same code".
 *
 * The hash covers the compiled modules beside this one, because that is what was
 * imported. It is deliberately not a build stamp written by the build script: a stamp
 * would be identical across two copies of the same source, while this also changes if
 * anyone edits a built file in place — which is a real way to end up running something
 * no commit describes.
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface BuildIdentity {
  /** Short content hash over the modules beside this one, or `unknown`. */
  id: string
  /** How many modules were hashed; `0` when the directory could not be read. */
  modules: number
}

/** Hash the modules this plugin was loaded from. Never throws. */
export function buildIdentity(): BuildIdentity {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const files = readdirSync(here)
      .filter(name => (name.endsWith('.js') || name.endsWith('.ts')) && !name.endsWith('.map'))
      .sort()
    const hash = createHash('sha256')
    for (const name of files) {
      hash.update(name)
      hash.update(readFileSync(join(here, name)))
    }
    return { id: hash.digest('hex').slice(0, 12), modules: files.length }
  } catch {
    // An unreadable module directory is not a reason to fail activation: the identity is
    // a diagnostic, and reporting `unknown` is more honest than a plausible-looking hash.
    return { id: 'unknown', modules: 0 }
  }
}
