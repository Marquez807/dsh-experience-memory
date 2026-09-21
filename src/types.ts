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
  /**
   * How many times a caller has explicitly searched this record out.
   *
   * Distinct from `reuseCount`, which counts recorded *outcomes*: this counts
   * *lookups*. Automatic injection deliberately does not count, or a record once
   * injected would keep itself injected forever. It exists because nothing else
   * did: retrieval was invisible, so a memory that a later session actually
   * reached for was indistinguishable from one no session ever touched.
   */
  retrieveCount: number
  /** When it was last searched out, or `null` if never. */
  lastRetrievedAt: number | null
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
  /**
   * Who put this here: the model, or the turn harvester.
   *
   * The harvester stores raw material — a verbatim sentence plus the mechanical
   * title it was filed under — and never a distilled claim, because distilling is
   * judgement and the harvester has none. So `harvest` records are always
   * candidates, and this field is how that stays auditable rather than implied:
   * `origin` is what a reader looks at to ask "did anyone actually think about
   * this", and it is what the census counts to report the confirmation rate.
   */
  origin: 'model' | 'harvest'
  /** Which detector fired, for harvested records. `null` for everything else. */
  harvestSignal: string | null
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

/**
 * The slice of one logged event this plugin reads.
 *
 * Every field below was read off a real session log rather than inferred from the
 * event registry, because the registry lists event types this harness never emits:
 * `feedback/record` is a known type and does not appear in a single one of the
 * 11,735 events of the busiest session in this workspace. Building a detector on a
 * type that never fires is a silent no-op, which is the failure mode this project
 * keeps running into.
 */
export interface SessionEventLike {
  type?: string
  /** Event position in the session log; envelope fields, both always present. */
  seq?: number
  time?: number
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
    /** `turn/start`, `turn/end` and `tool/result` all say which turn they belong to. */
    turn?: number
    step?: number
    /** `user/message` and `assistant/message` carry the role explicitly. */
    role?: string
    /** `goal/change` carries the new objective here. */
    goal?: { objective?: string }
    /** `approval/decided` carries e.g. `allowed-once`; anything else is a refusal. */
    outcome?: string
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
