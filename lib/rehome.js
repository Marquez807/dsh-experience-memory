/**
 * Moving a store's records to a different workspace identity.
 *
 * **Why this exists.** A workspace's identity is a hash of its resolved path
 * (`domain.ts:27-29`), and the store lives outside every repository
 * (`$DSH_HOME/experience-memory/memory.db`, `db.ts:21-24`). So memory built on one machine,
 * under one directory, is not merely unsynced — it is **invisible** anywhere else:
 * `visible()` (`retrieve.ts:123-124`) admits a workspace-scoped record only when the two
 * ids match exactly. Measured on the live store on 2026-09-25:
 *
 *   - 233 of 233 visible records were `scope='workspace'` for that one path;
 *   - the whole store held **one** domain-scoped record, and `distinct_workspaces >= 2`
 *     matched **zero** rows — the mechanism designed to carry lessons between projects
 *     has never once carried anything;
 *   - `/memory-import` cannot help: it reads the *archived* runtime's `.memory`
 *     directories (`import.ts:109-146`) and keys what it imports to the **old** store's
 *     own `projectRoot` (`import.ts:259`), so importing on the new machine re-creates the
 *     same mismatch.
 *
 * There was no way to move records, so this is it. Two things have to move together, and
 * the second is not optional:
 *
 * 1. `record.workspace_id`.
 * 2. `corroboration.workspace_id` — a row there claims "this workspace independently
 *    reported this content", and `pruneCorroboration` (`db.ts:628-637`) deletes any row
 *    whose workspace no longer holds a record with that fingerprint. Move the records
 *    alone and the history is **silently deleted** at the next maintenance pass: the count
 *    that decides domain promotion would quietly fall to zero. Where the target already
 *    has that fingerprint, the two rows are one fact and are merged rather than duplicated.
 *
 * Deliberately **not** done here:
 * - `usage`, `delivery` and `correction` rows carry no workspace identity; they are a
 *   session-level audit trail and stay as they are.
 * - **A record whose content the target already holds is left behind, not moved.** The
 *   schema forbids the alternative: `record_identity_workspace` is unique on
 *   `(content_fingerprint, workspace_id)` for workspace scope (`db.ts:68-69`), so moving it
 *   in would raise a constraint error, not create a duplicate. Nor should it be merged: the
 *   target's copy and the source's copy may differ in evidence grade, anchors and reuse
 *   history, and choosing between them is a judgement this tool is not entitled to make.
 *   The knowledge is already at the target; the plan reports the overlap and the operator
 *   decides what to do with the leftover.
 */
                                               
import { getRecord, upsert, writeMeta } from './db.js'

/** One workspace the store holds records for, with how many. */
                                  
            
                 
                   
                                                                                          
                 
 

/**
 * Every workspace identity present in the store.
 *
 * The id is a one-way hash, so a census cannot say which directory it was — that is the
 * point of hashing it, and the reason a migration has to name the old root explicitly
 * rather than guess.
 */
export function censusWorkspaces(db              , now        )                    {
  const rows = db.prepare(`
    SELECT workspace_id AS id,
           COUNT(*) AS records,
           SUM(CASE WHEN status = 'confirmed' AND superseded_by IS NULL
                     AND (expires_at IS NULL OR expires_at > ?) THEN 1 ELSE 0 END) AS visible,
           SUM(CASE WHEN status = 'confirmed' AND superseded_by IS NULL THEN 1 ELSE 0 END) AS confirmed
      FROM record
     WHERE scope = 'workspace'
     GROUP BY workspace_id
     ORDER BY records DESC
  `).all(now)                                                                         
  return rows.map(row => ({
    id: String(row.id),
    records: Number(row.records),
    confirmed: Number(row.confirmed),
    visible: Number(row.visible),
  }))
}

                             
              
            
                                                        
               
                                                          
                 
                                                    
                        
                                                                                               
                              
                                                                               
                    
                                         
 

/** What a rehome would do. Reads only; writes nothing.
 *
 * Every number here is what `applyRehome` will actually do, not a broader count of the
 * source workspace: a corroboration row belonging to a record that collisions keep behind
 * does **not** move, so counting all rows at the source would promise more than the move
 * delivers. The two functions were measured against each other while being written (the
 * first version of this plan reported 2 merges where the apply performed 1).
 */
