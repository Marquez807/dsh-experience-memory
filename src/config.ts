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
  /** Always-on layer: how many records may reach the model each turn. */
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
  }
}
