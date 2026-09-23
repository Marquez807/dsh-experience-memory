/**
 * Plugin configuration.
 *
 * Fields are optional and defaulted in {@link import('./index.ts').apply}, which
 * matches how the in-box context plugins declare their config: a patch layer
 * replaces the whole `config` object, so a required field would break every
 * profile that overrides only one key.
 */
import z from '@deepseek-ai/schemastery'

export interface Config {
  /** Turn the whole plugin off without uninstalling it. */
  enabled?: boolean
  /** Override the database location. Tests point this at a temp directory. */
  dbPath?: string
  /**
   * Always-on layer: how many records this one section may contribute per turn.
   * It is a per-section ceiling, not a total — the core section has its own
   * `coreMaxRecords`, and only the byte budget is shared between them.
   */
  residentMaxRecords?: number
  /** Always-on layer: hard UTF-8 byte ceiling for the whole digest. */
  residentMaxBytes?: number
  /** Core layer: how many corroborated domain-level records appear every turn. 0 disables it. */
  coreMaxRecords?: number
  /** On-demand layer: hard ceiling for one `memory_recall` answer. */
  recallMaxBytes?: number
  /** Pin every record in this deployment to one domain; empty means infer. */
  defaultDomain?: string
  /** Records touched per maintenance pass. Maintenance never runs on retrieval. */
  maintenanceBatchSize?: number
  /** Consecutive failed outcomes that retire a record. */
  failStreakLimit?: number
  /**
   * Harvest raw material from a finished turn.
   *
   * Default on, because the failure it addresses is the model not thinking of something:
   * across five sessions and ~5,900 tool calls `memory_remember` was never called once
   * until it was named explicitly. Everything it writes is a candidate, so being on
   * cannot put anything in front of the model.
   */
  harvestEnabled?: boolean
  /**
   * Also run the two detectors the replay measured as unreliable: the broad user-statement
   * rule and failure-then-recovery. Left off because 235 real turns produced 110 candidates
   * from them and most were questions, task requests, harness boilerplate or environment
   * quirks. Turn on after reading /memory-harvest output on your own traffic.
   */
  harvestBroad?: boolean
  /** Candidates one turn may contribute. The only throttle at the source. */
  harvestMaxPerTurn?: number
  /** Ceiling on live candidates; beyond it the oldest are retired. */
  harvestPoolLimit?: number
  /** Days an untouched candidate may sit before the maintenance pass retires it. */
  harvestCandidateTtlDays?: number
  /**
   * Show a lesson at the moment a tool call is about to do the thing it warns about.
   *
   * Default on: it costs nothing until an identifier in the call matches one in a record,
   * and the case it exists for is a launch that was wasted because the lesson arrived a
   * turn too early to matter.
   */
  precallEnabled?: boolean
  /**
   * Hints one session may be shown this way, counted in hints delivered.
   *
   * There is deliberately no per-turn limit. One was tried — the obvious "at most one hint per
   * turn" — and replayed against the session this feature exists for: the turn's single slot
   * went to whichever record some other call matched first, and the lesson about launching the
   * game was never delivered at all, in any turn. A ceiling anywhere from one to six lost the
   * same way; only the per-record cooldown below throttles without deciding which record wins.
   */
  precallMaxPerSession?: number
  /** Minutes before the same lesson may be shown again in one session. */
  precallCooldownMinutes?: number
  /**
   * Count the tool failures this workspace repeats, so the gap between what keeps going wrong
   * and what the store knows can be asked about (`/memory-gaps`).
   *
   * Counting only: nothing counted here is injected, and no record is written from it.
   */
  failureTracking?: boolean
  /** Shapes kept per workspace before the least frequent and stalest are dropped. */
  failureShapeLimit?: number
  /**
   * Agent presets ("modes") that get no memory at all.
   *
   * A mode is a preset, and a preset cannot switch off a plugin the profile installed — the rows
   * a preset declares only control what it adds. So the switch lives here, keyed by preset id:
   * sessions whose mode is listed get no digest, no record hint, no just-in-time hints, no
   * harvesting and no failure counting, and the memory tools refuse instead of answering.
   *
   * It exists for a model-test mode, where the point is to watch the model rather than the
   * accumulated experience. Empty by default: nothing is disabled unless asked for.
   */
  disabledPresets?: string[]
  /**
   * Check a declared anchor against what it would cost, before it is written.
   *
   * A record's anchor decides how often it interrupts: `path:node_modules` matched 702 of 15,896
   * real calls and `tool:pwsh` matched 5,936, and the second record alone owned 94.8% of every hint
   * the store delivered (`docs/DELIVERY-GAPS.md` §25). An anchor like that is dropped, and the
   * caller is told — the record is still written and still reaches the digest and `memory_recall`.
   * On by default; the measurement is a snapshot, so the check fails **open** when it is absent.
   */
  anchorCostTable?: boolean
  /** Hits above which an anchor is treated as too common. Defaults to 300, the per-record gate. */
  anchorCostMaxHits?: number
}

