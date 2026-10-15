/**
 * The provenance audit, pinned on a store holding **two** workspaces.
 *
 * `provenance-audit.mjs` resolved every record's `source_ref` against the one `--cwd` it was
 * handed, so records of other workspaces were reported as missing files that were sitting in the
 * workspace that owned them: measured 2026-10-15, 74 of the first 138 rows were exactly that, and
 * `src/lifecycle.ts` had written the same wrong conclusion into the store (109 of 161 notes).
 *
 * A single-workspace fixture cannot catch it — with one workspace, "our root" and "the record's
 * root" are the same string, so the defect is invisible by construction. That is why this suite
 * builds two, and why the assertion that carries it is `missing === 1` rather than 2.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, eq } from './assert.ts'
import { auditProvenance } from '../tools/lib/provenance.mjs'
import { rootsById, stripRefLines } from '../tools/lib/workspace-roots.mjs'

export async function run(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'expmem-provenance-'))
  try {
    const mine = join(dir, 'mine')
    const other = join(dir, 'other')
    mkdirSync(join(mine, 'docs'), { recursive: true })
    mkdirSync(join(other, 'docs'), { recursive: true })
    mkdirSync(join(mine, 'src'), { recursive: true })
    writeFileSync(join(mine, 'docs', 'OWN.md'), 'own\n', 'utf8')
    writeFileSync(join(other, 'docs', 'THEIRS.md'), 'theirs\n', 'utf8')
    writeFileSync(join(mine, 'src', 'code.ts'), 'export {}\n', 'utf8')

    const roots = rootsById(dir, 2)
    const found = [...roots.values()]
    assert(found.includes(mine) && found.includes(other),
      'the walk finds both workspaces, which is what makes per-record resolution possible at all')
    const idOf = (root: string): string => {
      for (const [id, known] of roots) if (known === root) return id
      throw new Error(`the walk did not find ${root}`)
    }

    const rows = [
      { id: 'own', title: '本工作区的文件还在', source_ref: 'docs/OWN.md:1', workspace_id: idOf(mine) },
      { id: 'theirs', title: '别的工作区的文件也在', source_ref: 'docs/THEIRS.md:1', workspace_id: idOf(other) },
      { id: 'own-code', title: '本工作区的代码', source_ref: 'src/code.ts:1', workspace_id: idOf(mine) },
      { id: 'gone', title: '真的没了', source_ref: 'docs/GONE.md:1', workspace_id: idOf(mine) },
      { id: 'orphan', title: '工作区在树外', source_ref: 'docs/OWN.md:1', workspace_id: 'ffffffffffffffff' },
      { id: 'tool', title: '工具输出', source_ref: 'call_00_abc', workspace_id: idOf(mine) },
      { id: 'absolute', title: '绝对路径', source_ref: 'C:/elsewhere/x.md', workspace_id: idOf(mine) },
    ]

    const { counts, examples } = auditProvenance(rows, roots)

    // The assertion that carries the defect. Resolving every row against one root makes this 2,
    // and the second one is a file that is present in the workspace that owns the record.
    eq(counts.missing, 1,
      "only the citation that is really gone counts as missing — never another workspace's file")
    eq(examples.missing[0]?.id, 'gone', 'and the example names that record, not a false positive')
    eq(counts.orphan, 1,
      'a record whose workspace is outside the walk is undecidable, which is its own outcome')
    eq(counts.none, 1, 'a tool-call citation is not a path and is not checked')
    eq(counts.outside, 1, 'an absolute path is out of scope for a workspace-relative check')
    eq(counts.report, 2, 'the two surviving .md citations are reports')
    eq(counts.code, 1, 'and a citation into code is counted as the readable-off-the-page kind')

    // The same class of mistake, one layer down: a line number must not eat a Windows drive.
    eq(stripRefLines('docs/OWN.md:12'), 'docs/OWN.md', 'a line suffix is stripped')
    eq(stripRefLines('docs/OWN.md:12:34'), 'docs/OWN.md', 'so are a line and a column')
    eq(stripRefLines('C:/x/y.md'), 'C:/x/y.md', 'a drive colon is not a line number')
    eq(stripRefLines(''), '', 'an empty reference stays empty rather than becoming something')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  console.log('  provenance  ok')
}
