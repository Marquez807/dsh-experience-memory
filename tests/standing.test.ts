/**
 * The standing layer: rules carried on every turn, whatever the turn is about.
 *
 * Why this suite exists — the gap it closes was measured, not imagined. A rule like "always
 * answer in Chinese" was written into the live store and never arrived, because neither layer
 * that already existed can carry it: the query layer shares no term with 「帮我看看这个仓库」,
 * and the core layer requires two independent workspaces to have reported the same thing, which
 * a personal rule never will.
 *
 * Every assertion here is a pair. What the flag buys, and what it must not buy: it skips the
 * query gate, and it changes nothing else — a weak record marked standing has to stay silent,
 * the byte budget has to hold, and one record must not be printed twice.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, eq } from './assert.ts'
import { getRecord, migrate, openDb, SCHEMA_VERSION, upsert } from '../src/db.ts'
import { buildDigest, MATCHED_LABEL, STANDING_LABEL } from '../src/digest.ts'
import { byteLength } from '../src/inject.ts'
import { resolveConfig } from '../src/config.ts'
import type { MemoryRecord } from '../src/types.ts'

const NOW = 1_800_000_000_000
const WS = { id: 'wsA', domain: '' }

function make(over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'r1',
    workspaceId: WS.id,
    domain: '',
    scope: 'workspace',
    kind: 'fact',
    status: 'confirmed',
    evidence: 'verified-user',
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
    contentFingerprint: 'fp',
    supersededBy: null,
    needsReview: null,
    standing: false,
    ...over,
  }
}

export function run(): void {
  const dir = mkdtempSync(join(tmpdir(), 'expmem-standing-'))
  const db = openDb(join(dir, 'memory.db'))

  try {
    const config = resolveConfig({})
    const digest = (query: string, over: Parameters<typeof resolveConfig>[0] = {}): string =>
      buildDigest({ db, config: resolveConfig(over), workspace: WS, query, now: NOW })
    const recordLines = (text: string): string[] => text.split('\n').filter(line => line.startsWith('- ['))

    // ── The flag survives a write and a read ───────────────────────────────
    upsert(db, make({ id: 'plain', contentFingerprint: 'fp-plain' }))
    upsert(db, make({
      id: 'rule', contentFingerprint: 'fp-rule', standing: true,
      title: '常驻规矩', body: '所有会话一律用简体中文回答', lesson: '一律用中文',
    }))
    eq(getRecord(db, 'plain')?.standing, false,
      'a record written without the flag is not standing — the default is off, not on')
    eq(getRecord(db, 'rule')?.standing, true, 'a record written with the flag reads back as standing')

    // ── Paired control: the same record, with and without the flag ─────────
    // Same row, same query, one boolean apart. This is the whole claim of the feature.
    const unrelated = '帮我看看这个仓库'
    assert(digest(unrelated).includes(STANDING_LABEL),
      'a standing rule is carried on a turn that shares no term with it')
    assert(digest(unrelated).includes('常驻规矩'),
      'and the rule itself is the line that appears, not just its header')
    eq(recordLines(digest(unrelated)).length, 1,
      'the record without the flag stays out of that same turn — evidence the flag is what did it')

    upsert(db, make({
      id: 'rule', contentFingerprint: 'fp-rule', standing: false,
      title: '常驻规矩', body: '所有会话一律用简体中文回答', lesson: '一律用中文',
    }))
    eq(digest(unrelated), '',
      'with the flag off, the identical record produces no digest at all — the negative control')
    upsert(db, make({
      id: 'rule', contentFingerprint: 'fp-rule', standing: true,
      title: '常驻规矩', body: '所有会话一律用简体中文回答', lesson: '一律用中文',
    }))

    // ── The flag is not a bypass of the resident bar ───────────────────────
    // `standing` skips the query gate and nothing else. If it also skipped the grade gate, then
    // any guess could be made always-on — the one property this framework exists to prevent.
    upsert(db, make({
      id: 'guess', contentFingerprint: 'fp-guess', standing: true, evidence: 'inferred',
      title: '没核实的猜测', body: '猜测正文', lesson: '猜测教训',
    }))
    upsert(db, make({
      id: 'candidate', contentFingerprint: 'fp-candidate', standing: true, status: 'candidate',
      title: '还没确认的候选', body: '候选正文', lesson: '候选教训',
    }))
    const guarded = digest(unrelated)
    assert(!guarded.includes('没核实的猜测'), 'an inferred record marked standing is still not carried')
    assert(!guarded.includes('还没确认的候选'), 'a candidate marked standing is still not carried')

    // ── A rule that is also query-matched is printed once ──────────────────
    const matching = digest('常驻规矩')
    // Counted by record line, not by title text: the standing header itself contains 「常驻规矩」,
    // so a text count would have measured the label and called it a duplicate.
    eq(matching.split('- [rule]').length - 1, 1,
      'a record that is both standing and query-matched appears exactly once')
    assert(matching.includes(STANDING_LABEL), 'and it appears under the standing label, the stronger claim')
    assert(!matching.includes(MATCHED_LABEL), 'so it is not repeated under the matched label')

    // ── The caps: per section, and inside the shared budget ────────────────
    for (let index = 0; index < 4; index += 1) {
      upsert(db, make({
        id: `extra${index}`, contentFingerprint: `fp-extra${index}`, standing: true,
        title: `常驻${index}`, body: '与查询无关的规矩正文', lesson: `规矩${index}`,
      }))
    }
    eq(config.standingMaxRecords, 3, 'the shipped ceiling for standing rules is 3')
    eq(recordLines(digest(unrelated)).length, 3,
      'standingMaxRecords caps the standing section, exactly as coreMaxRecords caps the core one')
    eq(recordLines(digest(unrelated, { standingMaxRecords: 1 })).length, 1,
      'and lowering the ceiling lowers the number of rules carried')
    eq(digest(unrelated, { standingMaxRecords: 0 }), '',
      'standingMaxRecords: 0 switches the layer off without touching a single record')

    // A long rule must not be able to eat the section that answers the turn in front of it.
    upsert(db, make({
      id: 'long', contentFingerprint: 'fp-long', standing: true,
      title: '很长的一条规矩', body: '啰'.repeat(600), lesson: '啰'.repeat(600),
    }))
    const tight = digest(unrelated, { standingMaxRecords: 5, standingMaxBytes: 300 })
    assert(byteLength(tight) <= 300,
      `the standing section respects its own ${300}-byte ceiling; it is ${byteLength(tight)}`)
    assert(recordLines(tight).length >= 1, 'and it still carries at least one rule rather than nothing')
    // A rule that did not fit is said out loud. This layer is the one that promised to be present
    // every turn, so a silent drop would break that promise invisibly — the failure mode this
    // project keeps finding in its own tools.
    assert(/另有 \d+ 条常驻规矩被这一段 300 字节的上限挡住/.test(tight),
      `a rule dropped by the section ceiling is reported, with the knob named; digest was: ${tight}`)

    for (let index = 0; index < 20; index += 1) {
      upsert(db, make({
        id: `m${index}`, contentFingerprint: `fp-m${index}`,
        title: `相关${index}`, body: '仓库', lesson: '相关教训',
      }))
    }
    const both = digest('仓库', { standingMaxRecords: 5, residentMaxRecords: 20 })
    assert(both.includes(STANDING_LABEL) && both.includes(MATCHED_LABEL),
      'a turn can carry a standing rule and query-matched records at the same time')
    assert(byteLength(both) <= config.residentMaxBytes,
      `all sections together still respect the one shared ${config.residentMaxBytes}-byte ceiling;`
      + ` this digest is ${byteLength(both)}`)

    // ── Migration: an older store gains the column, and keeps its meaning ──
    // The column is added by inspection rather than by version number, so the honest test is a
    // store that really lacks it. Dropping it and re-migrating is that store.
    db.exec('ALTER TABLE record DROP COLUMN standing')
    db.exec('PRAGMA user_version = 7')
    migrate(db)
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    eq(version, SCHEMA_VERSION, 'migrating an older store lands on the current schema version')
    eq(getRecord(db, 'rule')?.standing, false,
      'and every pre-existing row comes back as not-standing: nobody ever declared those rules,'
      + ' so back-filling the flag from anything would be inventing a decision')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}
