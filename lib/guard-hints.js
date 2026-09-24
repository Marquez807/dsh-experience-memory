/**
 * Write-time hints for records about destructive actions — the machine's own facts, computed.
 *
 * Why this exists. `docs/DELIVERY-GAPS.md` §27 measured what happens when a safety lesson is written
 * as prose with *example* markers ("a path that does not contain `.exp`, `tmp`, `isolated` — just
 * exit"): every arm that had the record wrote a guard, and every guard failed, because a marker list
 * is a guess — one arm's list included `dsh-`, and the live store's own path
 * (`AppData\Roaming\dsh-desktop\harness\…`) contains `dsh-` too. A guard like that protects nothing
 * while looking exactly like protection.
 *
 * The facts that make a guard work are not judgement calls, they are *the environment*: where the real
 * store lives, and where a throwaway store is allowed to live. The plugin already knows both
 * (`defaultDbPath()`, the OS temp directory), so it computes them here and hands them to the writer
 * instead of hoping the writer types them. This is the same contract as `suggestAnchors`: **it
 * proposes, it never writes.** A record's body/lesson are never modified — `docs/GROWTH.md` §五.2
 * forbids silently rewriting a record, and a `verified-file` grade would stop meaning anything if the
 * claim could be edited afterwards.
 *
 * Deliberately cheap and honest about being a heuristic: matching is literal (`includes`) rather than
 * tokenised, because the tokeniser exists for retrieval scoring and because a false positive here
 * costs one extra line of output while a false negative changes nothing at all.
 */

/**
 * Words that mark a record as being about an action that cannot be undone.
 *
 * Frozen on purpose: this list decides nothing by itself (it only triggers a proposal), so growing it
 * silently would add noise without adding safety. Both languages are here because the store's own
 * records are written in Chinese while the code and commands they quote are English.
 */
export const DESTRUCTIVE_MARKERS                    = [
  '删除', '清空', '清库', '覆盖', '格式化',
  'drop table', 'delete from', 'truncate', 'rm -rf', 'del /f', 'wipe',
]

/** Path segments too generic to prove a record is talking about *that* file. */
const GENERIC_SEGMENTS                      = new Set([
  'c:', 'd:', 'users', 'admin', 'appdata', 'roaming', 'local', 'program files', 'windows', 'temp', 'tmp',
])

/** The two environment facts a destructive-action guard needs. Passed in, so this module is testable. */
                             
                                                                                        
                       
                                                    
                        
 

/** A computed counter-example the writer may paste into the record. */
                            
                                                    
              
                                                                                   
                   
     
                                                                                                   
                                                                                           
     
                  
 

/** Which markers this text matches, lowercased comparison. Empty means "not a destructive record". */
export function looksDestructive(text        )           {
  const haystack = text.toLowerCase()
  return DESTRUCTIVE_MARKERS.filter(marker => haystack.includes(marker.toLowerCase()))
}

/**
 * The path segments that identify one specific location, longest first.
 *
 * Generic segments are dropped (`Users`, `AppData`, `Roaming`, drive letters): a record that says
 * "do not touch anything under AppData" has not named the real store, and treating that as coverage
 * would suppress the very hint that says which file is the dangerous one.
 */
export function distinctiveTokens(path        )           {
  return path
    .split(/[\\/]+/)
    .map(segment => segment.trim().toLowerCase())
    .filter(segment => segment.length >= 4 && !GENERIC_SEGMENTS.has(segment))
    .sort((a, b) => b.length - a.length)
}

/**
 * The hint this record should be offered, or `undefined` when there is nothing to say.
 *
 * `undefined` covers two different cases on purpose — not a destructive record, and a destructive
 * record that already carries both facts — because both mean "the caller has nothing to add". The
 * `covered` flag on the returned hint is for a caller that wants to say so out loud.
 */
export function guardHintFor(input                                     )                        {
  const because = looksDestructive(input.text)
  if (because.length === 0) return undefined
  const haystack = input.text.toLowerCase()
  const namedReal = distinctiveTokens(input.facts.realStorePath).some(token => haystack.includes(token))
  const namedDisposable = input.facts.disposableRoot !== ''
    && haystack.includes(input.facts.disposableRoot.toLowerCase())
  return {
    because,
    covered: namedReal || namedDisposable,
    // Written as rules to adopt, not as a fact to record: "default refuse" is the half that a marker
    // whitelist never has, and naming the real store is what makes the refusal specific.
    line: `默认拒绝：只对 ${input.facts.disposableRoot} 之下的库动手；真实数据目录 ${input.facts.realStorePath} 永远不许碰。`
      + '路径里含某个关键词（.exp / tmp / isolated / dsh- 之类）**不等于**安全——真库路径本身就可能含这类词。',
  }
}
