/**
 * The resident digest, in one place.
 *
 * `apply()` contributes this through `ctx.systemPrompt.context`, and the
 * `/memory-preview` command prints it. Both must be the *same* function: a
 * preview that computed the digest its own way could disagree with what is
 * actually sent, which would defeat the only reason it exists.
 *
 * The query builder deliberately skips messages this plugin contributed. Without
 * that, the digest injected on turn N is read back as context on turn N+1 and the
 * same few records keep selecting themselves.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { ResolvedConfig } from './config.ts'
import { resolveWorkspace } from './domain.ts'
import { renderDigest, renderRecall, renderResident } from './inject.ts'
import { retrieve, retrieveCore } from './retrieve.ts'

/**
 * Headings for the two digest sections.
 *
 * They say *why* a line is present, because the two reasons carry different
 * weight: a corroborated cross-project lesson is a standing rule, while a
 * query-matched record is a suggestion for this task. Presenting them under one
 * heading would hide that difference from the model.
 */
export const CORE_LABEL = '经验记忆（领域通用，已由多个项目独立印证）：'
export const MATCHED_LABEL = '经验记忆（与本轮相关）：'

/** Bounds on the derived retrieval query, so one huge message cannot dominate. */
export const QUERY_USER_MESSAGES = 2
export const QUERY_MESSAGE_BYTES = 600

/** The slice of the session this plugin reads. Structural: no import. */
export interface SessionEventLike {
  type?: string
  data?: { source?: { kind?: string }; content?: unknown }
}

export interface AgentLike {
  id?: string
  session?: { header?: { cwd?: string }; events?: readonly SessionEventLike[] }
}

export interface Workspace {
  id: string
  domain: string
}

function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'object' && block !== null && 'text' in block) {
      const { text } = block as { text?: unknown }
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.join('\n')
}

/** Derive this turn's retrieval query from the conversation. */
export function recentQueryText(agent: AgentLike | undefined): string {
  const events = agent?.session?.events
  if (events === undefined) return ''
  const parts: string[] = []
  let seen = 0
  for (const event of [...events].reverse()) {
    if (event.type !== 'user/message') continue
    if (event.data?.source?.kind === 'plugin') continue
    const text = textOfContent(event.data?.content).trim()
    if (text === '') continue
    parts.unshift(text.slice(0, QUERY_MESSAGE_BYTES))
    seen += 1
    if (seen >= QUERY_USER_MESSAGES) break
  }
  return parts.join('\n')
}

/** The workspace a turn runs in, defaulting to the process directory. */
export function workspaceOf(agent: AgentLike | undefined, configuredDomain: string): Workspace {
  return resolveWorkspace(agent?.session?.header?.cwd, configuredDomain)
}

export interface DigestInput {
  db: DatabaseSync
  config: ResolvedConfig
  workspace: Workspace
  query: string
  now: number
}

/**
 * Render the digest for one assembly. Throws rather than returning `''` when a
 * lookup fails: an unavailable digest and an empty one look the same to a caller,
 * so the decision to hide a failure belongs to the caller, not here.
 */
export function buildDigest(input: DigestInput): string {
  const { db, config, workspace, query, now } = input
  const budget = { maxRecords: config.residentMaxRecords, maxBytes: config.residentMaxBytes }

  // The query-matched layer. Query-gated by design, so it empties when the turn
  // carries no term to match — which is most short replies.
  const { ranked } = retrieve(db, {
    workspaceId: workspace.id,
    domain: workspace.domain,
    query,
    now,
    limit: config.residentMaxRecords,
    tier: 'resident',
  })

  // The core layer: lessons two independent workspaces reported, injected whether
  // or not this turn mentions them. Sharing one byte budget with the matched layer
  // means the guarantee re-allocates prompt rather than growing it.
  const core = config.coreMaxRecords > 0
    ? retrieveCore(db, { domain: workspace.domain, now, limit: config.coreMaxRecords }).ranked
    : []

  if (core.length === 0) return renderResident(ranked, budget)

  // A record can be both, and must not be shown twice.
  const coreIds = new Set(core.map(entry => entry.record.id))
  return renderDigest([
    { label: CORE_LABEL, ranked: core },
    { label: MATCHED_LABEL, ranked: ranked.filter(entry => !coreIds.has(entry.record.id)) },
  ], budget)
}

export interface PreviewInput extends DigestInput {
  includeCandidates?: boolean
  includeRetired?: boolean
  limit?: number
}

/** What one turn would send: the digest, and what an on-demand recall adds. */
export function previewMemory(input: PreviewInput): {
  digest: string
  recall: { text: string; returned: number; total: number; truncated: boolean }
} {
  const digest = buildDigest(input)
  const { ranked } = retrieve(input.db, {
    workspaceId: input.workspace.id,
    domain: input.workspace.domain,
    query: input.query,
    now: input.now,
    limit: input.limit ?? 8,
    tier: 'recall',
    includeCandidates: input.includeCandidates ?? false,
    includeRetired: input.includeRetired ?? false,
  })
  return { digest, recall: renderRecall(ranked, input.config.recallMaxBytes) }
}
