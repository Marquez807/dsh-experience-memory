/**
 * The provenance audit as a function, so it can be tested against a store it did not build.
 *
 * `provenance-audit.mjs` used to carry this inline and resolve every record against one `--cwd`,
 * which is why it reported 138 files missing on 2026-10-15 when the true count was 63 — and the
 * same mistake in `src/lifecycle.ts` had written 109 wrong notes into the store. Splitting the
 * decision out of the CLI is what lets `tests/provenance.test.ts` pin it with a store holding two
 * workspaces: a regression here is invisible in any single-workspace fixture, which is exactly how
 * the original defect survived.
 */
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { CODE_SUFFIXES } from '../../lib/anchors.js'
import { rootFor, stripRefLines } from './workspace-roots.mjs'

const suffixOf = path => {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

/**
 * Classify every row's citation. Pure: reads the filesystem to answer "is it there", writes
 * nothing.
 *
 * `orphan` is a shape of its own on purpose. A record whose workspace this walk could not find
 * has a citation that *cannot be resolved here*, which is a different fact from a citation that
 * is gone — and collapsing the two is the error this function was extracted to stop repeating.
 */
export function auditProvenance(rows, roots, { examplesPerKind = 12 } = {}) {
  const counts = { missing: 0, report: 0, code: 0, none: 0, outside: 0, orphan: 0 }
  const examples = { missing: [], report: [] }

  for (const row of rows) {
    const ref = String(row.source_ref ?? '').trim()
    if (ref === '' || /^call_/i.test(ref)) { counts.none += 1; continue }
    if (isAbsolute(ref)) { counts.outside += 1; continue }
    const path = stripRefLines(ref)
    const { root, known } = rootFor(row, roots)
    if (!known) { counts.orphan += 1; continue }
    if (!existsSync(join(root, path))) {
      counts.missing += 1
      if (examples.missing.length < examplesPerKind) {
        examples.missing.push({ id: row.id, title: String(row.title ?? '').slice(0, 62), ref: path })
      }
      continue
    }
    if (CODE_SUFFIXES.has(suffixOf(path))) { counts.code += 1; continue }
    counts.report += 1
    if (examples.report.length < examplesPerKind) {
      examples.report.push({ id: row.id, title: String(row.title ?? '').slice(0, 62), ref: path })
    }
  }
  return { counts, examples }
}
