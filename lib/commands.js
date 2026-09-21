/**
 * Operator commands, for the person, not the model.
 *
 * These are slash commands rather than tools on purpose. `retrieve` and
 * `import` reach outside the store — one scans arbitrary directories, the other
 * bulk-writes what it finds — so they stay behind a human trigger, which also
 * keeps the model's tool surface small (its size is asserted in the test suite,
 * not stated here). The framework's own rule is fail-closed: this session's
 * decision about whether to import an archive was a person's, and this keeps it
 * that way.
 *
 * Registration follows the in-box convention: a `description`, an `input.hint`
 * for the composer, a `handler(invocation)` returning `{kind, text}`, and
 * `recordInput: false` so operator commands and filesystem paths never enter the
 * session transcript.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
                                               
import { auditLegacy, summarizeAudit, writeAuditReports } from './audit.js'
import { census, renderCensus } from './census.js'
                                                 
import { candidateRecords, countCandidates, defaultDbPath, getRecord } from './db.js'
import { previewMemory, recentQueryText, workspaceOf,                } from './digest.js'
import { parseSelection, runImport, scanForStores, summarizeImport } from './import.js'
import { forget, maintain } from './lifecycle.js'

/** What a command handler returns. The command service validates this shape. */
                           
                                      
                                   

/** The invocation a registered command receives. Structural: no import. */
                                    
                   
                   
                      
 

/** The definition shape `ctx.commands.register` accepts. */
                                    
              
                     
                                                 
                       
                                                                                    
 

                                 
                  
                        
                                                                              
                    
                                                                           
                                         
 

/** Split a command line into tokens, honouring double quotes around one value. */
export function tokenizeArgs(input        )           {
  const tokens           = []
  let current = ''
  let quoted = false
  for (const character of input) {
    if (character === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && /\s/.test(character)) {
      if (current !== '') {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += character
  }
  if (current !== '') tokens.push(current)
  return tokens
}

                             
                      
                                      
 

/**
 * Parse `--flag`, `--flag value` and bare positionals.
 *
 * A flag whose next token starts with `--` takes no value, so
 * `--apply --selection x` cannot silently consume the next flag as a path.
 */
export function parseArgs(input        )             {
  const tokens = tokenizeArgs(input)
  const positional           = []
  const flags                                = {}
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] 
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const name = token.slice(2)
    const next = tokens[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[name] = next
      index += 1
    } else {
      flags[name] = true
    }
  }
  return { positional, flags }
}

const success = (text        )                => ({ kind: 'success', text })
const failure = (text        )                => ({ kind: 'error', text })

/** Where audit reports go when the operator does not say. */
function resolveReportDir(context                )         {
  return context.reportDir ?? join(dirname(defaultDbPath()), 'audit')
}

/** A root the operator named explicitly. Never defaulted: scanning is deliberate. */
function requireRoot(parsed            , usage        )                         {
  const root = parsed.positional[0]
  if (root === undefined || root === '') return failure(usage)
  return resolve(root)
}

