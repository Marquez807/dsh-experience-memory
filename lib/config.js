/**
 * Plugin configuration.
 *
 * Fields are optional and defaulted in {@link import('./index.js').apply}, which
 * matches how the in-box context plugins declare their config: a patch layer
 * replaces the whole `config` object, so a required field would break every
 * profile that overrides only one key.
 */
import z from '@deepseek-ai/schemastery'

                         
                                                           
                   
                                                                              
                 
     
                                                                                
                                                                            
                                                                       
     
                             
                                                                       
                           
                                                                                                 
                         
                                                                      
                         
                                                                              
                        
                                                                                   
                               
                                                          
                          
     
                                               
    
                                                                                         
                                                                                       
                                                                                    
                                               
     
                          
                                                                             
                            
                                                                      
                           
                                                                                    
                                  
 

/** Schemastery validation. Invalid values fail plugin load rather than degrade. */
export const Config            = z.object({
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
                                 
                  
                            
                            
                          
                        
                        
                       
                              
                         
                         
                           
                          
                                 
 

/**
 * Apply defaults and reject values that would make the plugin dishonest —
 * a zero resident byte ceiling is indistinguishable from "disabled", and a
 * negative limit would silently invert a `slice`.
 */
export function resolveConfig(config        )                 {
  const integer = (value                    , fallback        , name        , min        )         => {
    const resolved = value ?? fallback
    if (!Number.isSafeInteger(resolved) || resolved < min) {
      throw new TypeError(`experience-memory: ${name} must be an integer >= ${min}, got ${String(value)}`)
    }
    return resolved
  }
  const positive = (value                    , fallback        , name        )         =>
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
