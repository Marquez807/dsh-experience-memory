/**
 * Storage regressions.
 *
 * The archived system had a JSONL backend that searched the record body and a
 * SQLite backend that searched only `summary` (= `text[:150]`), so migrating
 * changed which memories were reachable in both directions. There is one
 * backend now, and it must search the body.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, eq } from './assert.ts'
import { candidates, defaultDbPath, findByFingerprint, getRecord, indexRow, openDb, upsert, SCHEMA_VERSION } from '../src/db.ts'
import { matchExpression } from '../src/tokenize.ts'
import type { MemoryRecord } from '../src/types.ts'

const NOW = 1_800_000_000_000

function make(over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'r1',
    workspaceId: 'ws1',
    domain: '',
    scope: 'workspace',
    kind: 'experience',
    status: 'confirmed',
    evidence: 'verified-tool',
    title: '标题',
    body: '正文',
    trigger: '',
    failureMode: '',
    lesson: '',
    sourceRef: '',
    reuseCount: 0,
    successCount: 0,
    failureCount: 0,
    failStreak: 0,
    distinctWorkspaces: 1,
    createdAt: NOW,
    occurredAt: NOW,
    updatedAt: NOW,
    lastUsedAt: null,
    reviewAfter: null,
    expiresAt: null,
    contentFingerprint: 'fp-r1',
    supersededBy: null,
    needsReview: null,
    ...over,
  }
}

export function run(): void {
  const dir = mkdtempSync(join(tmpdir(), 'expmem-'))
  const db = openDb(join(dir, 'memory.db'))

  try {
    // ── Schema ───────────────────────────────────────────────────────────────
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    // Derived, not transcribed: a schema bump must not leave the suite asserting a
    // version the store no longer stamps.
    eq(version, SCHEMA_VERSION, 'schema version is stamped')
    // Foreign keys must be on in the one place that opens a connection.
    const fk = (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys
    eq(fk, 1, 'foreign keys are enabled by openDb')

    // ── A store written by an older build gains the new columns ──────────────
    // `SCHEMA` is entirely `CREATE TABLE IF NOT EXISTS`, so adding a column to that
    // definition brings a *new* store up to date and does nothing at all to an existing
    // one — the column would silently never appear on anybody's real database. This
    // reproduces a store from before `retrieve_count` existed and reopens it.
    const legacyPath = join(dir, 'legacy.db')
    const older = openDb(legacyPath)
    upsert(older, make({ id: 'legacy-1', contentFingerprint: 'fp-legacy' }))
    older.exec('ALTER TABLE record DROP COLUMN retrieve_count')
    older.exec('ALTER TABLE record DROP COLUMN last_retrieved_at')
    older.exec('PRAGMA user_version = 1')
    older.close()

    const upgraded = openDb(legacyPath)
    try {
      const columns = (upgraded.prepare('PRAGMA table_info(record)').all() as { name: string }[])
        .map(column => column.name)
      assert(columns.includes('retrieve_count') && columns.includes('last_retrieved_at'),
        'reopening an older store adds the columns the schema now declares')
      eq((upgraded.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
        SCHEMA_VERSION, 'and stamps the new version')
      const kept = getRecord(upgraded, 'legacy-1')
      assert(kept !== undefined && kept.title === '标题', 'existing rows survive the upgrade')
      eq(kept?.retrieveCount, 0, 'and start out as never searched for')
      eq(kept?.lastRetrievedAt, null, 'with no retrieval time')
      // Schema 4 added a table rather than a column, and a table is the case
      // `CREATE TABLE IF NOT EXISTS` alone would *not* have covered if the version check
      // short-circuited: the whole file is IF NOT EXISTS, so it only ever runs when the
      // stamped version differs. Asserting the table here is what keeps that true.
      const tables = (upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
        .map(row => row.name)
      assert(tables.includes('failure_shape'),
        'and gains the failure-shape table the new schema declares')
      const rows = (upgraded.prepare('SELECT count(*) AS n FROM failure_shape').get() as { n: number }).n
      eq(rows, 0, 'which starts empty rather than guessing at history it never saw')
      // And the *column* path, which is the one every existing store takes: a store that already
      // has the table from schema 4 must gain the column schema 5 added. `CREATE TABLE IF NOT
      // EXISTS` does not do this, so exercise it instead of assuming it.
      upgraded.exec('ALTER TABLE failure_shape DROP COLUMN recent_at')
      upgraded.exec('PRAGMA user_version = 4')
    } finally {
      upgraded.close()
    }
    const recolumned = openDb(legacyPath)
    try {
      const columns = (recolumned.prepare('PRAGMA table_info(failure_shape)').all() as { name: string }[])
        .map(column => column.name)
      assert(columns.includes('recent_at'),
        'reopening a schema-4 store adds the occurrence timestamps schema 5 needs')
      eq((recolumned.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
        SCHEMA_VERSION, 'and stamps the version again')
    } finally {
      recolumned.close()
    }

    // ── Round trip ───────────────────────────────────────────────────────────
    upsert(db, make())
    const back = getRecord(db, 'r1')
    assert(back !== undefined, 'a written record reads back')
    eq(back?.title, '标题', 'title survives the round trip')
    eq(back?.contentFingerprint, 'fp-r1', 'fingerprint survives the round trip')
    eq(findByFingerprint(db, 'fp-r1', 'workspace', 'ws1', '')?.id, 'r1', 'fingerprint lookup works')

    // ── Identity is per scope, so two workspaces may hold the same lesson ────
    // This is the observation the domain promotion rule counts, so the schema
    // must not collapse the two copies into one.
    upsert(db, make({ id: 'ws1-copy', workspaceId: 'ws1', contentFingerprint: 'fp-shared-lesson' }))
    upsert(db, make({ id: 'ws2-copy', workspaceId: 'ws2', contentFingerprint: 'fp-shared-lesson' }))
    eq(findByFingerprint(db, 'fp-shared-lesson', 'workspace', 'ws2', '')?.id, 'ws2-copy',
      'the same lesson in another workspace is a separate record')
    // A domain record is unique within its domain instead.
    upsert(db, make({ id: 'dom-1', scope: 'domain', domain: 'python/testing', contentFingerprint: 'fp-dom' }))
    let collided = false
    try {
      upsert(db, make({ id: 'dom-2', scope: 'domain', domain: 'python/testing', contentFingerprint: 'fp-dom' }))
    } catch {
      collided = true
    }
    assert(collided, 'a duplicate domain record in the same domain is rejected')

    // ── Update in place keeps the body (no REPLACE-induced cascade) ──────────
    upsert(db, make({ title: '改过的标题' }))
    eq(getRecord(db, 'r1')?.title, '改过的标题', 'update in place changes the title')
    assert(getRecord(db, 'r1')?.body === '正文', 'update in place does not drop the body')
    const count = (db.prepare('SELECT count(*) AS n FROM record WHERE id = ?').get('r1') as { n: number }).n
    eq(count, 1, 'update in place does not duplicate the row')

    // ── H7: a term that appears ONLY in the body must be findable ────────────
    // Archived defect: the SQLite path searched `summary` only, and summary is
    // `text[:150]`, so anything past 150 characters was silently unfindable.
    const longBody = '铺垫内容。'.repeat(90) + ' 结论标记 OMEGATERM7788 出现在正文靠后位置。'
    upsert(db, make({
      id: 'r2', contentFingerprint: 'fp-r2',
      title: '短标题', body: longBody,
    }))
    assert(longBody.length > 400, 'the regression body is longer than any summary prefix')
    const found = candidates(db, matchExpression('OMEGATERM7788'), 10)
    eq(found.map(c => c.id), ['r2'], 'a term only in the body is reachable')

    // ── H2: every script the tokenizer accepts is actually searchable ────────
    upsert(db, make({ id: 'r3', contentFingerprint: 'fp-r3', title: 'кириллица', body: 'привет мир' }))
    eq(candidates(db, matchExpression('привет'), 10).map(c => c.id), ['r3'], 'Cyrillic is searchable end to end')

    upsert(db, make({ id: 'r4', contentFingerprint: 'fp-r4', title: '输出偏好', body: '用户偏好pytest框架' }))
    eq(candidates(db, matchExpression('pytest'), 10).map(c => c.id), ['r4'], 'a Latin word inside CJK is searchable end to end')
    eq(candidates(db, matchExpression('偏好'), 10).map(c => c.id), ['r4'], 'the CJK around it is searchable too')

    // ── Identifier exact match uses the folded key ───────────────────────────
    upsert(db, make({ id: 'r5', contentFingerprint: 'fp-r5', title: '入口', body: '改了 memory_mvp.py 的排序' }))
    eq(candidates(db, matchExpression('memory_mvp.py'), 10).map(c => c.id), ['r5'], 'an identifier phrase matches exactly')

    // ── H4: an unindexable query yields nothing, not arbitrary rows ──────────
    // Archived defect: `pack` without a query returned eight records chosen by
    // sorting uuid strings, so new memories had an `8/n` chance of appearing.
    eq(candidates(db, '', 10), [], 'an empty match returns no candidates')
    eq(candidates(db, matchExpression('，。！？'), 10), [], 'a punctuation-only query returns no candidates')

    // ── Column weighting: the trigger outranks the body ──────────────────────
    // `tokenize` deduplicates, so repetition cannot weight a column; the weight
    // has to come from FTS5's own column weights. This asserts the weights are
    // actually wired, not merely declared.
    upsert(db, make({ id: 'rTrig', contentFingerprint: 'fp-trig', title: '同', trigger: 'WEIGHTTERM', body: '别的' }))
    upsert(db, make({ id: 'rBody', contentFingerprint: 'fp-body', title: '同', trigger: '', body: 'WEIGHTTERM 只出现在正文里' }))
    const weighted = candidates(db, matchExpression('WEIGHTTERM'), 10)
    eq(weighted.length, 2, 'both records match the term')
    eq(weighted[0]?.id, 'rTrig', 'a trigger match ranks above a body-only match')
    assert((weighted[0]?.bm25 ?? 0) < (weighted[1]?.bm25 ?? 0), 'the trigger row scores strictly better under bm25')

    // indexRow returns one entry per indexed column, in schema order.
    eq(indexRow(make({ title: 'A', trigger: 'B', failureMode: 'C', lesson: 'D', body: 'E' })).length, 5,
      'indexRow produces one column per indexed field')

    // ── Domain segments are individually searchable ──────────────────────────
    upsert(db, make({ id: 'r6', contentFingerprint: 'fp-r6', scope: 'domain', domain: 'python/testing', title: 'x', body: 'y' }))
    const domainHits = candidates(db, matchExpression('testing'), 20).map(c => c.id)
    assert(domainHits.includes('r6'), 'a domain segment answers a partial query')

    // ── Default path honours DSH_HOME ────────────────────────────────────────
    const previous = process.env['DSH_HOME']
    process.env['DSH_HOME'] = 'C:\\fake-home'
    assert(defaultDbPath().startsWith('C:\\fake-home'), 'defaultDbPath uses DSH_HOME')
    if (previous === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = previous
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }

  console.log('  db         ok')
}