export function planRehome(db              , from        , to        )             {
  const same = from === to || from === '' || to === ''
  if (same) {
    return { from, to, same, records: 0, corroborations: 0, mergedCorroborations: 0, collisions: 0, sample: [] }
  }
  // The records that can move: everything at the source except what the target already holds.
  const movable = db.prepare(`
    SELECT source.id AS id, source.title AS title, source.content_fingerprint AS fingerprint
      FROM record AS source
     WHERE source.scope = 'workspace' AND source.workspace_id = ?
       AND NOT EXISTS (SELECT 1 FROM record AS target
                        WHERE target.scope = 'workspace' AND target.workspace_id = ?
                          AND target.content_fingerprint = source.content_fingerprint)
     ORDER BY source.created_at DESC
  `).all(from, to)                                                        
  const atSource = Number((db.prepare(
    "SELECT COUNT(*) AS n FROM record WHERE scope = 'workspace' AND workspace_id = ?",
  ).get(from)                 ).n)

  const corroborationAt = db.prepare(
    'SELECT COUNT(*) AS n FROM corroboration WHERE fingerprint = ? AND workspace_id = ?',
  )
  let corroborations = 0
  let mergedCorroborations = 0
  for (const row of movable) {
    if (Number((corroborationAt.get(String(row.fingerprint), from)                 ).n) === 0) continue
    if (Number((corroborationAt.get(String(row.fingerprint), to)                 ).n) > 0) mergedCorroborations += 1
    else corroborations += 1
  }
  return {
    from,
    to,
    same,
    records: movable.length,
    corroborations,
    mergedCorroborations,
    collisions: atSource - movable.length,
    sample: movable.slice(0, 5).map(row => ({ id: String(row.id), title: String(row.title) })),
  }
}

                               
                                    
                 
                                                                           
                 
                        
                              
 

/**
 * Carry out a rehome in one transaction.
 *
 * One transaction because a half-moved store is worse than an unmoved one: records at the
 * target with corroborations still at the source would be pruned at the next maintenance
 * pass, which is the silent loss this function exists to prevent.
 *
 * Corroborations move **per moved fingerprint**, not as a blanket sweep of the source
 * workspace: a record left behind by the collision rule is still there, so its own
 * corroboration row is still justified and must stay (a blanket `UPDATE ... WHERE
 * workspace_id = from` would strip the row and hand `pruneCorroboration` a workspace that
 * no longer reports the content it is credited with).
 */
export function applyRehome(db              , from        , to        , now        )               {
  const plan = planRehome(db, from, to)
  if (plan.same || (plan.records === 0 && plan.corroborations === 0)) {
    return { records: 0, skipped: 0, corroborations: 0, mergedCorroborations: 0 }
  }
  const rows = db.prepare(
    "SELECT id, content_fingerprint AS fingerprint FROM record WHERE scope = 'workspace' AND workspace_id = ?",
  ).all(from)                                         
  const targetWouldCollide = db.prepare(`
    SELECT COUNT(*) AS n FROM record
     WHERE scope = 'workspace' AND workspace_id = ? AND content_fingerprint = ?
  `)
  const moving                                        = []
  for (const row of rows) {
    const twin = Number((targetWouldCollide.get(to, String(row.fingerprint))                 ).n)
    if (twin === 0) moving.push({ id: String(row.id), fingerprint: String(row.fingerprint) })
  }
  const skipped = rows.length - moving.length

  db.exec('BEGIN')
  try {
    let merged = 0
    let moved = 0
    for (const row of moving) {
      // The target's own row for the same fingerprint is the same fact, so the source's copy
      // of it is dropped rather than colliding with the (fingerprint, workspace_id) key.
      const atTarget = db.prepare('SELECT COUNT(*) AS n FROM corroboration WHERE fingerprint = ? AND workspace_id = ?')
        .get(row.fingerprint, to)                 
      const atSource = db.prepare('SELECT COUNT(*) AS n FROM corroboration WHERE fingerprint = ? AND workspace_id = ?')
        .get(row.fingerprint, from)                 
      if (Number(atSource.n) === 0) continue
      if (Number(atTarget.n) > 0) {
        db.prepare('DELETE FROM corroboration WHERE fingerprint = ? AND workspace_id = ?').run(row.fingerprint, from)
        merged += 1
      } else {
        db.prepare('UPDATE corroboration SET workspace_id = ? WHERE fingerprint = ? AND workspace_id = ?')
          .run(to, row.fingerprint, from)
        moved += 1
      }
    }
    for (const row of moving) {
      const record = getRecord(db, row.id)
      // `upsert` rather than raw SQL so the FTS index follows the row — it is the only
      // writer that maintains both halves.
      if (record !== undefined) upsert(db, { ...record, workspaceId: to, updatedAt: now })
    }
    writeMeta(db, 'rehome.last', JSON.stringify({
      from, to, at: now, records: moving.length, skipped, corroborations: moved,
    }))
    db.exec('COMMIT')
    return { records: moving.length, skipped, corroborations: moved, mergedCorroborations: merged }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
