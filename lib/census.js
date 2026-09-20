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
                                               
import { confirmedAfter } from './db.js'
import { eligibleForResident, importance } from './rank.js'

/** Confirmed records examined when counting resident-eligible ones. */
export const CENSUS_SCAN_LIMIT = 2048
/** Retirements listed by default, newest first. */
export const CENSUS_RETIREMENT_LIMIT = 20

                             
            
               
               
                
                   
 

                         
                 
                                  
                                    
                                 
                                                                       
                          
                                                           
                         
                                                                             
                            
                                                               
                     
                           
                               
 

function group(db              , column        )                         {
  const rows = db.prepare(
    `SELECT coalesce(${column}, '') AS value, count(*) AS n FROM record GROUP BY value ORDER BY n DESC`,
  ).all()                                  
  return Object.fromEntries(rows.map(row => [row.value === '' ? '(empty)' : row.value, row.n]))
}

/** Read the census from an open database. */
export function census(
  db              ,
  options                                                               ,
)         {
  const scanLimit = options.scanLimit ?? CENSUS_SCAN_LIMIT
  const retirementLimit = options.retirementLimit ?? CENSUS_RETIREMENT_LIMIT

  const total = (sql        )         => (db.prepare(sql).get()                 ).n
  const confirmed = confirmedAfter(db, '', scanLimit)
  const eligible = confirmed.filter(record =>
    eligibleForResident(record, importance({ ...record, now: options.now }), options.now))

  const trail = db.prepare(
    'SELECT (SELECT count(*) FROM usage) AS total,'
    + ' (SELECT count(*) FROM usage WHERE outcome = ?) AS successes,'
    + ' (SELECT count(*) FROM usage WHERE outcome = ?) AS failures,'
    + ' (SELECT count(*) FROM correction) AS corrections',
  ).get('success', 'failure')                                                                               

  const retirements = db.prepare(
    'SELECT r.id, r.title, r.scope, c.reason, c.at FROM record r'
    + ' LEFT JOIN correction c ON c.record_id = r.id'
    + " WHERE r.status = 'retired' ORDER BY c.at DESC LIMIT ?",
  ).all(retirementLimit)                                                                                            

  return {
    records: total('SELECT count(*) AS n FROM record'),
    byStatus: group(db, 'status'),
    byEvidence: group(db, 'evidence'),
    byScope: group(db, 'scope'),
    residentEligible: eligible.length,
    residentScanned: confirmed.length,
    residentTruncated: confirmed.length >= scanLimit,
    usage: { total: trail.total, successes: trail.successes, failures: trail.failures },
    corrections: trail.corrections,
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
export function renderCensus(result        , options                      = {})         {
  const lines           = []
  if (options.dbPath !== undefined) lines.push(`库：${options.dbPath}`)
  lines.push(`记录 ${result.records} 条`
    + ` · 常驻合格 ${result.residentEligible}/${result.residentScanned}`
    + `${result.residentTruncated ? '（只扫了前一批）' : ''}`)
  const pairs = (values                        )         =>
    Object.entries(values).map(([key, count]) => `${key}=${count}`).join(' ') || '无'
  lines.push(`  状态：${pairs(result.byStatus)}`)
  lines.push(`  证据：${pairs(result.byEvidence)}`)
  lines.push(`  作用域：${pairs(result.byScope)}`)
  lines.push(`  复用记录 ${result.usage.total} 条（成功 ${result.usage.successes} / 失败 ${result.usage.failures}）`
    + ` · 纠错 ${result.corrections} 条`)
  if (result.retirements.length > 0) {
    lines.push(`  已退役 ${result.retirements.length}${result.retirementsTruncated ? '+' : ''} 条（新的在前）：`)
    for (const item of result.retirements) {
      const when = item.at === null ? '无纠错记录' : new Date(item.at).toISOString().slice(0, 10)
      lines.push(`    ${when}  [${item.id}] ${item.title.slice(0, 48)} — ${item.reason}`)
    }
  }
  return lines.join('\n')
}
