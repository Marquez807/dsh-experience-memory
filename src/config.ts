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
  /** Candidates one turn may contribute. The only throttle at the source. */
  harvestMaxPerTurn?: number
  /** Ceiling on live candidates; beyond it the oldest are retired. */
  harvestPoolLimit?: number
  /** Days an untouched candidate may sit before the maintenance pass retires it. */
  harvestCandidateTtlDays?: number
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
  harvestMaxPerTurn: z.number(),
  harvestPoolLimit: z.number(),
  harvestCandidateTtlDays: z.number(),
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
  harvestMaxPerTurn: number
  harvestPoolLimit: number
  harvestCandidateTtlDays: number
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
    harvestEnabled: config.harvestEnabled ?? false,
    // 0 is meaningful for the per-turn throttle: it is the switch that stops the harvester
    // contributing without disabling the feature, so it may be zero.
    harvestMaxPerTurn: integer(config.harvestMaxPerTurn, 1, 'harvestMaxPerTurn', 0),
    harvestPoolLimit: positive(config.harvestPoolLimit, 200, 'harvestPoolLimit'),
    harvestCandidateTtlDays: positive(config.harvestCandidateTtlDays, 14, 'harvestCandidateTtlDays'),
  }
}
