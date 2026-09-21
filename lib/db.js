/**
 * Storage. One backend, one file, one schema.
 *
 * The archived runtime carried a JSONL backend and a SQLite backend side by
 * side, plus a migration sentinel and two recovery paths. That is where its
 * worst defects came from: the two backends tokenized differently, and they
 * searched *different fields* — the JSONL path read `text` while the SQLite
 * path read `summary`, which is `text[:150]`. Migrating silently changed which
 * memories were reachable at all. There is exactly one backend here.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { tokenize } from './tokenize.js'
                                                                             

/** Bumped whenever a migration below changes the schema. */
export const SCHEMA_VERSION = 4

/** `$DSH_HOME/experience-memory/memory.db`, with `~/.dsh` as the documented fallback. */
export function defaultDbPath()         {
  const home = process.env['DSH_HOME']?.trim() || join(homedir(), '.dsh')
  return join(home, 'experience-memory', 'memory.db')
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS record (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL,
  domain              TEXT NOT NULL DEFAULT '',
  scope               TEXT NOT NULL,
  kind                TEXT NOT NULL,
  status              TEXT NOT NULL,
  evidence            TEXT NOT NULL,
  title               TEXT NOT NULL,
  body                TEXT NOT NULL,
  trigger             TEXT NOT NULL DEFAULT '',
  failure_mode        TEXT NOT NULL DEFAULT '',
  lesson              TEXT NOT NULL DEFAULT '',
  source_ref          TEXT NOT NULL DEFAULT '',
  reuse_count         INTEGER NOT NULL DEFAULT 0,
  success_count       INTEGER NOT NULL DEFAULT 0,
  failure_count       INTEGER NOT NULL DEFAULT 0,
  fail_streak         INTEGER NOT NULL DEFAULT 0,
  retrieve_count      INTEGER NOT NULL DEFAULT 0,
  last_retrieved_at   INTEGER,
  distinct_workspaces INTEGER NOT NULL DEFAULT 1,
  created_at          INTEGER NOT NULL,
  occurred_at         INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  last_used_at        INTEGER,
  review_after        INTEGER,
  expires_at          INTEGER,
  content_fingerprint TEXT NOT NULL,
  superseded_by       TEXT,
  needs_review        TEXT,
  origin              TEXT NOT NULL DEFAULT 'model',
  harvest_signal      TEXT,
  embedding           BLOB
);
-- Identity is per scope, and the two scopes identify differently. A
-- workspace-scoped record belongs to its workspace, so two workspaces may hold
-- the same lesson independently — that is exactly the observation the domain
-- promotion rule counts. Keying on (fingerprint, scope, domain) alone would
-- make the second workspace's copy collide and make promotion impossible.
CREATE UNIQUE INDEX IF NOT EXISTS record_identity_workspace
  ON record(content_fingerprint, workspace_id) WHERE scope = 'workspace';
CREATE UNIQUE INDEX IF NOT EXISTS record_identity_domain
  ON record(content_fingerprint, domain) WHERE scope = 'domain';
CREATE INDEX IF NOT EXISTS record_workspace ON record(workspace_id);
CREATE INDEX IF NOT EXISTS record_domain    ON record(domain);
CREATE INDEX IF NOT EXISTS record_status    ON record(status);

CREATE VIRTUAL TABLE IF NOT EXISTS record_fts USING fts5(
  id UNINDEXED, title, trigger, failure, lesson, body
);

CREATE TABLE IF NOT EXISTS usage (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id TEXT NOT NULL,
  session_id TEXT,
  turn      INTEGER,
  outcome   TEXT,
  at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_record ON usage(record_id);

CREATE TABLE IF NOT EXISTS correction (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id      TEXT NOT NULL,
  at             INTEGER NOT NULL,
  actor          TEXT NOT NULL,
  reason         TEXT NOT NULL,
  replacement_id TEXT
);

-- Which workspaces have independently reported the same content. A counter
-- cannot do this job: promotion to a domain requires knowing that two *distinct*
-- workspaces saw the lesson, and re-reporting from one workspace must not count
-- twice.
CREATE TABLE IF NOT EXISTS corroboration (
  fingerprint  TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  at           INTEGER NOT NULL,
  PRIMARY KEY (fingerprint, workspace_id)
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- What keeps going wrong, by shape. This is the observation layer, not the memory
-- layer: nothing here is ever injected, and nothing here is a lesson. It exists
-- because the framework read every one of these failures and deliberately threw
-- them away (harvest.ts skips the agent's own tooling), which is right for
-- "should this become a lesson" and wrong for "is this happening at all". Without
-- this table the only way to find out that 143 edits failed for the same reason,
-- with no record covering it, was for a person to go looking.
--
-- The shape is normalized (paths, quoted spans, ids and numbers collapsed), so two
-- occurrences in different files are one row. The sample keeps one truncated real
-- line so the reader can judge; it is never injected.
CREATE TABLE IF NOT EXISTS failure_shape (
  workspace_id TEXT NOT NULL,
  tool         TEXT NOT NULL,
  shape        TEXT NOT NULL,
  count        INTEGER NOT NULL,
  first_seen   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL,
  session_ids  TEXT NOT NULL DEFAULT '[]',
  sample       TEXT NOT NULL,
  PRIMARY KEY (workspace_id, tool, shape)
);
CREATE INDEX IF NOT EXISTS failure_shape_recent ON failure_shape(last_seen);
`

/**
 * Open (creating if needed) and migrate. Foreign keys are enabled here and
 * only here: the archived runtime turned them on in its read path and left them
 * off in its migration path, so the same statement behaved two ways.
 */
export function openDb(path         = defaultDbPath())               {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 2000')
  migrate(db)
  return db
}

/** Create or upgrade the schema. Idempotent; safe to call on every open. */
export function migrate(db              )       {
  const row = db.prepare('PRAGMA user_version').get()                                        
  const version = row?.user_version ?? 0
  if (version > SCHEMA_VERSION) {
    throw new Error(`experience-memory: database schema ${version} is newer than this build (${SCHEMA_VERSION})`)
  }
  if (version === SCHEMA_VERSION) return
  db.exec(SCHEMA)
  // `SCHEMA` is all `CREATE TABLE IF NOT EXISTS`, so it brings a *new* store up to
  // date and leaves an existing one exactly as it was — a column added to the
  // definition above would silently never appear on anyone's existing store. The
  // added columns are therefore applied by inspection rather than by version number,
  // which also makes re-running safe and leaves no half-migrated state to reason about.
  addMissingColumns(db, 'record', {
    retrieve_count: 'INTEGER NOT NULL DEFAULT 0',
    last_retrieved_at: 'INTEGER',
    origin: "TEXT NOT NULL DEFAULT 'model'",
    harvest_signal: 'TEXT',
  })
  db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION))
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
}

/** Add any of `columns` that `table` does not have yet. */
function addMissingColumns(db              , table        , columns                        )       {
  const present = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all()                      ).map(column => column.name),
  )
  for (const [name, definition] of Object.entries(columns)) {
    if (present.has(name)) continue
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
  }
}

/**
 * The five indexed columns of one record, in schema order, each already
 * tokenized and space-joined.
 *
 * Weighting is done by FTS5 column weights in {@link BM25_WEIGHTS}, not by
 * repeating a term here: {@link tokenize} deduplicates, so repetition would
 * collapse to one occurrence and silently weight nothing. A short memory that
 * names its own trigger should outrank a long one that merely mentions a word,
 * and column weights are the mechanism FTS5 provides for that.
 */
export function indexRow(record              )                                           {
  const join = (text        )         => tokenize(text).join(' ')
  return [
    join(record.title),
    join(record.trigger),
    join(record.failureMode),
    join(record.lesson),
    join(`${record.domain.replace(/[/\\]/g, ' ')}\n${record.body}`),
  ]
}

/**
 * bm25 column weights: `UNINDEXED id` first, then title, trigger, failure,
 * lesson, body. The trigger and failure mode carry the most weight because they
 * are what a future task actually matches against.
 */
export const BM25_WEIGHTS = [0, 3.0, 4.0, 3.5, 3.5, 1.0]         

               
            
                      
                
               
              
                
                  
               
              
                 
                      
                
                    
                     
                       
                       
                     
                        
                                  
                
                               
                             
                    
                     
                    
                             
                             
                           
                             
                              
                             
 

/** Row → record. One place, so no caller can disagree about column names. */
export function toRecord(row     )               {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    domain: row.domain,
    scope: row.scope         ,
    kind: row.kind        ,
    status: row.status          ,
    evidence: row.evidence            ,
    title: row.title,
    body: row.body,
    trigger: row.trigger,
    failureMode: row.failure_mode,
    lesson: row.lesson,
    sourceRef: row.source_ref,
    reuseCount: row.reuse_count,
    successCount: row.success_count,
    failureCount: row.failure_count,
    failStreak: row.fail_streak,
    retrieveCount: row.retrieve_count,
    lastRetrievedAt: row.last_retrieved_at,
    origin: row.origin === 'harvest' ? 'harvest' : 'model',
    harvestSignal: row.harvest_signal,
    distinctWorkspaces: row.distinct_workspaces,
    createdAt: row.created_at,
    occurredAt: row.occurred_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    reviewAfter: row.review_after,
    expiresAt: row.expires_at,
    contentFingerprint: row.content_fingerprint,
    supersededBy: row.superseded_by,
    needsReview: row.needs_review,
  }
}

/**
 * Insert or update one record and keep the FTS row in step.
 *
 * `ON CONFLICT ... DO UPDATE` rather than `INSERT OR REPLACE`: REPLACE deletes
 * the conflicting row first, which fires `ON DELETE CASCADE` on any child table
 * and left the archived schema briefly without its body row.
 */
export function upsert(db              , record              )       {
  db.prepare(`
    INSERT INTO record (
      id, workspace_id, domain, scope, kind, status, evidence,
      title, body, trigger, failure_mode, lesson, source_ref,
      reuse_count, success_count, failure_count, fail_streak, distinct_workspaces,
      retrieve_count, last_retrieved_at,
      created_at, occurred_at, updated_at, last_used_at, review_after, expires_at,
      content_fingerprint, superseded_by, needs_review
      , origin, harvest_signal
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      workspace_id=excluded.workspace_id, domain=excluded.domain, scope=excluded.scope,
      kind=excluded.kind, status=excluded.status, evidence=excluded.evidence,
      title=excluded.title, body=excluded.body, trigger=excluded.trigger,
      failure_mode=excluded.failure_mode, lesson=excluded.lesson, source_ref=excluded.source_ref,
      reuse_count=excluded.reuse_count, success_count=excluded.success_count,
      failure_count=excluded.failure_count, fail_streak=excluded.fail_streak,
      distinct_workspaces=excluded.distinct_workspaces,
      retrieve_count=excluded.retrieve_count, last_retrieved_at=excluded.last_retrieved_at,
      updated_at=excluded.updated_at, last_used_at=excluded.last_used_at,
      review_after=excluded.review_after, expires_at=excluded.expires_at,
      content_fingerprint=excluded.content_fingerprint, superseded_by=excluded.superseded_by,
      needs_review=excluded.needs_review,
      origin=excluded.origin, harvest_signal=excluded.harvest_signal
  `).run(
    record.id, record.workspaceId, record.domain, record.scope, record.kind, record.status, record.evidence,
    record.title, record.body, record.trigger, record.failureMode, record.lesson, record.sourceRef,
    record.reuseCount, record.successCount, record.failureCount, record.failStreak, record.distinctWorkspaces,
    // Type annotations are never checked in this project, so a hand-built record can reach
    // here missing a field the type claims is required; the bind is the last place that can
    // fail softly instead of throwing "cannot be bound to SQLite parameter 19".
    record.retrieveCount ?? 0, record.lastRetrievedAt ?? null,
    record.createdAt, record.occurredAt, record.updatedAt, record.lastUsedAt, record.reviewAfter, record.expiresAt,
    record.contentFingerprint, record.supersededBy, record.needsReview,
    record.origin ?? 'model', record.harvestSignal ?? null,
  )
  db.prepare('DELETE FROM record_fts WHERE id = ?').run(record.id)
  db.prepare('INSERT INTO record_fts VALUES (?,?,?,?,?,?)').run(record.id, ...indexRow(record))
}

export function getRecord(db              , id        )                           {
  const row = db.prepare('SELECT * FROM record WHERE id = ?').get(id)                   
  return row === undefined ? undefined : toRecord(row)
}

/**
 * Look up an existing record with the same content in the same scope.
 *
 * The two scopes identify differently: a workspace record is unique within its
 * workspace, a domain record within its domain.
 */
export function findByFingerprint(
  db              ,
  fingerprint        ,
  scope       ,
  workspaceId        ,
  domain        ,
)                           {
  const row = scope === 'workspace'
    ? db.prepare(
      'SELECT * FROM record WHERE content_fingerprint = ? AND scope = ? AND workspace_id = ?',
    ).get(fingerprint, scope, workspaceId)                   
    : db.prepare(
      'SELECT * FROM record WHERE content_fingerprint = ? AND scope = ? AND domain = ?',
    ).get(fingerprint, scope, domain)                   
  return row === undefined ? undefined : toRecord(row)
}

/** One full-text candidate. `bm25` is more negative for more relevant rows. */
                            
            
              
 

/**
 * Full-text candidates for a query. Returns an empty list for a query with no
 * indexable term rather than falling back to a whole-table scan or an arbitrary
 * overview — the archived `pack` returned eight records chosen by sorting
 * random uuid strings.
 */
export function candidates(db              , match        , limit        )              {
  if (match === '') return []
  return db.prepare(
    'SELECT record_fts.id AS id, bm25(record_fts, ?, ?, ?, ?, ?, ?) AS bm25'
    + ' FROM record_fts WHERE record_fts MATCH ? ORDER BY bm25 LIMIT ?',
  ).all(...BM25_WEIGHTS, match, limit)               
}

/**
 * Full-text candidates with their whole row, in one statement.
 *
 * Ranking needs facts from every candidate, so fetching ids and then issuing
 * one query per id would put hundreds of round trips on the retrieval path.
 */
export function searchRecords(
  db              ,
  match        ,
  limit        ,
)                                           {
  if (match === '') return []
  const rows = db.prepare(
    'SELECT r.*, bm25(record_fts, ?, ?, ?, ?, ?, ?) AS bm25'
    + ' FROM record_fts JOIN record r ON r.id = record_fts.id'
    + ' WHERE record_fts MATCH ? ORDER BY bm25 LIMIT ?',
  ).all(...BM25_WEIGHTS, match, limit)                              
  return rows.map(row => ({ record: toRecord(row), bm25: row.bm25 }))
}

/** Records matching a workspace/domain window without a query term. */
export function windowRecords(
  db              ,
  workspaceId        ,
  domain        ,
  limit        ,
)                 {
  const rows = db.prepare(
    'SELECT * FROM record WHERE (scope = ? AND workspace_id = ?) OR (scope = ? AND domain = ?)'
    + ' ORDER BY updated_at DESC LIMIT ?',
  ).all('workspace', workspaceId, 'domain', domain, limit)         
  return rows.map(toRecord)
}

/**
 * Domain-scoped confirmed records, selected without a query term.
 *
 * This is the core-memory candidate set: lessons two or more workspaces
 * independently reported, which is the only thing that promotes a record to
 * domain scope. Ordering here is a cheap pre-ranking — the real ordering is
 * {@link rank.importance}, applied by the caller — so the limit bounds work
 * rather than deciding the answer.
 */
export function domainCoreRecords(
  db              ,
  domain        ,
  now        ,
  limit        ,
)                 {
  if (domain === '') return []
  const rows = db.prepare(
    'SELECT * FROM record WHERE scope = ? AND domain = ? AND status = ?'
    + ' AND superseded_by IS NULL AND (expires_at IS NULL OR expires_at > ?)'
    + ' ORDER BY success_count DESC, updated_at DESC LIMIT ?',
  ).all('domain', domain, 'confirmed', now, limit)         
  return rows.map(toRecord)
}

/** Every workspace-scoped record carrying this content. */
export function workspaceRecordsByFingerprint(db              , fingerprint        )                 {
  const rows = db.prepare(
    'SELECT * FROM record WHERE content_fingerprint = ? AND scope = ?',
  ).all(fingerprint, 'workspace')         
  return rows.map(toRecord)
}

/**
 * Unconfirmed records in one workspace.
 *
 * Identity in this framework is the assertion, not the title, so re-recording the same
 * claim in different words creates a second record rather than replacing the first.
 * That is right for corroboration and wrong for a stranded candidate, which is what
 * this query exists to find. The caller compares titles itself, because the comparison
 * has to fold punctuation: two live records carried one claim under titles differing
 * only by the quotation marks around a single word.
 */
export function candidateSiblings(db              , workspaceId        )                 {
  const rows = db.prepare(
    'SELECT * FROM record WHERE workspace_id = ? AND status = ?',
  ).all(workspaceId, 'candidate')         
  return rows.map(toRecord)
}

/**
 * Every live candidate, oldest first.
 *
 * The maintenance pass used to look only at confirmed records, so a candidate with no
 * successor lived forever: nothing aged it, and only a later graded record with the same
 * title retired it. That was survivable while candidates were rare. It stops being
 * survivable the moment the turn harvester is filling the pool, which is why this exists
 * alongside the aging rule that consumes it.
 */
export function candidateRecords(db              , limit        )                 {
  const rows = db.prepare(
    'SELECT * FROM record WHERE status = ? ORDER BY created_at, id LIMIT ?',
  ).all('candidate', limit)         
  return rows.map(toRecord)
}

/** How many live candidates there are, across every workspace. */
export function countCandidates(db              , origin                      )         {
  const row = origin === undefined
    ? db.prepare('SELECT count(*) AS n FROM record WHERE status = ?').get('candidate')
    : db.prepare('SELECT count(*) AS n FROM record WHERE status = ? AND origin = ?').get('candidate', origin)
  return (row                 ).n
}

/** How many distinct workspaces have independently reported this content. */
export function corroborationCount(db              , fingerprint        )         {
  const row = db.prepare(
    'SELECT count(*) AS n FROM corroboration WHERE fingerprint = ?',
  ).get(fingerprint)                 
  return row.n
}

/** Record that one workspace has reported this content. Idempotent per workspace. */
export function noteCorroboration(db              , fingerprint        , workspaceId        , at        )       {
  db.prepare('INSERT OR IGNORE INTO corroboration VALUES (?, ?, ?)').run(fingerprint, workspaceId, at)
}

/** A confirmed record whose id sorts after `after`, for a resumable scan. */
export function confirmedAfter(db              , after        , limit        )                 {
  const rows = db.prepare(
    'SELECT * FROM record WHERE status = ? AND id > ? ORDER BY id LIMIT ?',
  ).all('confirmed', after, limit)         
  return rows.map(toRecord)
}

/** Read one `meta` value, or `''`. */
export function readMeta(db              , key        )         {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)                                 
  return row?.value ?? ''
}

/** Write one `meta` value. */
export function writeMeta(db              , key        , value        )       {
  db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)').run(key, value)
}

/** Append one audit entry. Never stores record content. */
export function noteCorrection(
  db              ,
  recordId        ,
  actor        ,
  reason        ,
  at        ,
  replacementId         ,
)       {
  db.prepare('INSERT INTO correction (record_id, at, actor, reason, replacement_id) VALUES (?,?,?,?,?)')
    .run(recordId, at, actor, reason, replacementId ?? null)
}

/** Append one usage observation. */
export function noteUsage(
  db              ,
  recordId        ,
  outcome        ,
  at        ,
  sessionId         ,
  turn         ,
)       {
  db.prepare('INSERT INTO usage (record_id, session_id, turn, outcome, at) VALUES (?,?,?,?,?)')
    .run(recordId, sessionId ?? null, turn ?? null, outcome, at)
}

/**
 * Corroboration rows that no longer describe anything.
 *
 * A corroboration row says "this workspace independently reported this content", and
 * `corroborations >= 2` is what promotes a workspace lesson to its domain. A row whose
 * record is gone keeps saying it: the live store had one left behind by a purge, so the
 * next report of that same content would have counted **two** workspaces when only one
 * had reported it — a gate that exists to require independent confirmation, quietly
 * satisfied by a single observation.
 *
 * A row is justified exactly when some record still lives in that workspace with that
 * fingerprint, so that is the test. Deleting by fingerprint alone would be wrong in the
 * other direction: one workspace purging its copy must not withdraw another workspace's
 * independent report.
 *
 * @returns how many rows were removed.
 */
export function pruneCorroboration(db              , fingerprint         )         {
  // The subquery is correlated, so it is re-evaluated with the outer row's fingerprint.
  const unjustified = 'workspace_id NOT IN'
    + ' (SELECT workspace_id FROM record WHERE content_fingerprint = corroboration.fingerprint)'
  const statement = fingerprint === undefined
    ? db.prepare(`DELETE FROM corroboration WHERE ${unjustified}`)
    : db.prepare(`DELETE FROM corroboration WHERE fingerprint = ? AND ${unjustified}`)
  const result = fingerprint === undefined ? statement.run() : statement.run(fingerprint)
  return Number(result.changes ?? 0)
}

/**
 * Record that a caller explicitly searched these records out, and when.
 *
 * Only `memory_recall` calls this. Automatic injection deliberately does not: a record
 * that counted its own injection would keep itself injected, and the counter would stop
 * meaning "someone looked for this". The distinction is the whole value of the number —
 * it is the only evidence that a memory written in an earlier session was ever reached
 * for in a later one, which is otherwise unknowable, because retrieval left no trace at
 * all before this existed.
 */
export function noteRetrieval(db              , ids                   , now        )         {
  if (ids.length === 0) return 0
  const statement = db.prepare(
    'UPDATE record SET retrieve_count = retrieve_count + 1, last_retrieved_at = ? WHERE id = ?',
  )
  let touched = 0
  for (const id of ids) touched += Number(statement.run(now, id).changes ?? 0)
  return touched
}

/** Remove a record, its index row, and any corroboration it was the last justification for.
 *
 * `usage` and `correction` rows are deliberately left alone: neither carries content, and
 * both are the audit trail a "forget this" is supposed to leave. A corroboration row is
 * different — it carries no content either, but it **changes a later decision**, which is
 * why it cannot outlive the record that justified it.
 */
export function deleteRecord(db              , id        )       {
  const row = db.prepare('SELECT content_fingerprint AS f FROM record WHERE id = ?').get(id)   
                   
               
  db.prepare('DELETE FROM record_fts WHERE id = ?').run(id)
  db.prepare('DELETE FROM record WHERE id = ?').run(id)
  if (row !== undefined) pruneCorroboration(db, row.f)
}

/**
 * Fold the write-ahead log back into `memory.db`, best effort.
 *
 * Without this the main file only catches up when SQLite happens to checkpoint on its
 * own, and a live store proved it can go a long time without doing so: the main file held
 * 30 records while the store held 53, so anyone copying `memory.db` alone would have got a
 * 43%-stale database and no error. `PASSIVE` never blocks and writes back whatever it can
 * without waiting for readers, which is what a turn-end hook needs; the size of `-wal`
 * shrinking is a bonus, not the point.
 */
export function checkpointWal(db              )       {
  try {
    db.exec('PRAGMA wal_checkpoint(PASSIVE)')
  } catch {
    // A checkpoint that cannot run is not a failure of the pass it ran in.
  }
}

/** One row of the failure-shape table, as the report needs it. */
                               
                     
              
               
               
                   
                  
                      
                
 

/** How many session ids one shape remembers; enough to show "it keeps happening", bounded. */
export const FAILURE_SESSION_IDS = 12

function toFailureShape(row                         )               {
  let sessionIds           = []
  try {
    const parsed = JSON.parse(String(row['session_ids'] ?? '[]'))           
    if (Array.isArray(parsed)) sessionIds = parsed.filter(id => typeof id === 'string')
  } catch {
    // A row whose list cannot be read still has a count, which is the part that matters.
  }
  return {
    workspaceId: String(row['workspace_id']),
    tool: String(row['tool']),
    shape: String(row['shape']),
    count: Number(row['count']),
    firstSeen: Number(row['first_seen']),
    lastSeen: Number(row['last_seen']),
    sessionIds,
    sample: String(row['sample']),
  }
}

/**
 * Add one failure to its shape, or start the shape.
 *
 * Counted, not judged: this writes no record and returns nothing anyone injects. The session
 * list is what makes "the same thing happened in six different sessions" visible, which is the
 * question a single count cannot answer.
 */
export function noteFailureShape(
  db              ,
  input                                                                                                     ,
)       {
  const existing = db.prepare(
    'SELECT count, session_ids FROM failure_shape WHERE workspace_id = ? AND tool = ? AND shape = ?',
  ).get(input.workspaceId, input.tool, input.shape)                                                      

  if (existing === undefined) {
    db.prepare(
      'INSERT INTO failure_shape (workspace_id, tool, shape, count, first_seen, last_seen, session_ids, sample)'
      + ' VALUES (?, ?, ?, 1, ?, ?, ?, ?)',
    ).run(
      input.workspaceId, input.tool, input.shape, input.at, input.at,
      JSON.stringify(input.sessionId === '' ? [] : [input.sessionId]), input.sample,
    )
    return
  }

  let sessionIds           = []
  try {
    const parsed = JSON.parse(existing.session_ids)           
    if (Array.isArray(parsed)) sessionIds = parsed.filter(id => typeof id === 'string')
  } catch {
    // Fall through: a broken list is replaced rather than allowed to block the count.
  }
  if (input.sessionId !== '' && !sessionIds.includes(input.sessionId)) {
    sessionIds = [...sessionIds, input.sessionId].slice(-FAILURE_SESSION_IDS)
  }
  db.prepare('UPDATE failure_shape SET count = count + 1, last_seen = ?, session_ids = ? WHERE workspace_id = ? AND tool = ? AND shape = ?')
    .run(input.at, JSON.stringify(sessionIds), input.workspaceId, input.tool, input.shape)
}

/** This workspace's shapes, most frequent first. */
export function failureShapes(db              , workspaceId        , limit        )                 {
  const rows = db.prepare(
    'SELECT * FROM failure_shape WHERE workspace_id = ? ORDER BY count DESC, last_seen DESC LIMIT ?',
  ).all(workspaceId, limit)                             
  return rows.map(toFailureShape)
}

/** How many workspaces have seen the same failure shape. The answer to "does this travel?". */
export function failureShapeWorkspaces(db              , tool        , shape        )         {
  const row = db.prepare(
    'SELECT count(*) AS n FROM failure_shape WHERE tool = ? AND shape = ?',
  ).get(tool, shape)                             
  return row?.n ?? 0
}

export function countFailureShapes(db              , workspaceId        )         {
  const row = db.prepare('SELECT count(*) AS n FROM failure_shape WHERE workspace_id = ?')
    .get(workspaceId)                             
  return row?.n ?? 0
}

/**
 * Keep at most `limit` shapes for this workspace, dropping the least frequent and stalest.
 *
 * Bounded because a long-lived workspace generates a new shape whenever an error message
 * changes by a word, and an unbounded diagnostics table is how a plugin that was cheap to run
 * stops being cheap.
 */
export function evictFailureShapes(db              , workspaceId        , limit        )         {
  const row = db.prepare(
    'DELETE FROM failure_shape WHERE workspace_id = ? AND (tool, shape) NOT IN ('
    + ' SELECT tool, shape FROM failure_shape WHERE workspace_id = ?'
    + ' ORDER BY count DESC, last_seen DESC LIMIT ?)',
  ).run(workspaceId, workspaceId, limit)
  return Number(row.changes ?? 0)
}
