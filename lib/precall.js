/**
 * Just-in-time recall: show a lesson at the moment the agent is about to do the thing.
 *
 * The resident digest competes for five slots against whatever else is important, and it is
 * gated on the turn's query. A recorded lesson therefore loses exactly when it matters most:
 * a user reported one — "confirm Steam is logged in before launching Bannerlord" — that had
 * been injected on nine of a session's fifteen turns and was absent on the turn the work
 * started, where the user had typed "开始吧". The agent launched without Steam and the run
 * was wasted.
 *
 * What the agent is *doing* is the signal that was being thrown away. So this module attaches
 * a lesson to the tool call it is about.
 *
 * ## What changed on 2026-09-23, and why
 *
 * The first version decided applicability by inference: pull identifier-shaped tokens out of
 * the call's arguments, look for a record that mentions one of them, prefer the record that
 * mentions the most. It was replayed over 15,383 real tool calls from this workspace's own
 * session logs and audited by hand, and it does not work:
 *
 *   - it delivered a hint on **57%** of calls;
 *   - a blind sample of 48 real deliveries found **4** that were about the call (8.3%). The
 *     rest fired on a coincidence — the PowerShell column header `AutoSize` linked a call to
 *     a lesson about output truncation; the word `encoding` in a URL fetch linked to a lesson
 *     about chunked decoding;
 *   - loosening the rule to catch more of the right records made the noise worse, and
 *     tightening it far enough to remove the noise left recall in single digits. In the
 *     loosest configuration only 14 of 25 hand-written "what should fire here" cases had the
 *     right record among the candidates *at all*, so no ranking change could have saved them.
 *
 * The measurements, the labeled sample and the failed alternatives are in
 * `docs/DELIVERY-GAPS.md`; `tools/replay.mjs` re-runs all of it.
 *
 * The replacement stops inferring. A record now **declares** which calls it applies to, as
 * anchors — `path:<file>`, `tool:<name>`, `command:<token>` — and the judgement is a fact
 * about the call rather than a resemblance between two vocabularies. See `anchors.ts` for
 * what counts as an anchor and `criteria.ts` for the decision. A record that declares nothing
 * is silent here on purpose: silence costs a hint that might not have been read, while a
 * wrong hint costs the credibility of every hint.
 */
                                               
import { decideForCall } from './criteria.js'
                                              

/** Bytes one attached lesson may cost. It rides along with a tool result, unasked for. */
export const PRECALL_MAX_BYTES = 300

/**
 * The one record worth putting in front of the agent for this call, or nothing.
 *
 * The judgement lives in `criteria.ts`; this stays as the name the rest of the plugin and its
 * tests call, and because the reasoning above belongs next to the feature it explains.
 */
export function recallForCall(
  db              ,
  workspaceId        ,
  domain        ,
  argumentsValue         ,
  now        ,
  options                    = {},
)                           {
  return recallForCallWithIdentifiers(db, workspaceId, domain, argumentsValue, now, options)?.record
}

/**
 * {@link recallForCall}, plus the anchors that actually carried it.
 *
 * The anchors are returned because they are the only honest answer to "why was this lesson
 * shown here", and a delivery is recorded with them so a later reader can check the reason
 * instead of inferring it. Nothing else in the store records a delivery at all, which is why
 * "did this lesson ever reach the agent" used to be unanswerable.
 */
export function recallForCallWithIdentifiers(
  db              ,
  workspaceId        ,
  domain        ,
  argumentsValue         ,
  now        ,
  options                    = {},
)                                                          {
  const decision = decideForCall(db, workspaceId, domain, argumentsValue, now, options)
  if (decision === undefined) return undefined
  return { record: decision.record, matched: decision.matched }
}

/** The line the agent sees. Deliberately short: it rides along with a tool result, unasked. */
export function renderPrecall(record              )         {
  const summary = record.lesson.trim() !== '' ? record.lesson.trim() : record.body.trim()
  const head = `[经验记忆] ${record.title} — `
  const tail = `（出处：${record.id}）`
  const whole = `${head}${summary}${tail}`
  if (byteLength(whole) <= PRECALL_MAX_BYTES) return whole

  // Trim the summary, never the id: the id is what makes the record citable, so it is the
  // one part that must survive the cut. Measured in bytes, one character at a time, because
  // a CJK character costs three and a naive slice would overflow the budget it just checked.
  const room = PRECALL_MAX_BYTES - byteLength(head) - byteLength(tail) - byteLength('…')
  let kept = ''
  for (const character of summary) {
    if (byteLength(kept + character) > room) break
    kept += character
  }
  return `${head}${kept}…${tail}`
}

function byteLength(text        )         {
  let bytes = 0
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4
  }
  return bytes
}
