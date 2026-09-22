/**
 * The observation layer: what keeps failing, counted and never judged.
 *
 * The case for this suite is measured, not argued. Seven days of this harness: 358 tool
 * failures in 63 sessions, and the shape that recurred most — an edit refused because the file
 * had not been read, 143 times in 5 sessions — had no covering record in a store of 59. The
 * framework had read every one of those failures and thrown them away by design
 * (`harvest.ts` skips the agent's own tooling). That rule is right for *"should this become a
 * lesson"* and wrong for *"is this happening at all"*, and the difference is exactly what these
 * tests pin: counting must not inherit the lesson path's filter, and nothing counted may reach
 * the prompt.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, failureShapes, countFailureShapes, noteDelivery, noteFailureShape } from '../src/db.ts'
import { LESSON_IGNORED_MIN, failureShape, failuresIn, gapKeywords, gapReport, noteFailures } from '../src/failure.ts'
import { assert, eq } from './assert.ts'
import type { SessionEventLike } from '../src/types.ts'

/** A `tool/result` exactly as a real session logs one: `isError` on the result block. */
function failedCall(callId: string, name: string, text: string): SessionEventLike[] {
  return [
    { type: 'tool/call', data: { name, callId, arguments: '{}' } },
    {
      type: 'tool/result',
      data: {
        message: {
          role: 'tool',
          source: { kind: 'tool', callId },
          content: [{ type: 'tool-result', toolCallId: callId, isError: true, content: [{ type: 'text', text }] }],
        },
      },
    },
  ]
}

function okCall(callId: string, name: string, text: string): SessionEventLike[] {
  return [
    { type: 'tool/call', data: { name, callId, arguments: '{}' } },
    {
      type: 'tool/result',
      data: {
        message: {
          role: 'tool',
          source: { kind: 'tool', callId },
          content: [{ type: 'tool-result', toolCallId: callId, isError: false, content: [{ type: 'text', text }] }],
        },
      },
    },
  ]
}

const agentWith = (events: readonly SessionEventLike[]) => ({
  id: 'session-failure',
  session: { header: { cwd: 'F:\\probe' }, snapshotEvents: () => events },
})

