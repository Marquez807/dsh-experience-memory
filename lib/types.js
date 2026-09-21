/** Shared record vocabulary. Kept in one module so no two files can drift. */

/** What a record asserts. Three kinds, not the ten of the archived design. */
                                                     

/** How far a record travels. */
                                          

/** Lifecycle position. Retirement is reversible; only purge removes bytes. */
                                                          

/**
 * How the record was established. Only the three `verified-*` grades may enter
 * the resident layer; `inferred` never does, which is what keeps guesses out of
 * the always-on context.
 */
                                                                                       

/** One stored record, as read back from SQLite. */
                               
            
                     
                                                                         
                
              
            
                
                    
               
              
                                                                           
                 
                                                           
                     
                                                
                
                                                                                
                   
                    
                      
                      
     
                                                                     
    
                                                                              
                                                                                 
                                                                                
                                                                            
                                                                        
     
                       
                                                           
                                
                                                                             
                    
                            
                   
     
                                              
    
                                                                             
                                                                            
                                                                                 
                                                                           
                                                                        
                                                 
     
                    
                   
                           
                            
                          
                            
                             
                            
     
                                                         
    
                                                                                
                                                                                  
                                                                          
                                                                                
                                                                               
                                                                             
     
                             
                                                                                 
                              
 

/** A record plus the ranking facts computed for one retrieval. */
                               
                      
                    
                                                                     
              
                                                                     
                           
                                                                    
             
 

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
                                   
               
                                                                                 
              
               
          
                                               
                     
               
                                                 
                       
     
                                                                               
                   
                 
                                                                                        
                 
                 
                                                                            
                 
                                                        
                                 
       
                                                                                              
                                                                 
       
                        
                                                                                      
                    
   
 

/** The slice of a Session this plugin reads. */
                              
            
                
       
                                                                                               
                                                                  
       
                        
   
     
                                                                                  
                                         
     
                                      
                                                                                             
 

/** The slice of an Agent this plugin reads. */
                            
             
                       
 
