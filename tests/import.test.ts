/**
 * Migration regressions.
 *
 * The archived tree holds thirteen installs of the old runtime, so the importer
 * has to be safe on unfamiliar input and honest about what it refuses. Passing
 * a legacy record through `remember` would grade everything as `inferred`,
 * silently demoting a store of verified facts, so imported records are written
 * directly and that is asserted here.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, eq } from './assert.ts'
import { openDb } from '../src/db.ts'
import type { DatabaseSync } from 'node:sqlite'
import { mapStore, runImport, scanForStores, selectionKey } from '../src/import.ts'

const NOW = 1_800_000_000_000

export function run(): void {
  const dir = mkdtempSync(join(tmpdir(), 'expmem-import-'))
  const db: DatabaseSync = openDb(join(dir, 'memory.db'))
  try {
    // ── Build an archived-shaped store ────────────────────────────────────
    const project = join(dir, 'legacy-project')
    const memory = join(project, '.memory')
    mkdirSync(memory, { recursive: true })
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: '@acme/legacy-tool' }))
    const legacy = [
      {
        id: 'L1', type: 'fact', text: '部署一律写到 F 盘', summary: '用户声明：部署一律写到 F 盘',
        status: 'confirmed', scope: 'project', source: 'autonomy:user_statement',
        created_at: '2026-09-01T00:00:00+00:00',
        admission: { proof: { kind: 'user' } },
      },
      {
        id: 'L2', type: 'experience', text: '写 C 盘会触发磁盘告警', summary: '工具观察：写 C 盘会触发磁盘告警',
        status: 'active', scope: 'project', subject: '部署 磁盘',
        admission: { proof: { kind: 'tool' } },
      },
      {
        id: 'L3', type: 'capability', text: '会用 ripgrep 搜索', summary: 'capability',
        status: 'candidate', scope: 'global',
      },
      { id: 'L4', type: 'strategy', text: '', summary: '空的' },
      { id: 'L5', type: 'nonsense', text: '未知类型', summary: '未知' },
      { id: 'L6', type: 'fact', text: '已归档的记录', summary: '归档', status: 'archived', scope: 'project' },
      { id: 'L7', type: 'failure', text: '构建在 Windows 上失败', summary: '失败事件' },
      // The old runtime wrote tool failures as `type: fact` with tool proof, so
      // filtering by type alone let them through carrying the strongest grade.
      { id: 'L8', type: 'fact', text: 'Tool call_00_JRMGr5QZdwy3t7rS3pPC9404 exited 1',
        summary: 'Tool call_00_JRMGr5QZdwy3t7rS3pPC9404 exited 1', status: 'confirmed',
        scope: 'project', admission: { proof: { kind: 'tool' } } },
      { id: 'L9', type: 'fact', text: 'Tool exec-a386641d-195f-43ab-b32c-f4f553ad2df8 exited 255',
        summary: 'Tool exec-a386641d-195f-43ab-b32c-f4f553ad2df8 exited 255', status: 'confirmed',
        scope: 'project', admission: { proof: { kind: 'tool' } } },
      // A real lesson that merely mentions a failing command is still knowledge.
      { id: 'L10', type: 'fact', text: 'npm test exited 1 until the lockfile was regenerated',
        summary: 'npm test exited 1 until the lockfile was regenerated', status: 'confirmed', scope: 'project' },
      'not an object',
    ]
    writeFileSync(join(memory, 'entries.jsonl'), legacy.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8')

    // ── Scanning finds the store without wandering into noise ─────────────
    const scan = scanForStores(dir)
    eq(scan.stores.length, 1, 'exactly one store is discovered')
    eq(scan.stores[0]?.records.length, legacy.length, 'every line is read')
    eq(scan.errors, [], 'a readable tree reports no errors')

    // ── Mapping ───────────────────────────────────────────────────────────
    const mapped = mapStore(scan.stores[0]!, NOW)
    eq(mapped.records.length, 5, 'five of eleven entries map onto the new schema')
    eq(mapped.skipped['no text'], 1, 'an entry with no text is skipped, not guessed at')
    eq(mapped.skipped['unknown type (nonsense)'], 1, 'an unknown type is skipped, named')
    eq(mapped.skipped['event record, not durable knowledge (failure)'], 1,
      'a work-history event is left behind rather than imported as experience')
    eq(mapped.skipped['tool-outcome event, not durable knowledge'], 2,
      'a tool failure recorded as `fact` with tool proof is skipped, not imported as a verified fact')
    eq(mapped.skipped['not an object'], 1, 'a non-object line is skipped')
    eq(mapped.globalDowngraded, 1, 'a legacy global record is reported as pulled back to local')
    assert(mapped.records.some(r => r.body.startsWith('npm test exited 1')),
      'a real lesson that merely mentions a failing command is still imported')

    const first = mapped.records[0]!
    eq(first.kind, 'fact', 'type maps to kind')
    eq(first.status, 'confirmed', 'a confirmed legacy record stays confirmed')
    eq(first.evidence, 'verified-user', 'proof kind maps to an evidence grade')
    eq(first.title, '部署一律写到 F 盘', 'the old summary label is stripped from the title')
    eq(first.scope, 'workspace', 'a project record becomes workspace-scoped')
    eq(first.domain, 'acme/legacy-tool', 'the domain is inferred from the manifest')
    eq(first.createdAt, Date.parse('2026-09-01T00:00:00+00:00'), 'the legacy timestamp is preserved')

    const second = mapped.records[1]!
    eq(second.status, 'confirmed', 'the legacy `active` status maps to confirmed')
    eq(second.evidence, 'verified-tool', 'tool proof is the strongest grade')
    eq(second.trigger, '部署 磁盘', 'the legacy subject becomes the trigger')

    const third = mapped.records[2]!
    eq(third.kind, 'strategy', 'capability folds into strategy')
    eq(third.evidence, 'inferred', 'no proof means an inference')
    eq(third.scope, 'workspace', 'a global record does not stay global')

    const archived = mapped.records.find(r => r.body === '已归档的记录')
    eq(archived?.status, 'retired', 'an archived record imports as retired')

    // ── Dry run writes nothing ────────────────────────────────────────────
    const dry = runImport(db, scan, { apply: false, now: NOW })
    eq(dry.mapped, 5, 'the dry run reports the same mapping')
    eq(dry.inserted, 0, 'a dry run inserts nothing')
    const count = (db.prepare('SELECT count(*) AS n FROM record').get() as { n: number }).n
    eq(count, 0, 'and leaves the database untouched')

    // ── Apply writes, and re-applying merges instead of duplicating ────────
    const applied = runImport(db, scan, { apply: true, now: NOW })
    eq(applied.inserted, 5, 'the apply inserts every mapped record')
    eq(applied.merged, 0, 'with nothing to merge on a first pass')

    const again = runImport(db, scan, { apply: true, now: NOW + 1000 })
    eq(again.inserted, 0, 'a second pass inserts nothing')
    eq(again.merged, 5, 'it merges every record instead')
    const after = (db.prepare('SELECT count(*) AS n FROM record').get() as { n: number }).n
    eq(after, 5, 'and the store still holds one row per record, not one per pass')

    // ── Imported verified records keep their grade rather than being demoted ─
    const kept = db.prepare("SELECT count(*) AS n FROM record WHERE evidence != 'inferred'").get() as { n: number }
    assert(kept.n >= 2, 'a migration must not demote the verified records it imports')

    // ── The title is a label, so the same body twice is one record ─────────
    // The archived tree held 28 pairs with identical bodies and different
    // generated titles. Identity has to ignore the label: otherwise one lesson
    // imports as two records, and the same lesson learned in two projects never
    // corroborates, so it can never be promoted to domain scope.
    const titled = join(dir, 'titled-project')
    const titledMemory = join(titled, '.memory')
    mkdirSync(titledMemory, { recursive: true })
    writeFileSync(join(titled, 'package.json'), JSON.stringify({ name: '@acme/titled' }))
    writeFileSync(join(titledMemory, 'entries.jsonl'), [
      { type: 'fact', text: '部署一律写到 F 盘', summary: '已核验静态：部署目标盘', status: 'confirmed', scope: 'project' },
      { type: 'fact', text: '部署一律写到 F 盘', summary: '部署目标盘', status: 'confirmed', scope: 'project' },
    ].map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8')

    const titledScan = scanForStores(titled)
    eq(titledScan.stores.length, 1, 'the differently labelled store is found')
    eq(mapStore(titledScan.stores[0]!, NOW).records.length, 2, 'both entries map, since their labels differ')

    const titledDb: DatabaseSync = openDb(join(dir, 'titled.db'))
    try {
      const titledOutcome = runImport(titledDb, titledScan, { apply: true, now: NOW })
      eq(titledOutcome.inserted, 1, 'but only one row is written, because the body is the identity')
      eq(titledOutcome.merged, 1, 'the second is merged into the first')
      eq((titledDb.prepare('SELECT count(*) AS n FROM record').get() as { n: number }).n, 1,
        'so the store holds one row, not two')
    } finally {
      titledDb.close()
    }

    // ── A repeated write is the same record, not new knowledge ────────────
    const repeatedRoot = join(dir, 'repeated-project')
    const repeatedMemory = join(repeatedRoot, '.memory')
    mkdirSync(repeatedMemory, { recursive: true })
    writeFileSync(join(repeatedRoot, 'package.json'), JSON.stringify({ name: '@acme/repeated' }))
    writeFileSync(join(repeatedMemory, 'entries.jsonl'), [
      '2026-09-01', '2026-09-05', '2026-09-09',
    ].map(day => JSON.stringify({
      type: 'experience', text: '失败后先备份', summary: '经验：失败后先备份',
      status: 'confirmed', scope: 'project', created_at: `${day}T00:00:00+00:00`,
    })).join('\n') + '\n', 'utf8')

    const repeatedScan = scanForStores(repeatedRoot)
    eq(repeatedScan.stores[0]?.records.length, 1, 'three writes of one assertion read as one record')
    eq(repeatedScan.stores[0]?.duplicates, 2, 'and the repeats are reported rather than hidden')
    const repeatedPlan = runImport(db, repeatedScan, { apply: false, now: NOW })
    eq(repeatedPlan.found, 3, 'the raw count still says what the store actually held')
    eq(repeatedPlan.duplicateRecords, 2, 'and the duplicate count is reported')

    // ── A copy of a store is not a store ──────────────────────────────────
    // Backups, packaged copies and evaluation pilots sit next to live stores in
    // the archived tree. Importing them multiplies one lesson by the number of
    // snapshots that happen to exist.
    const copiesRoot = join(dir, 'copies')
    const copies: ReadonlyArray<readonly [string, readonly string[]]> = [
      ['backup', ['.codex', 'project-memory-backups', 'full-20260101-000000']],
      ['dev copy', ['.dev-packages', 'batch-0.6.1', 'failed-rehearsal-copy']],
      ['eval pilot', ['.eval-pilots', 'pilot-1', 'case-1']],
    ]
    for (const [label, segments] of copies) {
      const memory = join(copiesRoot, ...segments, '.memory')
      mkdirSync(memory, { recursive: true })
      writeFileSync(join(memory, 'entries.jsonl'),
        `${JSON.stringify({ type: 'fact', text: `${label} 的内容`, summary: label })}\n`, 'utf8')
    }
    const copyScan = scanForStores(copiesRoot)
    eq(copyScan.stores, [], 'a copy is not imported as a live store')
    eq(copyScan.excluded.length, 3, 'every copy is reported instead of silently dropped')
    assert(copyScan.excluded.every(item => item.reason !== ''), 'each copy carries a reason')

    // ── A selection file limits the import, and a dry run reports it ───────
    // The audit decides what deserves importing; the importer only obeys. So the
    // filter has to work from a list of record identities alone, and a dry run has
    // to show the effect before anything is written.
    const selectRoot = join(dir, 'select-project')
    const selectMemory = join(selectRoot, '.memory')
    mkdirSync(selectMemory, { recursive: true })
    writeFileSync(join(selectRoot, 'package.json'), JSON.stringify({ name: '@acme/select' }))
    writeFileSync(join(selectMemory, 'entries.jsonl'), [
      '保留这一条记录', '这一条不要'
    ].map(text => JSON.stringify({
      type: 'fact', text, summary: text, status: 'confirmed', scope: 'project',
    })).join('\n') + '\n', 'utf8')

    const selectScan = scanForStores(selectRoot)
    const selectMapped = mapStore(selectScan.stores[0]!, NOW).records
    eq(selectMapped.length, 2, 'both records are mappable')
    const keep = selectMapped.find(record => record.body === '保留这一条记录')!
    const chosen = new Set([selectionKey(keep)])

    const selectDb: DatabaseSync = openDb(join(dir, 'select.db'))
    try {
      const drySelect = runImport(selectDb, selectScan, { apply: false, now: NOW, selection: chosen })
      eq(drySelect.mapped, 2, 'the dry run still reports everything that maps')
      eq(drySelect.unselected, 1, 'and reports what the selection excludes')
      eq((selectDb.prepare('SELECT count(*) AS n FROM record').get() as { n: number }).n, 0,
        'without writing anything')

      const applied2 = runImport(selectDb, selectScan, { apply: true, now: NOW, selection: chosen })
      eq(applied2.inserted, 1, 'only the selected record is written')
      const kept = selectDb.prepare('SELECT body FROM record').all() as { body: string }[]
      eq(kept.map(row => row.body), ['保留这一条记录'], 'and it is the right one')

      // An empty selection is a valid answer: import nothing rather than everything.
      const emptyDb: DatabaseSync = openDb(join(dir, 'empty.db'))
      try {
        const none = runImport(emptyDb, selectScan, { apply: true, now: NOW, selection: new Set() })
        eq(none.inserted, 0, 'an empty selection writes nothing')
        eq(none.unselected, 2, 'and says so, rather than silently importing all of it')
      } finally {
        emptyDb.close()
      }
    } finally {
      selectDb.close()
    }

    // ── An unreadable path is reported, never thrown ──────────────────────
    const missing = scanForStores(join(dir, 'does-not-exist'))
    eq(missing.stores, [], 'a missing root yields no stores')
    eq(missing.errors.length, 1, 'and is reported as an error rather than crashing')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }

  console.log('  import     ok')
}
