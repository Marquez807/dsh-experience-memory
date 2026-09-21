/**
 * The turn harvester: turning a finished turn into candidate raw material.
 *
 * The problem it answers is measured, not assumed. Recording depends on the model
 * choosing to call `memory_remember`, and across five real sessions and ~5,900 tool calls
 * it never did until someone named it explicitly. The standing hint fixed the worst of
 * that, but the failure mode is structural: nothing catches the lesson the model simply
 * did not think about. This does, and only as a safety net — whatever the model already
 * recorded is left alone.
 *
 * Three rules keep it from becoming the thing this framework exists to avoid.
 *
 * 1. **It never judges.** A detector recognises a *moment*, not a lesson: the user
 *    corrected the model, the user stated something, an action failed and then worked, the
 *    goal changed, an action was refused. What gets stored is the **verbatim sentence**,
 *    with a mechanical title. Distilling a sentence into a claim is judgement, and the
 *    harvester has none — so it does not try.
 * 2. **It never confirms.** Harvested records are written straight to the store as
 *    candidates, bypassing `remember()` and therefore its grading. They are invisible to
 *    the always-on layer, and the only way one becomes a real record is the model
 *    re-stating it — at which point the ordinary evidence gate applies, on its merits.
 * 3. **It is structural.** Every detector reads a marker the session already wrote (a turn
 *    boundary, an error flag, a goal change). None of them guesses at intent, and none of
 *    them costs an LLM call — this plugin makes none by design.
 *
 * The detectors were pinned against a real session log rather than the event registry,
 * because the registry lists types this harness never emits: `feedback/record` is a known
 * type and appears zero times in the 11,735 events of the busiest session in this
 * workspace. A detector built on a type that never fires is a silent no-op.
 */
import type { SessionEventLike } from './types.ts'

/** One line of raw material the harvester decided was worth keeping. */
export interface HarvestCandidate {
  /** Verbatim source text; also the quote a later grading would check. */
  text: string
  /** Which detector fired. Stored so a reader can audit what the harvester was thinking. */
  signal: HarvestSignal
  /** Mechanical title — the dedupe handle, never a distilled claim. */
  title: string
}

export type HarvestSignal =
  | 'user-correction'
  | 'user-statement'
  | 'failure-recovered'
  | 'goal-changed'
  | 'action-refused'

/** Titles are a dedupe handle, so they are bounded and never paraphrased. */
const TITLE_MAX = 60
/** Below this, a sentence carries too little to be worth a row. */
const MIN_STATEMENT_CHARS = 12
/**
 * The floor for a sentence that named a durable rule outright.
 *
 * Lower than the statement floor because the marker is itself the evidence: "以后一律用 F
 * 盘" is nine characters and is precisely the kind of rule a later session needs, while a
 * nine-character sentence with no marker is usually a fragment.
 */
const MIN_DURABLE_CHARS = 6
/** A quoted paragraph is not a lesson; keep only the sentence that matters. */
const TEXT_MAX = 600

/**
 * Words that mark the previous answer as wrong.
 *
 * Deliberately short and unambiguous. "其实" is included because it introduces the
 * correction rather than the error, which is exactly the sentence worth keeping; "可能"
 * and "也许" are excluded because they hedge rather than correct.
 */
const CORRECTION_MARKERS = [
  '不对', '不是这样', '不是这个', '错了', '搞错', '弄错', '并不是', '其实不', '你误解',
  '我没说', '我说的是', '应该是', '应该是说', '而不是', '别再', '不要用', 'no, ', 'wrong',
]

/**
 * Words that introduce a durable rule rather than a preference for this once.
 *
 * These are the imperative case, and they are one detector among five — not the
 * criterion. Restricting capture to them would miss the much more common shape of a
 * lesson: "the bug was X", "this API does not fire Y", "it only worked after Z".
 */
const DURABLE_MARKERS = [
  '以后', '下次', '每次', '一律', '永远不', '永远都', '记住', '切记', '务必', '必须要',
  '不准', '禁止', 'always', 'never', 'from now on',
]

/** Something concrete enough that the sentence is about the project, not about us. */
const CONCRETE = [
  /[A-Za-z_][A-Za-z0-9_]{2,}/,        // an identifier, command, API or file name
  /\d/,                                // a number, version, port, size
  /[\\/][\w.-]+/,                      // a path
  /[。；]|因为|所以|原因|导致|结论/,     // an explanation or a stated conclusion
]

/** A question is a request for information, not a statement of fact. */
const QUESTION = /[?？]\s*$|^(请问|为什么|怎么|如何|是不是|能不能|可不可以|什么|哪个|哪一|多少|是否)/

const textOf = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map(block => {
        if (typeof block === 'string') return block
        if (typeof block === 'object' && block !== null && typeof (block as { text?: unknown }).text === 'string') {
          return (block as { text: string }).text
        }
        return ''
      })
      .join('\n')
  }
  return ''
}

/** Sentences of one message, so a paragraph does not become a record. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?；;\n])/)
    .map(part => part.trim())
    .filter(part => part !== '')
}

/** A message the user typed. Plugin-sourced messages are our own injections, not theirs. */
function isUserText(event: SessionEventLike): boolean {
  return event.type === 'user/message' && event.data?.source?.kind !== 'plugin'
}