/** Load a selection document, or explain why it cannot be used. */
function loadSelection(path        )                              {
  let document         
  try {
    document = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return failure(`无法读取清单 ${path}：${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    return parseSelection(document)
  } catch (error) {
    return failure(`清单 ${path} 不可用：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Every command this plugin contributes. */
export function commandDefinitions(context                )                      {
  const { db, config } = context

  return [
    {
      name: 'memory-status',
      description: 'show what the experience memory holds, and how much of it is injectable',
      recordInput: false,
      handler: () => {
        // The build id is what makes a copy identifiable: the package version never
        // changes and a tarball restores 1985 timestamps, so without it a caller cannot
        // tell which build the running process loaded.
        const head = context.build === undefined
          ? ''
          : `插件构建 ${context.build.id}（${context.build.modules} 个模块）\n`
        return success(head + renderCensus(census(db, { now: Date.now() }), { dbPath: config.dbPath }))
      },
    },

    {
      name: 'memory-preview',
      description: 'show what the memory would inject for a query, and what recall would add',
      input: { hint: '[<query>]' },
      recordInput: false,
      handler: (invocation) => {
        const query = (invocation.rawInput ?? '').trim() || recentQueryText(invocation.agent)
        if (query === '') {
          return failure('需要一个查询词：/memory-preview <query>（或先有一条用户消息）')
        }
        const workspace = workspaceOf(invocation.agent, config.defaultDomain)
        const now = Date.now()
        const { digest, recall } = previewMemory({ db, config, workspace, query, now })
        const lines = [
          `查询：${query}`,
          `工作区：${workspace.id || '(未识别)'}${workspace.domain === '' ? '' : ` · 领域 ${workspace.domain}`}`,
          '',
          `常驻注入：${digest === '' ? '（本轮为空——没有被注入的内容）' : ''}`,
          digest,
          '',
          `按需检索：返回 ${recall.returned}/${recall.total} 条${recall.truncated ? '（被字节上限截断）' : ''}`,
          recall.text === '' ? '（无匹配）' : recall.text,
        ]
        return success(lines.join('\n'))
      },
    },

    {
      name: 'memory-maintain',
      description: 'run one bounded maintenance pass now and report what it retired',
      recordInput: false,
      handler: () => {
        const result = maintain(db, { now: Date.now(), batchSize: config.maintenanceBatchSize })
        const reasons = Object.entries(result.reasons).sort((a, b) => b[1] - a[1])
        return success([
          `扫描 ${result.scanned} 条，退役 ${result.retired} 条`,
          reasons.length === 0 ? '没有需要退役的记录。' : `原因：${reasons.map(([r, n]) => `${r} ${n}`).join('、')}`,
          // A repaired row is worth saying out loud: it is the difference between a gate
          // that requires two independent reports and one that accepts a single one.
          ...result.orphanCorroborations === 0
            ? []
            : [`清理 ${result.orphanCorroborations} 条无主印证（记录已不在，留着会让一次上报算成两个工作区）`],
          ...result.candidatesAged + result.candidatesEvicted === 0
            ? []
            : [`候选：超期退役 ${result.candidatesAged} 条，池满淘汰 ${result.candidatesEvicted} 条`],
          '（同一套规则每轮结束也会自动跑一次，这里只是立刻执行。）',
        ].join('\n'))
      },
    },

    {
      // The harvester's output is raw material, and raw material has to be visible or the
      // only thing it does is fill a pool. Listing it for the person is the cheap half of
      // that; the model gets its own reminder in the `memory_recall` footer.
      name: 'memory-harvest',
      description: 'list the candidates the turn harvester collected, or retire one',
      input: { hint: '[--retire <id>]' },
      recordInput: false,
      handler: (invocation                   ) => {
        const args = (invocation.args ?? '').trim()
        const retire = /^--retire\s+(\S+)$/.exec(args)
        if (retire !== null) {
          const id = retire[1] 
          const record = getRecord(db, id)
          if (record === undefined) return failure(`没有这条记录：${id}`)
          if (record.status !== 'candidate') return failure(`这条不是候选（${record.status}），不在这里处理`)
          forget(db, { recordId: id, reason: '人工丢弃：采集的候选没有价值', actor: 'operator', now: Date.now() })
          return success(`已退役 ${id}（退役可逆，字节没删）`)
        }

        const pending = candidateRecords(db, 50).filter(record => record.origin === 'harvest')
        const total = countCandidates(db, 'harvest')
        if (total === 0) return success('没有待确认的采集候选。')
        const lines = [`自动采集的候选 ${total} 条（最多列 50 条）：`, '']
        for (const record of pending) {
          const days = Math.floor((Date.now() - record.createdAt) / 86_400_000)
          const flag = record.retrieveCount > 0 ? ` · 被查过 ${record.retrieveCount} 次` : ''
          lines.push(`[${record.id}] ${record.harvestSignal ?? '?'} · ${days} 天前${flag}`)
          lines.push(`    ${record.body.slice(0, 160)}`)
        }
        lines.push('')
        lines.push('有用的：让模型用 memory_remember 把同一句话复述一遍并附出处，即转正。')
        lines.push('没用的：`/memory-harvest --retire <id>`，或者不管它 —— 14 天后自动退役。')
        return success(lines.join('\n'))
      },
    },

    {
      name: 'memory-audit',
      description: 'audit archived memory stores for correctness before importing any of them',
      input: { hint: '<root> [--out <dir>]' },
      recordInput: false,
      handler: (invocation) => {
        const parsed = parseArgs(invocation.rawInput ?? '')
        const root = requireRoot(parsed, '用法：/memory-audit <root> [--out <dir>]')
        if (typeof root !== 'string') return root
        const outFlag = parsed.flags['out']
        const dir = typeof outFlag === 'string' ? resolve(outFlag) : resolveReportDir(context)
        const result = auditLegacy({ root, now: Date.now() })
        const paths = writeAuditReports(result, dir)
        // Name every file that was actually written. Reporting a subset is how an
        // operator ends up not knowing that two of the four reports exist — the
        // recommended catalogue and the full record dump are the two a person
        // needs most when deciding what to import.
        const written = Object.entries(paths).map(([kind, file]) => `  ${kind.padEnd(11)} ${file}`)
        return success([
          summarizeAudit(result),
          '',
          `报告已写入 ${dir}（${written.length} 份）：`,
          ...written,
        ].join('\n'))
      },
    },

    {
      name: 'memory-import',
      description: 'import archived memory stores — dry run unless --apply is given',
      input: { hint: '<root> [--selection <file>] [--apply]' },
      recordInput: false,
      handler: (invocation) => {
        const parsed = parseArgs(invocation.rawInput ?? '')
        const root = requireRoot(parsed, '用法：/memory-import <root> [--selection <file>] [--apply]')
        if (typeof root !== 'string') return root
        if (invocation.signal?.aborted === true) return failure('已取消。')

        const selectionFlag = parsed.flags['selection']
        let selection                         
        if (typeof selectionFlag === 'string') {
          const loaded = loadSelection(resolve(selectionFlag))
          if (!(loaded instanceof Set)) return loaded
          selection = loaded
        }

        const apply = parsed.flags['apply'] === true
        const scan = scanForStores(root)
        const outcome = runImport(db, scan, { apply, now: Date.now(), selection })
        const header = apply ? '' : '试运行（未写入）。确认无误后加 --apply。\n'
        return success(`${header}${summarizeImport(outcome, { apply })}`)
      },
    },
  ]
}

/** The command names this plugin contributes, for tests and documentation. */
export const COMMAND_NAMES = [
  'memory-status', 'memory-preview', 'memory-maintain', 'memory-harvest', 'memory-audit', 'memory-import',
]         
