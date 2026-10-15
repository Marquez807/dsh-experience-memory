/**
 * A snapshot of what the store looks like, so "is it getting better" has an answer.
 *
 * The plugin could always say what it holds (`memory_stats`) and never whether the holding was
 * improving. Every number here is computed from the store rather than asserted, and the shares are
 * taken over **confirmed** records — the population the digest and recall actually draw from.
 * Counting retired rows would make a store look healthier the more it threw away.
 *
 * A snapshot is taken at the end of a maintenance pass, which is the one place that already runs on
 * every turn without being on the retrieval path. The series is bounded so `meta` cannot grow
 * without limit; the point is a trend, not a log.
 *
 * One caveat, stated rather than hidden: `noAnchorPct` reads the `trigger` text, so an anchor
 * written in a spelling this check does not know is counted as absent. It is a proxy for "how much
 * of the store can be delivered just before a call", not an exact count.
 */
                                               
import { readMeta, writeMeta } from './db.js'

/** Snapshots kept. Enough to see a trend across a working week, bounded so `meta` stays small. */
export const HEALTH_SERIES_MAX = 30

                                 
                                          
            
                   
                 
                   
                                                
                   
                                                              
                           
                                                                                
                     
                                                                                                       
                     
                                                                                                   
                     
                                                                                  
                   
 

const pct = (part        , whole        )         =>
  whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10

export function healthSnapshot(db              , at        )                 {
  const counts = new Map                ()
  for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM record GROUP BY status').all()   
                                   ) counts.set(row.status, row.n)
  const confirmed = counts.get('confirmed') ?? 0
  const scalar = (sql        )         =>
    (db.prepare(sql).get()                             )?.n ?? 0
  const confirmedWhere = (clause        )         =>
    scalar(`SELECT COUNT(*) AS n FROM record WHERE status = 'confirmed' AND ${clause}`)
  return {
    at,
    confirmed,
    retired: counts.get('retired') ?? 0,
    candidate: counts.get('candidate') ?? 0,
    reusedPct: pct(confirmedWhere('reuse_count > 0'), confirmed),
    neverRetrievedPct: pct(confirmedWhere('retrieve_count = 0'), confirmed),
    noLessonPct: pct(confirmedWhere("TRIM(lesson) = ''"), confirmed),
    noAnchorPct: pct(confirmedWhere(
      "trigger NOT LIKE '%path:%' AND trigger NOT LIKE '%tool:%' AND trigger NOT LIKE '%command:%'",
    ), confirmed),
    sourceFlags: scalar(
      "SELECT COUNT(*) AS n FROM record WHERE needs_review LIKE '出处文件已不存在%'",
    ),
    dupGroups: scalar(
      "SELECT COUNT(*) AS n FROM (SELECT 1 FROM record WHERE status = 'confirmed' "
      + 'GROUP BY substr(title, 1, 12) HAVING COUNT(*) > 1)',
    ),
  }
}

/** Every snapshot taken, oldest first. An unreadable series is no series — the next pass writes one. */
export function healthSeries(db              )                   {
  const raw = readMeta(db, 'health.series')
  if (raw === '') return []
  try {
    const parsed          = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed                     : []
  } catch {
    return []
  }
}

/** Append one snapshot. Never throws on a store that has none yet. */
export function recordHealth(db              , snapshot                )       {
  writeMeta(db, 'health.latest', JSON.stringify(snapshot))
  const series = [...healthSeries(db), snapshot].slice(-HEALTH_SERIES_MAX)
  writeMeta(db, 'health.series', JSON.stringify(series))
}

/**
 * Render a snapshot for a reader, with the change since the previous one where there is one.
 *
 * The direction is stated in words for the two measures where "up" is bad — a rising share of
 * records with no lesson, or no anchor, is a store that is getting harder to deliver from. A bare
 * `+3.1` next to a percentage does not say which way is good, and this file exists to be read.
 */
export function formatHealth(latest                , previous                 )         {
  const count = (now        , before         )         =>
    before === undefined ? '' : `（上次 ${before}，${now === before ? '没变' : now > before ? `增 ${now - before}` : `减 ${before - now}`}）`
  const share = (now        , before                    , upIsBad         )         => {
    if (before === undefined) return ''
    const diff = Math.round((now - before) * 10) / 10
    if (diff === 0) return '（与上次持平）'
    const worse = upIsBad ? diff > 0 : diff < 0
    return `（${diff > 0 ? '+' : ''}${diff} 个百分点，${worse ? '变差' : '变好'}）`
  }
  const when = new Date(latest.at).toISOString().slice(0, 16).replace('T', ' ')
  return [
    `健康快照（${when}）`,
    `  确认 ${latest.confirmed} / 退役 ${latest.retired} / 候选 ${latest.candidate}`,
    `  被复用        ${latest.reusedPct}%${share(latest.reusedPct, previous?.reusedPct, false)}`,
    `  从未被检索    ${latest.neverRetrievedPct}%${share(latest.neverRetrievedPct, previous?.neverRetrievedPct, true)}`,
    `  无 lesson     ${latest.noLessonPct}%${share(latest.noLessonPct, previous?.noLessonPct, true)}`,
    `  无锚点        ${latest.noAnchorPct}%${share(latest.noAnchorPct, previous?.noAnchorPct, true)}`,
    `  出处标记      ${latest.sourceFlags} 条${count(latest.sourceFlags, previous?.sourceFlags)}`,
    `  同题组        ${latest.dupGroups} 组${count(latest.dupGroups, previous?.dupGroups)}`,
  ].join('\n')
}