export async function run(): Promise<void> {
  // ── The shape has to survive what differs every time ──────────────────────
  // If the file name stayed in, every occurrence would be its own row and the count would
  // always be one — the whole feature would report nothing while looking like it worked.
  const one = failureShape('Error: cannot modify "F:\\a\\b.ts": file has not been read — read the file, then retry')
  const two = failureShape('Error: cannot modify "F:\\other\\deep\\c.py": file has not been read — read the file, then retry')
  eq(one, two, 'the same failure in two different files is one shape')
  assert(!one.includes('b.ts') && !one.includes('other'),
    `and the path is gone from it: ${one}`)
  // Two different failures must not collapse into one, or the count would be meaningless.
  assert(one !== failureShape('Error: old_string was not found in "F:\\a\\b.ts"'),
    'two different failures stay two shapes')
  // Only the first line: a stack trace would defeat the point of a shape.
  assert(!failureShape('Error: boom\n  at foo (bar.ts:12)\n  at baz').includes('bar.ts'),
    'the trace below the first line is dropped')
  // Ids and numbers are the other half of "differs every time".
  eq(failureShape('Error: offset 318 is out of range for "x"'),
    failureShape('Error: offset 902 is out of range for "y"'),
    'numbers and quoted values collapse too')
  // An *unquoted* path is the case that makes the path rule load-bearing rather than
  // redundant with the quoted-span rule: without it, two files would be two shapes.
  eq(failureShape('Error: cannot read F:\\one\\a.ts: not found'),
    failureShape('Error: cannot read F:\\two\\deep\\b.py: not found'),
    'a path outside quotes collapses the same way')

  // ── Reading failures out of a real session shape ──────────────────────────
  // The nesting is the part that was wrong the first time this was written by hand: `isError`
  // is on the tool-result block inside `data.message.content`, not on `data` or on the message.
  // Getting it wrong produced "0 failures", which looks exactly like a healthy workspace.
  const turn: SessionEventLike[] = [
    { type: 'turn/start', data: { turn: 1 } },
    ...failedCall('c1', 'edit', 'Error: cannot modify "F:\\a\\b.ts": file has not been read — read the file, then retry'),
    ...okCall('c2', 'read', 'contents'),
    ...failedCall('c3', 'edit', 'Error: cannot modify "F:\\a\\c.ts": file has not been read — read the file, then retry'),
    ...failedCall('c4', 'pwsh', 'Error: something else entirely'),
  ]
  const observed = failuresIn(turn)
  eq(observed.length, 3, 'every failed call in the turn is seen, and the successful one is not')
  eq(observed[0]?.tool, 'edit', 'each failure is attributed to the tool that produced it')
  eq(observed[0]?.shape, observed[1]?.shape, 'the two edit failures are the same shape')
  assert((observed[0]?.sample ?? '').startsWith('Error: cannot modify'),
    `the sample keeps the real first line: ${observed[0]?.sample}`)

  // ── The filter that must NOT apply here ───────────────────────────────────
  // `harvest.ts` skips the agent's own tooling, because "the agent used its own editor wrong"
  // is not a lesson about the project. That judgement is about lessons. Counting asks a
  // different question, and these failures are 64% of everything that goes wrong — a counter
  // that skipped them would be measuring the wrong thing on purpose.
  assert(observed.some(entry => entry.tool === 'edit'),
    'a failure of the agent’s own edit tool is counted, even though the lesson path skips it')

  const dir = mkdtempSync(join(tmpdir(), 'expmem-failure-'))
  const dbPath = join(dir, 'memory.db')
  const db = openDb(dbPath)
  try {
    // ── Counting accumulates per shape, and remembers which sessions saw it ──
    const agent = agentWith(turn)
    eq(noteFailures(db, agent, 'ws1', 's1', 1000, { enabled: true, shapeLimit: 200 }), 3,
      'three failures were written')
    noteFailures(db, agent, 'ws1', 's2', 2000, { enabled: true, shapeLimit: 200 })
    const shapes = failureShapes(db, 'ws1', 10)
    eq(shapes.length, 2, 'two distinct shapes, not four rows')
    eq(shapes[0]?.count, 4, 'the repeated shape counted four times')
    eq(shapes[0]?.sessionIds.length, 2, 'and it remembers that two sessions produced it')
    eq(shapes[0]?.firstSeen, 1000, 'first seen is when it was first seen')
    eq(shapes[0]?.lastSeen, 2000, 'last seen moves')

    // An unknown workspace sees nothing: the report is per workspace, like every other read.
    eq(failureShapes(db, 'nobody', 10).length, 0, 'another workspace sees none of it')

    // Off means off: no rows, no growth.
    const before = countFailureShapes(db, 'ws1')
    eq(noteFailures(db, agent, 'ws1', 's3', 3000, { enabled: false, shapeLimit: 200 }), 0,
      'tracking disabled writes nothing')
    eq(countFailureShapes(db, 'ws1'), before, 'and the table is unchanged')

    // ── The table is bounded ─────────────────────────────────────────────────
    // A long-lived workspace mints a new shape whenever an error message changes by a word.
    // The shapes below differ by a *word*, not by a number: digits are normalized away, so
    // numbering them would have produced one shape and this test would have passed without
    // the eviction it means to check. (It did, until the mutation test caught it.)
    const distinct = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot',
      'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima']
    for (const [index, word] of distinct.entries()) {
      noteFailures(
        db,
        agentWith(failedCall(`x${index}`, 'pwsh', `Error: the ${word} subsystem refused the request`)),
        'ws2', 's1', 4000 + index, { enabled: true, shapeLimit: 5 },
      )
    }
    eq(countFailureShapes(db, 'ws2'), 5,
      `the shape table stays exactly at its ceiling, not above it: ${countFailureShapes(db, 'ws2')}`)

    // ── The report: which repeated failures have nothing covering them ───────
    const keywords = gapKeywords('edit', shapes[0]?.shape ?? '')
    assert(keywords.includes('edit'), `the tool name is always one of the words: ${keywords.join(', ')}`)
    const rows = gapReport(db, { workspaceId: 'ws1', domain: '', now: 5000, limit: 10, minCount: 2 })
    eq(rows.length, 2, 'both shapes in this workspace repeated at least twice')
    eq(rows[0]?.shape.tool, 'edit', 'and the most frequent one is first')
    eq(rows[0]?.shape.count, 4, 'with its real count')
    eq(rows[0]?.closest, undefined, 'and with an empty store, nothing is even close')
    eq(rows[0]?.bestScore, 0, 'which the score says plainly')
    eq(rows[0]?.workspaces, 1, 'the same shape is reported as living in one workspace')
    // A shape seen once is not a pattern: reporting it would be a list of every typo.
    const strict = gapReport(db, { workspaceId: 'ws1', domain: '', now: 5000, limit: 10, minCount: 5 })
    eq(strict.length, 0, 'raising the floor drops shapes that have not repeated enough')

    // A record that shares words with the shape is reported as *close*, with the score and the
    // record named — not as "covered", because the check is a keyword overlap and the two sides
    // are usually written in different languages. Reporting a verdict would be the exact defect
    // this whole audit was about: a check that looks like it verifies something and does not.
    db.prepare(
      "INSERT INTO record (id, workspace_id, domain, scope, kind, status, evidence, title, body,"
      + " trigger, failure_mode, lesson, source_ref, reuse_count, success_count, failure_count,"
      + " fail_streak, distinct_workspaces, created_at, occurred_at, updated_at, content_fingerprint)"
      + " VALUES ('r1', 'ws1', '', 'workspace', 'experience', 'confirmed', 'verified-file',"
      + " '改文件前必须先读', 'cannot modify: file has not been read，先读再改。',"
      + " 'edit 报 file has not been read 时', '', '先 read 再 edit', 'x.md', 0, 0, 0, 0, 1, 1, 1, 1, 'fp1')",
    ).run()
    const covered = gapReport(db, { workspaceId: 'ws1', domain: '', now: 5000, limit: 10, minCount: 2 })
    assert(covered[0]?.closest !== undefined,
      `a record that claims something about the failure scores above zero: ${covered[0]?.bestScore}/${covered[0]?.keywords.length}`)
    eq(covered[0]?.closest?.id, 'r1', 'the nearest record is named, so a reader can judge it')

    // ── Quoting an error is not covering it ─────────────────────────────────
    // Found by running the report for real rather than by imagining it: a 128-occurrence edit
    // failure "matched" a record about something else, because that record quotes the error text
    // in its body. What a record claims lives in its title, its "when this applies" line, its
    // failure mode and its lesson; the body is where error text gets quoted, so it is out.
    db.prepare(
      "INSERT INTO record (id, workspace_id, domain, scope, kind, status, evidence, title, body,"
      + " trigger, failure_mode, lesson, source_ref, reuse_count, success_count, failure_count,"
      + " fail_streak, distinct_workspaces, created_at, occurred_at, updated_at, content_fingerprint)"
      + " VALUES ('r2', 'ws1', '', 'workspace', 'experience', 'confirmed', 'verified-file',"
      + " '这条讲的完全是别的事', '举例：Error: cannot modify \"x\": file has not been read，retry 也没用',"
      + " '', '', '', 'y.md', 0, 0, 0, 0, 1, 1, 1, 1, 'fp2')",
    ).run()
    db.prepare("DELETE FROM record WHERE id = 'r1'").run()
    const quoteOnly = gapReport(db, { workspaceId: 'ws1', domain: '', now: 5000, limit: 10, minCount: 2 })
    eq(quoteOnly[0]?.closest, undefined,
      'a record that only quotes the error in its body is not counted as related')
    eq(quoteOnly[0]?.bestScore, 0, 'and its score stays zero')

    // ── Did the record that claims to cover it actually stop it? ─────────────
    // The question the observation layer exists to make answerable. Three conditions, all
    // required, and each is checked in both directions here — a false "your lesson is not
    // working" teaches the reader to distrust records that are fine, which costs more than
    // missing one that is not.
    db.prepare("DELETE FROM record WHERE id = 'r2'").run()
    // Real-scale clocks: the grace period is an hour, so a test that counts in milliseconds can
    // never satisfy it — which is how the first version of this passed nothing and proved nothing.
    const BASE = 1_800_000_000_000
    const MINUTE = 60_000
    const claim = 'edit cannot modify file has not been read retry'
    const writeRecord = (id: string, trigger: string, createdAt: number): void => {
      db.prepare(
        "INSERT INTO record (id, workspace_id, domain, scope, kind, status, evidence, title, body,"
        + " trigger, failure_mode, lesson, source_ref, reuse_count, success_count, failure_count,"
        + " fail_streak, distinct_workspaces, created_at, occurred_at, updated_at, content_fingerprint)"
        + ` VALUES ('${id}', 'ws1', '', 'workspace', 'experience', 'confirmed', 'verified-file',`
        + " '改文件前必须先读', '', ?, '', '', 'z.md', 0, 0, 0, 0, 1, ?, ?, ?, ?)",
      ).run(trigger, createdAt, createdAt, createdAt, `fp-${id}`)
    }
    const shapeOf = (rows: ReturnType<typeof gapReport>) => rows.find(row => row.shape.shape === 'cannot modify')
    const twoHoursLater = BASE + 2 * 60 * MINUTE

    // (a) A complete match that predates the repeats: the lesson is not working.
    writeRecord('r3', claim, BASE)
    for (const at of [BASE + 10 * MINUTE, BASE + 20 * MINUTE, BASE + 30 * MINUTE]) {
      noteFailureShape(db, { workspaceId: 'ws1', tool: 'edit', shape: 'cannot modify', sample: 'x', sessionId: 's9', at })
    }
    const flagged = shapeOf(gapReport(db, { workspaceId: 'ws1', domain: '', now: twoHoursLater, limit: 10, minCount: 1 }))
    eq(flagged?.lessonNotWorking, true,
      `a record that predates the repeats is flagged as not working (since ${flagged?.sinceRecord})`)
    eq(flagged?.sinceRecord, 3, 'and the count says how many repeats came after it')

    // (b) The same repeats, but the record was written *after* them: no flag. Timing is the whole
    // point — a lesson cannot be blamed for what already happened before it existed.
    db.prepare('UPDATE record SET created_at = ? WHERE id = ?').run(BASE + 90 * MINUTE, 'r3')
    const beforeOnly = shapeOf(gapReport(db, { workspaceId: 'ws1', domain: '', now: twoHoursLater, limit: 10, minCount: 1 }))
    eq(beforeOnly?.lessonNotWorking, false, 'repeats that all happened before the record are not its failure')

    // (c) A partial match never raises the flag, however much the shape repeats: one shared word
    // is a coincidence, not a claim about this failure. The fixture has to match *exactly one* of
    // the two keywords — the first version of this used a word that matched none, so it passed
    // for the wrong reason and the relaxed condition went undetected.
    db.prepare('UPDATE record SET created_at = ?, trigger = ? WHERE id = ?').run(BASE, 'edit', 'r3')
    const partial = shapeOf(gapReport(db, { workspaceId: 'ws1', domain: '', now: twoHoursLater, limit: 10, minCount: 1 }))
    eq(partial?.bestScore, 1, `the match shares exactly one keyword (${partial?.bestScore}/${partial?.keywords.length})`)
    assert((partial?.keywords.length ?? 0) > 1, 'and there is more than one keyword to share')
    eq(partial?.lessonNotWorking, false, 'and a partial match never claims the lesson failed')

    // (d) A complete match, but too few repeats after it: still not a verdict.
    db.prepare('UPDATE record SET created_at = ?, trigger = ? WHERE id = ?').run(BASE, claim, 'r3')
    db.prepare("DELETE FROM failure_shape WHERE shape = 'cannot modify'").run()
    for (const at of [BASE + 10 * MINUTE, BASE + 20 * MINUTE]) {
      noteFailureShape(db, { workspaceId: 'ws1', tool: 'edit', shape: 'cannot modify', sample: 'x', sessionId: 's9', at })
    }
    const tooFew = shapeOf(gapReport(db, { workspaceId: 'ws1', domain: '', now: twoHoursLater, limit: 10, minCount: 1 }))
    eq(tooFew?.lessonNotWorking, false, `two repeats are noise, not a verdict (needs ${LESSON_IGNORED_MIN})`)

    // (e) The record is complete and predates the repeats, but it was written a moment ago: no
    // flag yet. Without this, every new record would be accused of failing on the next mistake.
    db.prepare("DELETE FROM failure_shape WHERE shape = 'cannot modify'").run()
    db.prepare('UPDATE record SET created_at = ? WHERE id = ?').run(twoHoursLater - 5 * MINUTE, 'r3')
    for (const at of [twoHoursLater - 4 * MINUTE, twoHoursLater - 3 * MINUTE, twoHoursLater - 2 * MINUTE]) {
      noteFailureShape(db, { workspaceId: 'ws1', tool: 'edit', shape: 'cannot modify', sample: 'x', sessionId: 's9', at })
    }
    const fresh = shapeOf(gapReport(db, { workspaceId: 'ws1', domain: '', now: twoHoursLater, limit: 10, minCount: 1 }))
    eq(fresh?.lessonNotWorking, false, 'a record written minutes ago has not had a fair chance yet')

    // ── Was the lesson even delivered? ──────────────────────────────────────
    // The verdict this adds is the one the framework could not reach before: a record nobody
    // was shown and a record that was shown and ignored produced the same row. Every case
    // below differs from its neighbour in exactly one fact — the delivery — so a verdict that
    // ignored deliveries would pass (a) and (c) and still be wrong.
    db.prepare('UPDATE record SET created_at = ?, trigger = ? WHERE id = ?').run(BASE, claim, 'r3')
    const verdictOf = () => shapeOf(gapReport(db, { workspaceId: 'ws1', domain: '', now: twoHoursLater, limit: 10, minCount: 1 }))
    const resetShape = (sessionId: string): void => {
      db.prepare("DELETE FROM failure_shape WHERE shape = 'cannot modify'").run()
      for (const at of [BASE + 10 * MINUTE, BASE + 20 * MINUTE, BASE + 30 * MINUTE]) {
        noteFailureShape(db, { workspaceId: 'ws1', tool: 'edit', shape: 'cannot modify', sample: 'x', sessionId, at })
      }
    }
    db.prepare('DELETE FROM delivery').run()

    // (a) Nothing delivered: the failure is about a missing delivery, not a broken lesson.
    resetShape('s9')
    const undelivered = verdictOf()
    eq(undelivered?.verdict, 'not-delivered', 'no delivery before the failure is reported as such')
    eq(undelivered?.delivery.before, false, 'and the flag says nothing was put in front of the agent')

    // (c) A delivery in the same session of a record that does *not* claim to cover the shape:
    // the partial-match guard has to survive the delivery, or every delivered record would be
    // read as one that claimed to prevent this failure.
    db.prepare('UPDATE record SET trigger = ? WHERE id = ?').run('edit', 'r3')
    noteDelivery(db, { recordId: 'r3', sessionId: 's9', tool: 'edit', matched: ['edit'], at: BASE + 5 * MINUTE })
    const adjacent = verdictOf()
    eq(adjacent?.verdict, 'delivered-still-failed', 'a delivery in the same session is evidence it was shown')
    eq(adjacent?.delivery.bySession, 'session', 'and the session id is what linked them')
    eq(adjacent?.delivery.count, 1, 'with the delivery counted rather than merely flagged')
    eq(adjacent?.delivery.recordId, 'r3', 'and the delivery that decided it is named')

    // (d) The same delivery, with the record restored to a full keyword match: now it claims to
    // cover the shape, which is the case that used to be indistinguishable from (a).
    db.prepare('UPDATE record SET trigger = ? WHERE id = ?').run(claim, 'r3')
    eq(verdictOf()?.verdict, 'delivered-and-ignored', 'a full match that was delivered and ignored')

    // (d) A delivery from a different session, outside the window: it cannot be about this.
    // Without this case the session filter would be untested and (b) would pass on the clock.
    db.prepare('DELETE FROM delivery').run()
    noteDelivery(db, { recordId: 'r3', sessionId: 'other', tool: 'edit', matched: ['edit'], at: BASE - 2 * 60 * MINUTE })
    eq(verdictOf()?.verdict, 'not-delivered', 'a delivery long before and in another session does not count')

    // (e) A delivery after the failures happened: it cannot have prevented them. The direction of
    // time is the whole point, and `at <= lastSeen` is what enforces it.
    db.prepare('DELETE FROM delivery').run()
    noteDelivery(db, { recordId: 'r3', sessionId: 's9', tool: 'edit', matched: ['edit'], at: BASE + 40 * MINUTE })
    eq(verdictOf()?.verdict, 'not-delivered', 'a delivery after the failure does not count as having prevented it')

    // (f) A record with no session id at all still associates by the window, and says so — the
    // weaker link is labelled rather than passed off as the strong one. The shape has to carry
    // no session id either: the clock is a fallback for a shape that never recorded one, not a
    // second chance for a delivery that shares none.
    db.prepare('DELETE FROM delivery').run()
    resetShape('')
    noteDelivery(db, { recordId: 'r3', tool: 'edit', matched: ['edit'], at: BASE + 25 * MINUTE })
    const byWindow = verdictOf()
    eq(byWindow?.verdict, 'delivered-and-ignored', 'the clock alone can associate a delivery')
    eq(byWindow?.delivery.bySession, 'window', 'and the report names the weaker rule it used')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }

  console.log('  failure    ok')
}
