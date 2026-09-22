/**
 * What the store actually holds.
 *
 * "Is it in the store?" and "why is it not in the prompt?" are different
 * questions, and answering the second without the first is how a retrieval
 * problem gets misdiagnosed as a missing record. This reports both: the counts a
 * reader can check, and how many records would currently clear the resident bar.
 *
 * It also reads the append-only `usage` and `correction` tables. Those were
 * written and never read by anything, so "why did this lose its place, or leave
 * entirely?" had no answer short of opening SQLite by hand.
 */
import type { DatabaseSync } from 'node:sqlite'
import { confirmedAfter, deliveryTotals } from './db.ts'
import { eligibleForResident, importance, RESIDENT_MIN_IMPORTANCE } from './rank.ts'

/** Confirmed records examined when counting resident-eligible ones. */
export const CENSUS_SCAN_LIMIT = 2048
/** Retirements listed by default, newest first. */
export const CENSUS_RETIREMENT_LIMIT = 20

export interface Retirement {
  id: string
  title: string
  scope: string
  reason: string
  at: number | null
}

export interface Census {
  records: number
  byStatus: Record<string, number>
  byEvidence: Record<string, number>
  byScope: Record<string, number>
  /** Confirmed records that would clear the resident bar right now. */
  residentEligible: number
  /** Confirmed records examined to produce that number. */
  residentScanned: number
  /** True when the store holds more confirmed records than were examined. */
  residentTruncated: boolean
  /**
   * Why the eligible count is what it is, as data rather than as prose.
   *
   * A bare `0/7` reads as "injection is broken" and was reported as such by a caller
   * who then had to run five recording experiments to discover it was the design. The
   * two numbers that answer it: how many confirmed records sit exactly on the bar
   * before age (`verified-file`'s base score *is* the bar) and how many have earned the
   * reuse bonus that lifts them clear of it.
   */
  residentFloor: {
    /** The score a record must reach. */
    bar: number
    /** Confirmed records that cleared the bar when written, before any age deduction. */
    eligibleAtWrite: number
    /** Confirmed records whose reuse history has earned them a bonus on top. */
    liftedByReuse: number
  }
  usage: { total: number; successes: number; failures: number }
  /**
   * Whether anything in here has ever been reached for.
   *
   * The store could only ever report what was *written*; nothing recorded what was
   * *read*, so "is this memory being used or is it a write-only pile" had no answer at
   * all. These two numbers are that answer: how many confirmed records a later session
   * searched out, and how many nobody has ever touched in either direction.
   */
  reach: {
    /** Confirmed records with at least one explicit search. */
    searched: number
    /** Confirmed records never searched and never recorded as useful. */
    untouched: number
    /** Confirmed records examined. */
    scanned: number
  }
  corrections: number
  /**
   * How often a lesson was actually put in front of the agent, and how recently.
   *
   * This is the layer that had no trace at all until now, and its absence made the
   * framework's central claim unfalsifiable: a record could be well written, correctly
   * graded and never shown to anyone, with nothing anywhere to say so. `delivered` counts
   * hints that went out; `deliveredRecords` counts the distinct lessons they were about, so
   * a single chatty lesson cannot read as broad coverage.
   */
  delivery: {
    /** Hints ever delivered, over all sessions. */
    delivered: number
    /** Distinct records those hints were about. */
    deliveredRecords: number
    /** Hints delivered in the last seven days. */
    recent: number
    /** Confirmed records that have ever been delivered. */
    coveredConfirmed: number
  }
  /**
   * What the harvester did, and whether anyone is acting on it.
   *
   * Harvesting only earns its place if the material gets confirmed. If nothing ever
   * promotes a harvested candidate, the feature is a store-filling machine — and this is
   * the number that says so rather than leaving it to opinion. `confirmed` counts rows the
   * harvester filed that were later re-stated with a passage, which is the only route from
   * candidate to record.
   */
  harvest: {
    /** Rows ever filed by the harvester. */
    total: number
    /** Harvested rows later confirmed through the ordinary evidence gate. */
    confirmed: number
    /** Harvested rows still sitting as candidates. */
    pending: number
  }
  retirements: Retirement[]
  retirementsTruncated: boolean
}

