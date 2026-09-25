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
  standingMaxRecords: z.number(),
  standingMaxBytes: z.number(),
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
  effectWeight: z.number(),
  decisionLossRetirement: z.boolean(),
  guardHints: z.boolean(),
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
  // Unlike every limit above, a weight may be zero or negative: it is a coefficient, not a count.
  const finite = (value                    , fallback        , name        )         => {
    const resolved = value ?? fallback
    if (typeof resolved !== 'number' || !Number.isFinite(resolved)) {
      throw new TypeError(`experience-memory: ${name} must be a finite number, got ${String(value)}`)
    }
    return resolved
  }
  return {
    enabled: config.enabled ?? true,
    dbPath: config.dbPath === '' ? undefined : config.dbPath,
    residentMaxRecords: positive(config.residentMaxRecords, 5, 'residentMaxRecords'),
    residentMaxBytes: positive(config.residentMaxBytes, 1536, 'residentMaxBytes'),
    // 0 is meaningful here — it turns the core layer off — so this one is allowed
    // to be zero where every other limit must be at least one.
    coreMaxRecords: integer(config.coreMaxRecords, 2, 'coreMaxRecords', 0),
    // 0 switches the standing layer off without touching a single record, the same shape as
    // `coreMaxRecords` above. Three is the default because a standing rule is the strongest claim
    // a writer can make — a store where everything is standing is a store where nothing is.
    standingMaxRecords: integer(config.standingMaxRecords, 3, 'standingMaxRecords', 0),
    // Its own byte ceiling, so the section that is carried unconditionally cannot consume the
    // budget that answers the turn in front of the reader. The whole digest still respects
    // `residentMaxBytes`; this only bounds one section's share of it. 768 rather than 512 because
    // that is what the real store measured: rendered lines are ≤240 bytes, and the label costs 49,
    // so 512 fitted exactly **one** real rule — the layer shipped at a size that could not hold the
    // rules it exists for. 768 holds three short rules or two long ones.
    standingMaxBytes: positive(config.standingMaxBytes, 768, 'standingMaxBytes'),
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
    // 0 is meaningful here and is the default: it means a measured effect is recorded and shown but
    // does not move the ranking. A negative weight is allowed on purpose — with the retirement rule
    // gated off, an operator may want a measured-harmful record pushed down without being retired.
    effectWeight: finite(config.effectWeight, 0, 'effectWeight'),
    decisionLossRetirement: config.decisionLossRetirement ?? false,
    // On by default: it only *proposes* a line in the tool's answer and writes nothing to the record.
    guardHints: config.guardHints ?? true,
  }
}