const isQuestion = (sentence: string): boolean => QUESTION.test(sentence)

const isConcrete = (sentence: string): boolean => CONCRETE.some(pattern => pattern.test(sentence))

const hasMarker = (sentence: string, markers: readonly string[]): boolean => {
  const lower = sentence.toLowerCase()
  return markers.some(marker => lower.includes(marker.toLowerCase()))
}

const titleFrom = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= TITLE_MAX ? flat : `${flat.slice(0, TITLE_MAX - 1)}…`
}

/** The events of the newest turn only — the harvester never rescans the session. */
export function lastTurn(events: readonly SessionEventLike[]): readonly SessionEventLike[] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'turn/start') return events.slice(index)
  }
  // No boundary found (a hand-built session, or a log that starts mid-turn): the whole
  // list is the best available answer, and every detector is cheap on a short one.
  return events
}

/** The readable text of the first block of a tool result. */
function firstErrorText(blocks: readonly unknown[]): string {
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue
    const inner = (block as { content?: unknown }).content
    const text = textOf(inner).trim()
    if (text !== '') return text.slice(0, 200)
  }
  return ''
}

/**
 * One tool that failed and then worked, within the same turn.
 *
 * This is the highest-precision moment of the five: the session already recorded both
 * halves — the error flag and the later success — so nothing is inferred about what the
 * user meant. It is also the shape of lesson this framework was built for, because the
 * failure text and the thing that fixed it are the two halves a later session needs.
 */
function failureRecovered(turn: readonly SessionEventLike[]): string | undefined {
  const toolOf = new Map<string, string>()
  const brokeAt = new Map<string, { reason: string; index: number }>()
  let index = -1
  for (const event of turn) {
    index += 1
    if (event.type === 'tool/call') {
      const name = event.data?.name
      const callId = event.data?.callId
      if (typeof name === 'string' && typeof callId === 'string') toolOf.set(callId, name)
      continue
    }
    if (event.type !== 'tool/result') continue
    const callId = event.data?.message?.source?.callId ?? event.data?.source?.callId
    if (typeof callId !== 'string') continue
    const name = toolOf.get(callId)
    if (name === undefined) continue
    const blocks = event.data?.message?.content ?? event.data?.content
    if (!Array.isArray(blocks)) continue
    const failed = blocks.some(block =>
      typeof block === 'object' && block !== null && (block as { isError?: unknown }).isError === true)
    if (failed) {
      if (!brokeAt.has(name)) brokeAt.set(name, { reason: firstErrorText(blocks), index })
      continue
    }
    const broke = brokeAt.get(name)
    if (broke !== undefined && broke.index < index) {
      const detail = broke.reason === '' ? '' : `：${broke.reason}`
      return `${name} 先是失败了，后来成功了${detail}`.slice(0, TEXT_MAX)
    }
  }
  return undefined
}

/**
 * The moment, if there is one, as raw material.
 *
 * Ordered most specific first: a correction is a stronger signal than a statement, and a
 * repaired failure is stronger than both, so one turn produces at most one candidate and
 * it is the best available rather than the first encountered.
 */
export function harvestFrom(turn: readonly SessionEventLike[]): HarvestCandidate | undefined {
  const repaired = failureRecovered(turn)
  if (repaired !== undefined) {
    return { text: repaired, signal: 'failure-recovered', title: titleFrom(repaired) }
  }

  const userLines: string[] = []
  for (const event of turn) {
    if (isUserText(event)) userLines.push(...sentences(textOf(event.data?.content)))
  }

  const correction = userLines.find(line =>
    line.length >= MIN_STATEMENT_CHARS && hasMarker(line, CORRECTION_MARKERS))
  if (correction !== undefined) {
    return { text: correction.slice(0, TEXT_MAX), signal: 'user-correction', title: titleFrom(correction) }
  }

  const durable = userLines.find(line =>
    line.length >= MIN_DURABLE_CHARS && hasMarker(line, DURABLE_MARKERS))
  if (durable !== undefined) {
    return { text: durable.slice(0, TEXT_MAX), signal: 'user-statement', title: titleFrom(durable) }
  }

  // The broad case, and the reason this is not a hunt for imperatives: a user sentence
  // that is not a question and names something concrete is usually a fact about the
  // project. It is the noisiest detector here, which is why the pool has a ceiling.
  const statement = userLines.find(line =>
    line.length >= MIN_STATEMENT_CHARS && !isQuestion(line) && isConcrete(line))
  if (statement !== undefined) {
    return { text: statement.slice(0, TEXT_MAX), signal: 'user-statement', title: titleFrom(statement) }
  }

  for (const event of turn) {
    if (event.type === 'goal/change') {
      const objective = event.data?.goal?.objective
      if (typeof objective === 'string' && objective.trim() !== '') {
        const text = objective.trim().slice(0, TEXT_MAX)
        return { text, signal: 'goal-changed', title: titleFrom(text) }
      }
    }
    if (event.type === 'approval/decided') {
      const outcome = event.data?.outcome
      // Anything that is not an allowance is the user refusing an action.
      if (typeof outcome === 'string' && outcome !== '' && !outcome.startsWith('allowed')) {
        const text = `用户否决了一次操作（${outcome}）`
        return { text, signal: 'action-refused', title: text }
      }
    }
  }
  return undefined
}
