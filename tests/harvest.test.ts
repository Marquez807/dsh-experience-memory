/**
 * Turn-harvest regressions.
 *
 * The harvester exists because recording depends on the model choosing to record, and a
 * measured five-session run showed it never choosing until it was told. What has to hold
 * is that the safety net stays a net: precision over recall, verbatim over paraphrased,
 * candidate over claim.
 *
 * Every detector is pinned twice — once on the shape it must catch and once on the shape
 * closest to it that it must not — because a detector that fires on everything is
 * indistinguishable from no filter at all.
 */
import { assert, eq } from './assert.ts'
import { harvestFrom, lastTurn, type HarvestSignal } from '../src/harvest.ts'
import { openDb, getRecord } from '../src/db.ts'
import { harvest, maintain } from '../src/lifecycle.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEventLike } from '../src/types.ts'

const NOW = 1_800_000_000_000
const DAY = 86_400_000

const user = (text: string, kind = 'user'): SessionEventLike => ({
  type: 'user/message',
  data: { source: { kind }, content: [{ type: 'text', text }] },
})

const assistant = (text: string): SessionEventLike => ({
  type: 'assistant/message',
  data: { role: 'assistant', content: [{ type: 'text', text }] },
})

const turnStart = (turn: number): SessionEventLike => ({ type: 'turn/start', data: { turn } })

const toolCall = (callId: string, name: string): SessionEventLike => ({
  type: 'tool/call',
  data: { callId, name },
})

const toolResult = (callId: string, text: string, isError: boolean): SessionEventLike => ({
  type: 'tool/result',
  data: {
    message: {
      source: { kind: 'tool', callId },
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError }],
    },
  },
})

const signalOf = (events: SessionEventLike[]): HarvestSignal | undefined =>
  harvestFrom(events)?.signal