/** Schemastery validation. Invalid values fail plugin load rather than degrade. */
export const Config: z<Config> = z.object({
  enabled: z.boolean(),
  dbPath: z.string(),
  residentMaxRecords: z.number(),
  residentMaxBytes: z.number(),
  coreMaxRecords: z.number(),
  recallMaxBytes: z.number(),
  defaultDomain: z.string(),
  maintenanceBatchSize: z.number(),
  failStreakLimit: z.number(),
  harvestEnabled: z.boolean(),
  harvestBroad: z.boolean(),
  harvestMaxPerTurn: z.number(),
  harvestPoolLimit: z.number(),
  harvestCandidateTtlDays: z.number(),
  precallEnabled: z.boolean(),
  precallMaxPerSession: z.number(),
  precallCooldownMinutes: z.number(),
  failureTracking: z.boolean(),
  failureShapeLimit: z.number(),
  disabledPresets: z.array(z.string()),
  anchorCostTable: z.boolean(),
  anchorCostMaxHits: z.number(),
})

/** Fully resolved configuration, with defaults applied and bounds enforced. */
export interface ResolvedConfig {
  enabled: boolean
  dbPath: string | undefined
  residentMaxRecords: number
  residentMaxBytes: number
  coreMaxRecords: number
  recallMaxBytes: number
  defaultDomain: string
  maintenanceBatchSize: number
  failStreakLimit: number
  harvestEnabled: boolean
  harvestBroad: boolean
  harvestMaxPerTurn: number
  harvestPoolLimit: number
  harvestCandidateTtlDays: number
  precallEnabled: boolean
  precallMaxPerSession: number
  precallCooldownMinutes: number
  failureTracking: boolean
  failureShapeLimit: number
  disabledPresets: string[]
  anchorCostTable: boolean
  anchorCostMaxHits: number
}

/**
 * Apply defaults and reject values that would make the plugin dishonest —
 * a zero resident byte ceiling is indistinguishable from "disabled", and a
 * negative limit would silently invert a `slice`.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const integer = (value: number | undefined, fallback: number, name: string, min: number): number => {
    const resolved = value ?? fallback
    if (!Number.isSafeInteger(resolved) || resolved < min) {
      throw new TypeError(`experience-memory: ${name} must be an integer >= ${min}, got ${String(value)}`)
    }
    return resolved
  }
  const positive = (value: number | undefined, fallback: number, name: string): number =>
    integer(value, fallback, name, 1)
  return {
    enabled: config.enabled ?? true,
    dbPath: config.dbPath === '' ? undefined : config.dbPath,
    residentMaxRecords: positive(config.residentMaxRecords, 5, 'residentMaxRecords'),
    residentMaxBytes: positive(config.residentMaxBytes, 1536, 'residentMaxBytes'),
    // 0 is meaningful here — it turns the core layer off — so this one is allowed
    // to be zero where every other limit must be at least one.
    coreMaxRecords: integer(config.coreMaxRecords, 2, 'coreMaxRecords', 0),
    recallMaxBytes: positive(config.recallMaxBytes, 16384, 'recallMaxBytes'),
    defaultDomain: config.defaultDomain ?? '',
    maintenanceBatchSize: positive(config.maintenanceBatchSize, 32, 'maintenanceBatchSize'),
    failStreakLimit: positive(config.failStreakLimit, 2, 'failStreakLimit'),
    harvestEnabled: config.harvestEnabled ?? true,
    harvestBroad: config.harvestBroad ?? false,
    // 0 is meaningful for the per-turn throttle: it is the switch that stops the harvester
    // contributing without disabling the feature, so it may be zero.
    harvestMaxPerTurn: integer(config.harvestMaxPerTurn, 1, 'harvestMaxPerTurn', 0),
    harvestPoolLimit: positive(config.harvestPoolLimit, 200, 'harvestPoolLimit'),
    harvestCandidateTtlDays: positive(config.harvestCandidateTtlDays, 14, 'harvestCandidateTtlDays'),
    precallEnabled: config.precallEnabled ?? true,
    precallMaxPerSession: positive(config.precallMaxPerSession, 20, 'precallMaxPerSession'),
    precallCooldownMinutes: positive(config.precallCooldownMinutes, 30, 'precallCooldownMinutes'),
    failureTracking: config.failureTracking ?? true,
    failureShapeLimit: positive(config.failureShapeLimit, 200, 'failureShapeLimit'),
    // Ids are compared literally, so they are trimmed once here rather than at every turn.
    disabledPresets: (config.disabledPresets ?? []).map(id => id.trim()).filter(id => id !== ''),
    anchorCostTable: config.anchorCostTable ?? true,
    // Same 300 as the pre-registered per-record gate: one number, two places that must agree.
    anchorCostMaxHits: positive(config.anchorCostMaxHits, 300, 'anchorCostMaxHits'),
  }
}