function group(db: DatabaseSync, column: string): Record<string, number> {
  const rows = db.prepare(
    `SELECT coalesce(${column}, '') AS value, count(*) AS n FROM record GROUP BY value ORDER BY n DESC`,
  ).all() as { value: string; n: number }[]
  return Object.fromEntries(rows.map(row => [row.value === '' ? '(empty)' : row.value, row.n]))
}

/**
 * The delivery numbers, tolerating a store that predates the delivery table.
 *
 * A reader must not fail on an older store: the *writer* is the plugin's next activation, and
 * every other entry point — this census, the ledger, an offline preview — opens the store and
 * never migrates it. Reporting zero is the honest answer there, and the line it renders says
 * nothing has been recorded rather than pretending delivery was measured and came out empty.
 */
function deliverySnapshot(
  db: DatabaseSync,
  now: number,
  confirmed: readonly { id: string }[],
): Census['delivery'] {
  const totals = deliveryTotals(db)
  let recent = 0
  let covered = 0
  try {
    recent = (db.prepare('SELECT count(*) AS n FROM delivery WHERE at >= ?').get(now - 7 * 86_400_000) as { n: number }).n
    covered = confirmed.filter(record =>
      db.prepare('SELECT 1 FROM delivery WHERE record_id = ? LIMIT 1').get(record.id) !== undefined).length
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/no such table/i.test(message)) throw error
  }
  return {
    delivered: totals.deliveries,
    deliveredRecords: totals.records,
    recent,
    coveredConfirmed: covered,
  }
}

/** Read the census from an open database. */
export function census(
  db: DatabaseSync,
  options: { now: number; scanLimit?: number; retirementLimit?: number },
): Census {
  const scanLimit = options.scanLimit ?? CENSUS_SCAN_LIMIT
  const retirementLimit = options.retirementLimit ?? CENSUS_RETIREMENT_LIMIT

  const total = (sql: string): number => (db.prepare(sql).get() as { n: number }).n
  const confirmed = confirmedAfter(db, '', scanLimit)
  const eligible = confirmed.filter(record =>
    eligibleForResident(record, importance({ ...record, now: options.now }), options.now))

  const trail = db.prepare(
    'SELECT (SELECT count(*) FROM usage) AS total,'
    + ' (SELECT count(*) FROM usage WHERE outcome = ?) AS successes,'
    + ' (SELECT count(*) FROM usage WHERE outcome = ?) AS failures,'
    + ' (SELECT count(*) FROM correction) AS corrections,'
    + ' (SELECT count(*) FROM record WHERE origin = ?) AS harvestTotal,'
    + " (SELECT count(*) FROM record WHERE origin = ? AND status = 'confirmed') AS harvestConfirmed,"
    + " (SELECT count(*) FROM record WHERE origin = ? AND status = 'candidate') AS harvestPending",
  ).get('success', 'failure', 'harvest', 'harvest', 'harvest') as {
    total: number; successes: number; failures: number; corrections: number
    harvestTotal: number; harvestConfirmed: number; harvestPending: number
  }

  const retirements = db.prepare(
    'SELECT r.id, r.title, r.scope, c.reason, c.at FROM record r'
    + ' LEFT JOIN correction c ON c.record_id = r.id'
    + " WHERE r.status = 'retired' ORDER BY c.at DESC LIMIT ?",
  ).all(retirementLimit) as { id: string; title: string; scope: string; reason: string | null; at: number | null }[]

  return {
    records: total('SELECT count(*) AS n FROM record'),
    byStatus: group(db, 'status'),
    byEvidence: group(db, 'evidence'),
    byScope: group(db, 'scope'),
    residentEligible: eligible.length,
    residentScanned: confirmed.length,
    residentTruncated: confirmed.length >= scanLimit,
    residentFloor: {
      bar: RESIDENT_MIN_IMPORTANCE,
      // Scored at the moment of writing, so only age separates this from the count
      // above: a record on the bar is eligible on the turn it was written and off it
      // ever after, which is exactly the fact a bare `0/7` hides.
      eligibleAtWrite: confirmed.filter(record =>
        eligibleForResident(record, importance({ ...record, now: record.createdAt }), record.createdAt)).length,
      liftedByReuse: confirmed.filter(record => record.reuseCount > 0).length,
    },
    usage: { total: trail.total, successes: trail.successes, failures: trail.failures },
    reach: {
      searched: confirmed.filter(record => record.retrieveCount > 0).length,
      untouched: confirmed.filter(record => record.retrieveCount === 0 && record.successCount === 0).length,
      scanned: confirmed.length,
    },
    corrections: trail.corrections,
    delivery: deliverySnapshot(db, options.now, confirmed),
    harvest: {
      total: trail.harvestTotal,
      confirmed: trail.harvestConfirmed,
      pending: trail.harvestPending,
    },
    retirements: retirements.map(row => ({
      id: row.id,
      title: row.title,
      scope: row.scope,
      reason: row.reason ?? 'unknown',
      at: row.at,
    })),
    retirementsTruncated: retirements.length >= retirementLimit,
  }
}