export function run(): void {
  // ── The turn boundary is where harvesting starts ──────────────────────────
  const twoTurns = [turnStart(1), user('旧的一轮'), turnStart(2), user('新的一轮内容')]
  eq(lastTurn(twoTurns).length, 2, 'only the newest turn is harvested, not the whole session')
  eq(lastTurn(twoTurns)[0]?.type, 'turn/start', 'and it starts at that turn boundary')
  // A hand-built session, or a log that begins mid-turn, still has to harvest something —
  // the alternative is silently doing nothing, which is the failure this module exists for.
  eq(lastTurn([user('没有轮次边界的会话')]).length, 1, 'a log with no boundary is taken as it is')

  // ── Failure then success, the highest-precision moment ────────────────────
  eq(signalOf([
    toolCall('c1', 'pwsh'),
    toolResult('c1', 'Error: present accepts 1 to 8 files', true),
    toolCall('c2', 'pwsh'),
    toolResult('c2', 'ok', false),
  ]), 'failure-recovered', 'a tool that failed and then worked is a lesson')
  const repaired = harvestFrom([
    toolCall('c1', 'pwsh'),
    toolResult('c1', 'Error: present accepts 1 to 8 files', true),
    toolCall('c2', 'pwsh'),
    toolResult('c2', 'ok', false),
  ])
  assert(repaired !== undefined && repaired.text.includes('present accepts 1 to 8 files'),
    `and the failure text is kept verbatim, because that is what a later session searches for: ${repaired?.text}`)
  // Failure alone is not a lesson: something has to have worked afterwards.
  eq(signalOf([
    toolCall('c1', 'pwsh'),
    toolResult('c1', 'Error: boom', true),
  ]), undefined, 'a failure with no recovery is not yet a lesson')
  // A success of a *different* tool is not a recovery of this one.
  eq(signalOf([
    toolCall('c1', 'pwsh'),
    toolResult('c1', 'Error: boom', true),
    toolCall('c2', 'read'),
    toolResult('c2', 'ok', false),
  ]), undefined, 'a different tool succeeding does not repair the one that failed')

  // ── User correction ───────────────────────────────────────────────────────
  eq(signalOf([assistant('部署写到 C 盘'), user('不对，部署一律写到 F 盘')]),
    'user-correction', 'a correction is recognised by what it says, not by its shape')
  eq(signalOf([assistant('部署写到 C 盘'), user('部署写到 C 盘，对吗？')]),
    undefined, 'a question is a request for information, not a correction')

  // ── User statement: the broad case, and the reason imperatives are not the rule ──
  // None of these is a command. All of them are the shape most lessons actually arrive in.
  for (const line of [
    '原来那个 bug 是因为 junction 的路径和 realpath 对不上',
    '这个 API 在 1.5.2 里不触发 OnGameLoaded',
    '最后发现要加 --preserve-symlinks 才行',
  ]) {
    eq(signalOf([user(line)]), 'user-statement', `a statement naming something concrete is harvested: ${line}`)
  }
  eq(signalOf([user('以后一律用 F 盘')]), 'user-statement', 'a durable rule is harvested as well')
  // And the negatives that keep the broad detector from becoming a firehose.
  eq(signalOf([user('现在几点了？')]), undefined, 'a question is never harvested')
  eq(signalOf([user('好的，继续')]), undefined, 'a bare acknowledgement carries nothing to keep')
  eq(signalOf([user('嗯')]), undefined, 'and a fragment is below the length floor')
  // Our own injected context is a plugin-sourced message, not the user speaking.
  eq(signalOf([user('这个 API 在 1.5.2 里不触发 OnGameLoaded', 'plugin')]),
    undefined, 'a plugin-sourced message is never read as the user stating something')

  // ── Goal change and refusal ───────────────────────────────────────────────
  eq(signalOf([{ type: 'goal/change', data: { goal: { objective: '改成先做批次一' } } }]),
    'goal-changed', 'a changed goal is durable material')
  eq(signalOf([{ type: 'approval/decided', data: { outcome: 'allowed-once' } }]),
    undefined, 'an allowance is not a refusal')
  eq(signalOf([{ type: 'approval/decided', data: { outcome: 'denied' } }]),
    'action-refused', 'a refusal is')

  // ── The priority order: one turn, one moment, the strongest one ───────────
  eq(signalOf([
    toolCall('c1', 'pwsh'),
    toolResult('c1', 'Error: boom', true),
    toolCall('c2', 'pwsh'),
    toolResult('c2', 'ok', false),
    user('不对，应该用另一个命令'),
  ]), 'failure-recovered', 'a repaired failure outranks a correction in the same turn')

  // ── A harvested row is a candidate, and stays one ─────────────────────────
  const dir = mkdtempSync(join(tmpdir(), 'expmem-harvest-'))
  const db = openDb(join(dir, 'memory.db'))
  try {
    const sentence = '原来那个 bug 是因为 junction 的路径和 realpath 对不上'
    const candidate = harvestFrom([turnStart(1), user(sentence)])
    assert(candidate !== undefined, 'the statement is harvested')
    eq(harvest(db, { workspaceId: 'ws1', domain: '', candidate: candidate!, now: NOW }), 'created',
      'the sentence is filed')
    const rows = db.prepare('SELECT * FROM record').all() as { id: string; status: string; origin: string; evidence: string; needs_review: string }[]
    eq(rows.length, 1, 'exactly one row was written')
    eq(rows[0]?.status, 'candidate', 'and it is a candidate — the gate is what makes harvesting safe')
    eq(rows[0]?.origin, 'harvest', 'with its origin recorded, so a reader can audit who put it there')
    eq(rows[0]?.evidence, 'inferred', 'and no grade, because the harvester does not judge')
    assert(rows[0]?.needs_review !== null && rows[0]!.needs_review.includes('采集'),
      'and a review note saying where it came from')

    // Identity is the content, as everywhere else: the same sentence twice is one row.
    eq(harvest(db, { workspaceId: 'ws1', domain: '', candidate: candidate!, now: NOW + 1000 }), 'duplicate',
      'the same sentence harvested again does not add a second row')

    // The load-bearing property of the whole feature: this row's text is a verbatim user
    // sentence, so the ordinary grader would call it verified-user — and it must still be
    // invisible, because nobody has judged it yet.
    const stored = getRecord(db, rows[0]!.id)
    assert(stored !== undefined, 'the row reads back')
    eq(stored?.status, 'candidate', 'a verbatim user sentence from the harvester is still only a candidate')

    // ── Candidates age out; they never used to ─────────────────────────────
    const pass = maintain(db, {
      now: NOW + 20 * DAY, batchSize: 10, candidateTtlDays: 14, candidatePoolLimit: 200,
    })
    eq(pass.candidatesAged, 1, 'a candidate nobody confirmed and nobody searched for is retired')
    eq(getRecord(db, rows[0]!.id)?.status, 'retired', 'and retirement is what happened, not deletion')
    assert(getRecord(db, rows[0]!.id)?.body !== '', 'so it can be brought back')

    // ── But one that was searched out survives its window ──────────────────
    const keptCandidate = harvestFrom([turnStart(2), user('这条在 1.5.2 里不触发 OnGameLoaded')])
    harvest(db, { workspaceId: 'ws1', domain: '', candidate: keptCandidate!, now: NOW })
    const keptId = (db.prepare("SELECT id FROM record WHERE status = 'candidate'").get() as { id: string }).id
    db.prepare('UPDATE record SET retrieve_count = 1 WHERE id = ?').run(keptId)
    const later = maintain(db, {
      now: NOW + 20 * DAY, batchSize: 10, candidateTtlDays: 14, candidatePoolLimit: 200,
    })
    eq(later.candidatesAged, 0, 'someone reached for it, so age alone does not retire it')
    eq(getRecord(db, keptId)?.status, 'candidate', 'it is still a candidate, waiting for a judgement')

    // ── The pool ceiling holds the store bounded ───────────────────────────
    const many = mkdtempSync(join(tmpdir(), 'expmem-pool-'))
    const pool = openDb(join(many, 'memory.db'))
    try {
      for (let i = 0; i < 6; i += 1) {
        harvest(pool, {
          workspaceId: 'ws1', domain: '', now: NOW + i * 1000,
          candidate: { text: `第 ${i} 条采集的候选句子`, signal: 'user-statement', title: `候选${i}` },
        })
      }
      eq((pool.prepare("SELECT count(*) AS n FROM record WHERE status = 'candidate'").get() as { n: number }).n, 6,
        'six candidates are in the pool')
      const capped = maintain(pool, {
        now: NOW + 1000, batchSize: 10, candidateTtlDays: 365, candidatePoolLimit: 4,
      })
      eq(capped.candidatesEvicted, 2, 'the pool ceiling retires the overflow')
      eq((pool.prepare("SELECT count(*) AS n FROM record WHERE status = 'candidate'").get() as { n: number }).n, 4,
        'and the pool is exactly at its ceiling')
      // The oldest went, not the newest: a burst must not evict what just arrived.
      assert(getRecord(pool, (pool.prepare("SELECT id FROM record WHERE title = '候选0'").get() as { id: string }).id)?.status === 'retired',
        'the oldest candidate is the one retired')
  } finally {
      pool.close()
      rmSync(many, { recursive: true, force: true })
    }
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }

  console.log('  harvest    ok')
}
