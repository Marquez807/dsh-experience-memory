/**
 * Rendering and budget.
 *
 * The archived runtime hit its byte ceiling by throwing, so a store that grew
 * past the limit answered every query with nothing — the whole batch vanished
 * rather than the tail being dropped. Zep and Mem0 both truncate and rank
 * instead. This module truncates by rank and reports what it dropped; it throws
 * only when a single record cannot fit on its own, which is a real
 * configuration error rather than a size of store.
 */
import type { RankedRecord } from './types.ts'

/** Raised when no record can fit in the configured budget at all. */
export class BudgetError extends Error {
  readonly code = 'BUDGET_EXCEEDED'
  constructor(message: string) {
    super(message)
    this.name = 'BudgetError'
  }
}

/** UTF-8 length, which is what the injection actually costs. */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** Cut to a UTF-8 byte ceiling without splitting a code point. */
export function truncateToBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text
  let out = ''
  let used = 0
  for (const character of text) {
    const size = byteLength(character)
    if (used + size > maxBytes) break
    out += character
    used += size
  }
  return out
}

/** Ceiling for one resident line, so five lines cannot crowd out everything else. */
const RESIDENT_LINE_BYTES = 240

export interface ResidentOptions {
  maxRecords: number
  maxBytes: number
}

/** Header for a digest that carries query-matched records only. */
export const RESIDENT_HEADER = '经验记忆（按重要性排序）：'

/** One labeled group of records within a digest. */
export interface DigestSection {
  label: string
  ranked: readonly RankedRecord[]
}

/**
 * The always-on digest: labeled sections, most important first within each.
 *
 * Sections are rendered in order and **share one byte budget**. That is what
 * makes an unconditional section affordable: whatever the core lines occupy is
 * simply unavailable to the query-matched lines, so guaranteeing that cross-project
 * lessons appear cannot grow the prompt, only re-allocate it.
 *
 * A section whose label fits but whose first line does not is dropped rather than
 * rendered as an empty heading, so no section ever appears with nothing under it.
 *
 * Returns `''` — not an empty section — when nothing qualifies, so a turn with no
 * relevant experience contributes no tokens and does not perturb the request
 * prefix.
 */
export function renderDigest(sections: readonly DigestSection[], options: ResidentOptions): string {
  const blocks: string[] = []
  let used = 0

  for (const section of sections) {
    if (section.ranked.length === 0) continue
    const lines: string[] = []
    let sectionUsed = byteLength(section.label) + 1

    for (const entry of section.ranked.slice(0, options.maxRecords)) {
      const { record } = entry
      const detail = record.lesson !== '' ? record.lesson : record.body
      const line = truncateToBytes(`- [${record.id}] ${record.title} — ${detail}`, RESIDENT_LINE_BYTES)
      const cost = byteLength(line) + 1
      if (used + sectionUsed + cost > options.maxBytes) break
      lines.push(line)
      sectionUsed += cost
    }

    if (lines.length === 0) continue
    blocks.push([section.label, ...lines].join('\n'))
    used += sectionUsed
  }

  return blocks.length === 0 ? '' : blocks.join('\n')
}

/**
 * The digest for a single group of records, under the standard header.
 *
 * Used for the common case where there is no core section, so a turn whose
 * experience is purely query-matched renders exactly as it always did.
 */
export function renderResident(ranked: readonly RankedRecord[], options: ResidentOptions): string {
  return renderDigest([{ label: RESIDENT_HEADER, ranked }], options)
}

export interface RecallPack {
  text: string
  returned: number
  total: number
  /** True when the budget, not the limit, decided how many records came back. */
  truncated: boolean
}

/** Detailed rendering for the on-demand layer. */
export function renderDetail(entry: RankedRecord): string {
  const { record } = entry
  const parts = [`[${record.id}] ${record.title}`, `  ${record.body}`]
  if (record.trigger !== '') parts.push(`  何时适用: ${record.trigger}`)
  if (record.failureMode !== '') parts.push(`  失败模式: ${record.failureMode}`)
  if (record.lesson !== '') parts.push(`  教训: ${record.lesson}`)
  const provenance = [`证据: ${record.evidence}`, `重要性 ${entry.importance.toFixed(1)}`]
  // `why` carries only the extra signals; the grade is stated once, above.
  if (entry.why !== '') provenance.push(entry.why)
  parts.push(`  ${provenance.join(' · ')}`)
  if (record.needsReview !== null) parts.push(`  ⚠ 待复核: ${record.needsReview}`)
  return parts.join('\n')
}

/**
 * The on-demand layer: as many ranked records as fit, with the tail dropped and
 * counted rather than the whole answer refused.
 */
export function renderRecall(ranked: readonly RankedRecord[], maxBytes: number): RecallPack {
  const blocks: string[] = []
  let used = 0
  for (const entry of ranked) {
    const block = renderDetail(entry)
    const cost = byteLength(block) + 1
    if (used + cost > maxBytes) {
      if (blocks.length === 0) {
        throw new BudgetError(
          `experience-memory: one record needs ${cost} bytes but the budget is ${maxBytes}; raise recallMaxBytes`,
        )
      }
      break
    }
    blocks.push(block)
    used += cost
  }
  return {
    text: blocks.join('\n\n'),
    returned: blocks.length,
    total: ranked.length,
    truncated: blocks.length < ranked.length,
  }
}
