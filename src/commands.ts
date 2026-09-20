/**
 * Operator commands, for the person, not the model.
 *
 * These are slash commands rather than tools on purpose. `retrieve` and
 * `import` reach outside the store — one scans arbitrary directories, the other
 * bulk-writes what it finds — so they stay behind a human trigger. The model's
 * tool surface stays at four, which also keeps its schema cost from growing every
 * turn. The framework's own rule is fail-closed: this session's decision about
 * whether to import an archive was a person's, and this keeps it that way.
 *
 * Registration follows the in-box convention: a `description`, an `input.hint`
 * for the composer, a `handler(invocation)` returning `{kind, text}`, and
 * `recordInput: false` so operator commands and filesystem paths never enter the
 * session transcript.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { auditLegacy, summarizeAudit, writeAuditReports } from './audit.ts'
import { census, renderCensus } from './census.ts'
import type { ResolvedConfig } from './config.ts'
import { defaultDbPath } from './db.ts'
import { previewMemory, recentQueryText, workspaceOf, type AgentLike } from './digest.ts'
import { parseSelection, runImport, scanForStores, summarizeImport } from './import.ts'
import { maintain } from './lifecycle.ts'

/** What a command handler returns. The command service validates this shape. */
export type CommandResult =
  | { kind: 'success'; text?: string }
  | { kind: 'error'; text: string }

/** The invocation a registered command receives. Structural: no import. */
export interface CommandInvocation {
  rawInput?: string
  agent?: AgentLike
  signal?: AbortSignal
}

/** The definition shape `ctx.commands.register` accepts. */
export interface CommandDefinition {
  name: string
  description: string
  input?: { hint: string; attachments?: boolean }
  recordInput?: boolean
  handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
}

export interface CommandContext {
  db: DatabaseSync
  config: ResolvedConfig
  /** Directory the audit reports are written to when `--out` is not given. */
  reportDir?: string
}

/** Split a command line into tokens, honouring double quotes around one value. */
export function tokenizeArgs(input: string): string[] {
  const tokens: string[] = []
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

export interface ParsedArgs {
  positional: string[]
  flags: Record<string, string | true>
}

/**
 * Parse `--flag`, `--flag value` and bare positionals.
 *
 * A flag whose next token starts with `--` takes no value, so
 * `--apply --selection x` cannot silently consume the next flag as a path.
 */
export function parseArgs(input: string): ParsedArgs {
  const tokens = tokenizeArgs(input)
  const positional: string[] = []
  const flags: Record<string, string | true> = {}
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
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

const success = (text: string): CommandResult => ({ kind: 'success', text })
const failure = (text: string): CommandResult => ({ kind: 'error', text })

/** Where audit reports go when the operator does not say. */
function resolveReportDir(context: CommandContext): string {
  return context.reportDir ?? join(dirname(defaultDbPath()), 'audit')
}

/** A root the operator named explicitly. Never defaulted: scanning is deliberate. */
function requireRoot(parsed: ParsedArgs, usage: string): string | CommandResult {
  const root = parsed.positional[0]
  if (root === undefined || root === '') return failure(usage)
  return resolve(root)
}

/** Load a selection document, or explain why it cannot be used. */
function loadSelection(path: string): Set<string> | CommandResult {
  let document: unknown
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
export function commandDefinitions(context: CommandContext): CommandDefinition[] {
  const { db, config } = context

  return [
    {
      name: 'memory-status',
      description: 'show what the experience memory holds, and how much of it is injectable',
      recordInput: false,
      handler: () => success(renderCensus(census(db, { now: Date.now() }), { dbPath: config.dbPath })),
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
          '（同一套规则每轮结束也会自动跑一次，这里只是立刻执行。）',
        ].join('\n'))
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
        return success([
          summarizeAudit(result),
          '',
          `报告已写入 ${dir}`,
          `  ${paths.audit}`,
          `  ${paths.selection}`,
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
        let selection: Set<string> | undefined
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
  'memory-status', 'memory-preview', 'memory-maintain', 'memory-audit', 'memory-import',
] as const
