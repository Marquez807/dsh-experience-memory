/**
 * Reading a tool result — in one place, because this harness has shipped two shapes of it.
 *
 * The failure counter (`failure.ts`) and the harvester's "failed and then worked" detector
 * (`harvest.ts`) ask the same two questions of a `tool/result` event: *did it fail*, and *what
 * did it say*. Each answered them with its own hand-written walk, and both walks knew the older
 * nesting:
 *
 *   - older sessions (v3 logs): `isError` on the block inside `data.message.content`, and the
 *     text one level deeper again at `block.content[].text`;
 *   - newer sessions (v4 logs): `isError` on `data.message` itself, and the text directly at
 *     `block.text`.
 *
 * So from the day the harness moved the flag, both walks kept answering the old question and
 * returned "no failures" — silently, for two weeks. The counter stopped growing and the
 * recovered-failure detector stopped firing, while every test stayed green, because every
 * fixture hand-built the old shape. That is the same failure this plugin already wrote down
 * once, in `session.ts`: fixtures that encode the assumption instead of the contract.
 *
 * Both spellings are accepted here rather than only the current one. A log written before the
 * move is still read after it, and accepting both is what turns the next move into a one-line
 * change in this file instead of another silent two-week outage.
 */

                                  

function asRecord(value         )                  {
  return typeof value === 'object' && value !== null ? (value       ) : undefined
}

/** The content blocks of a tool result, whichever of the two spellings carries them. */
export function resultBlocks(data         )                     {
  const outer = asRecord(data)
  const message = asRecord(outer?.message)
  const blocks = message?.content ?? outer?.content
  return Array.isArray(blocks) ? blocks : []
}

/**
 * Whether a tool result reports a failure.
 *
 * The newer spelling is checked first because it is the one live sessions write; the older one
 * stays accepted because the store holds two weeks of logs written that way.
 */
export function resultFailed(data         )          {
  if (asRecord(asRecord(data)?.message)?.isError === true) return true
  return resultBlocks(data).some(block => asRecord(block)?.isError === true)
}

/**
 * The readable text of a tool result: the first block that carries any.
 *
 * Newer sessions put it at `block.text`; older ones nested it at `block.content[].text`, where
 * `block.content` may itself be a string. All three are tried.
 */
export function resultText(data         )         {
  for (const block of resultBlocks(data)) {
    const rec = asRecord(block)
    if (rec === undefined) continue
    const direct = rec.text
    if (typeof direct === 'string' && direct.trim() !== '') return direct
    const inner = rec.content
    if (typeof inner === 'string' && inner.trim() !== '') return inner
    if (!Array.isArray(inner)) continue
    for (const piece of inner) {
      const text = asRecord(piece)?.text
      if (typeof text === 'string' && text.trim() !== '') return text
    }
  }
  return ''
}