/** Render a census for a console or a slash command. */
export function renderCensus(result: Census, options: { dbPath?: string } = {}): string {
  const lines: string[] = []
  if (options.dbPath !== undefined) lines.push(`库：${options.dbPath}`)
  lines.push(`记录 ${result.records} 条`
    + ` · 常驻合格 ${result.residentEligible}/${result.residentScanned}`
    + `${result.residentTruncated ? '（只扫了前一批）' : ''}`)
  // A bare ratio reads as a fault. Say which of the two ways a record clears the bar
  // the store is missing, because the answer is almost always the second.
  lines.push(`  资格线 ${result.residentFloor.bar}`
    + `：写入瞬间越线 ${result.residentFloor.eligibleAtWrite} 条`
    + `（年龄扣分后掉下来的就在这里）`
    + ` · 已被成功复用 ${result.residentFloor.liftedByReuse} 条（复用加分能让弱证据长期在线）`)
  const pairs = (values: Record<string, number>): string =>
    Object.entries(values).map(([key, count]) => `${key}=${count}`).join(' ') || '无'
  lines.push(`  状态：${pairs(result.byStatus)}`)
  lines.push(`  证据：${pairs(result.byEvidence)}`)
  lines.push(`  作用域：${pairs(result.byScope)}`)
  lines.push(`  复用记录 ${result.usage.total} 条（成功 ${result.usage.successes} / 失败 ${result.usage.failures}）`
    + ` · 纠错 ${result.corrections} 条`)
  // The one line that answers "记了到底有没有被用". A store that only counts what went in
  // cannot tell a working memory from a write-only pile, and that was the state before
  // retrieval was recorded at all.
  lines.push(`  被查过 ${result.reach.searched}/${result.reach.scanned} 条（已确认范围内）`
    + ` · 从没被查过也没被确认有用的 ${result.reach.untouched} 条`)
  // The delivery line. "Written" and "reached the agent" are different facts, and only the
  // second one can stop a mistake — before this number existed the store could not tell them
  // apart, so a lesson that was never shown looked exactly like one that was shown and ignored.
  lines.push(`  动手前投递过 ${result.delivery.delivered} 次`
    + `（涉及 ${result.delivery.deliveredRecords} 条记录 · 近七天 ${result.delivery.recent} 次`
    + ` · 已确认记录里被投递过 ${result.delivery.coveredConfirmed}/${result.reach.scanned} 条）`)
  // Only worth a line once the harvester has done something; before that it is noise.
  if (result.harvest.total > 0) {
    lines.push(`  自动采集 ${result.harvest.total} 条`
      + `（其中 ${result.harvest.confirmed} 条已被确认成经验 · ${result.harvest.pending} 条待确认）`)
  }
  if (result.retirements.length > 0) {
    lines.push(`  已退役 ${result.retirements.length}${result.retirementsTruncated ? '+' : ''} 条（新的在前）：`)
    for (const item of result.retirements) {
      const when = item.at === null ? '无纠错记录' : new Date(item.at).toISOString().slice(0, 10)
      lines.push(`    ${when}  [${item.id}] ${item.title.slice(0, 48)} — ${item.reason}`)
    }
  }
  return lines.join('\n')
}
