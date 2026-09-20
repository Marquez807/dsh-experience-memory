/** Shared record vocabulary. Kept in one module so no two files can drift. */

/** What a record asserts. Three kinds, not the ten of the archived design. */
export type Kind = 'fact' | 'experience' | 'strategy'

/** How far a record travels. */
export type Scope = 'workspace' | 'domain'

/** Lifecycle position. Retirement is reversible; only purge removes bytes. */
export type Status = 'candidate' | 'confirmed' | 'retired'

/**
 * How the record was established. Only the three `verified-*` grades may enter
 * the resident layer; `inferred` never does, which is what keeps guesses out of
 * the always-on context.
 */
export type Evidence = 'verified-tool' | 'verified-user' | 'verified-file' | 'inferred'

/** One stored record, as read back from SQLite. */
export interface MemoryRecord {
  id: string
  workspaceId: string
  /** Empty means the record is reachable only from its own workspace. */
  domain: string
  scope: Scope
  kind: Kind
  status: Status
  evidence: Evidence
  title: string
  body: string
  /** When this record should come to mind. Indexed and matched heavily. */
  trigger: string
  /** Experience-only: the failure this record prevents. */
  failureMode: string
  /** Experience-only: the actionable lesson. */
  lesson: string
  /** Where the claim can be re-checked: `path:line`, tool call id, event id. */
  sourceRef: string
  reuseCount: number
  successCount: number
  failureCount: number
  /** Consecutive failures since the last success. Two retires the record. */
  failStreak: number
  distinctWorkspaces: number
  createdAt: number
  /**
   * Event time of the underlying observation.
   *
   * It equals `createdAt` today, at both write sites, and that is deliberate
   * rather than unfinished: staleness and decay have to measure how old the
   * *knowledge* is, so an imported record keeps its original time in `createdAt`
   * rather than looking new because it was migrated today. The field stays
   * separate so a future importer that knows both times can record them
   * differently, but nothing currently reads it.
   */
  occurredAt: number
  updatedAt: number
  lastUsedAt: number | null
  reviewAfter: number | null
  expiresAt: number | null
  contentFingerprint: string
  supersededBy: string | null
  needsReview: string | null
}

/** A record plus the ranking facts computed for one retrieval. */
export interface RankedRecord {
  record: MemoryRecord
  importance: number
  /** FTS5 bm25 of this row; more relevant rows are more negative. */
  bm25: number
  /** Count of exact identifier-phrase hits in title/trigger/body. */
  identifierMatches: number
  /** Agent-readable justification, so a recall can be explained. */
  why: string
}

// ── Session shapes ──────────────────────────────────────────────────────────
// Structural rather than imported, so the plugin depends on no session package.
// `src/session.ts` is the only place that reads them; see its comment for why
// centralising this mattered.

/** The slice of one logged event this plugin reads. */
export interface SessionEventLike {
  type?: string
  data?: {
    source?: { kind?: string; callId?: string }
    content?: unknown
    message?: {
      source?: { kind?: string; callId?: string }
      content?: unknown
    }
    /** `tool/call` carries the id and name at the top level of its payload. */
    callId?: string
    name?: string
  }
}

/** The slice of a Session this plugin reads. */
export interface SessionLike {
  header?: { cwd?: string }
  /**
   * A hand-built session may carry a plain array. A real one does not: it exposes
   * this log through `snapshotEvents()`.
   */
  events?: readonly SessionEventLike[]
  snapshotEvents?: (fromSeq?: number, toSeqExclusive?: number) => readonly SessionEventLike[]
}

/** The slice of an Agent this plugin reads. */
export interface AgentLike {
  id?: string
  session?: SessionLike
}
