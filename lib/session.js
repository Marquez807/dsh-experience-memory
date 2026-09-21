/**
 * Reading a session's events — in one place, because getting this wrong was
 * invisible.
 *
 * The plugin used to read `agent.session.events`: a plain array property that does
 * **not exist** on a real Session. So in production both the evidence grader and
 * the retrieval-query builder saw an empty log:
 *
 *   - a verbatim user assertion was never graded `verified-user`, so nothing the
 *     user said face-to-face could ever become a confirmed record;
 *   - the query builder always returned `''`, so the "relevant to this turn" half
 *     of the resident digest was always empty.
 *
 * The test suite passed throughout, because every fixture hand-built the array
 * that the production objects do not have. The fixtures encoded the assumption
 * instead of the contract.
 *
 * The real accessor is `session.snapshotEvents()`. Both readers now go through
 * {@link eventsOf}, so the assumption lives once, and a live run is what caught it.
 */
                                                                          

                                                        

/**
 * The events of one session, or `[]` when it cannot be read.
 *
 * `snapshotEvents()` is tried first because that is the real API. An `events`
 * array is still accepted so a hand-built session (tests, embedding hosts) keeps
 * working — but note that accepting it is exactly what let the wrong property
 * survive, so the primary path is the one the fixtures now exercise.
 */
export function sessionEvents(session                         )                              {
  if (session === undefined || session === null) return []
  if (typeof session.snapshotEvents === 'function') {
    try {
      return session.snapshotEvents() ?? []
    } catch {
      // A session that cannot materialize its log is treated as having none, the
      // same as an empty one; the caller's failure report covers the rest.
      return []
    }
  }
  return session.events ?? []
}

/** The events of the session belonging to one agent. */
export function eventsOf(agent                       )                              {
  return sessionEvents(agent?.session)
}

/**
 * Which agent preset this session runs, or `''` when nothing recorded one.
 *
 * Read so a mode can be left without memory (see `disabledPresets`). The header names the
 * preset the session *started* with and is a creation fact — a session may change preset while
 * blank, and the change is recorded as an `agent-preset/selected` event — so the events are
 * consulted too and the latest one wins. Getting this wrong is not symmetric: reading only the
 * header would keep memory switched off in a session the user moved *into* a memory-enabled
 * mode, and reading only the events would miss every session that never switched.
 */
export function presetOf(agent                       )         {
  let preset = agent?.session?.header?.agentPreset ?? ''
  for (const event of eventsOf(agent)) {
    if (event.type !== 'agent-preset/selected') continue
    const selected = event.data?.agentPreset
    if (typeof selected === 'string') preset = selected
  }
  return preset
}

/**
 * Whether this agent's mode is one the operator asked to keep free of memory.
 *
 * Empty list means nothing is disabled, which is the default: the setting exists so a
 * model-test mode can exist beside the modes that do want memory, not to change the default.
 */
export function memoryDisabled(agent                       , disabledPresets                   )          {
  if (disabledPresets.length === 0) return false
  const preset = presetOf(agent)
  return preset !== '' && disabledPresets.includes(preset)
}
