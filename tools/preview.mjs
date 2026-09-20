#!/usr/bin/env node
/**
 * Show exactly what the model would see for a given database, directory and query.
 *
 * This exists because the two questions that come up whenever a memory does not
 * appear — "is it in the store?" and "why is it not in the prompt?" — have
 * different answers, and neither is visible from the tools alone. It drives the
 * plugin's real assembly path, so what it prints is what would be sent.
 *
 *   node tools/preview.mjs --db <path> --cwd <project root> --query "..." [--query "..."]
 *
 * It loads the built artifact from lib/, so it also serves as a check that the
 * shipped entry behaves the same as the source.
 */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { DatabaseSync } from 'node:sqlite'
import * as memory from '../lib/index.js'

const argv = process.argv.slice(2)
const values = name => argv.reduce((found, arg, index) => (
  arg === `--${name}` && argv[index + 1] !== undefined ? [...found, argv[index + 1]] : found
), [])
const one = name => values(name)[0]

const dbPath = one('db')
if (dbPath === undefined) {
  console.error('usage: node tools/preview.mjs --db <path> [--cwd <dir>] [--query <text>]...')
  process.exit(2)
}
const cwd = one('cwd') ?? process.cwd()
const queries = values('query')
if (queries.length === 0) queries.push('继续')

// A read-only census first: "is it in the store?" is a different question from
// "is it in the prompt?", and answering the second without the first is how a
// retrieval problem gets misdiagnosed as a missing record.
const side = new DatabaseSync(dbPath, { readOnly: true })
const count = sql => side.prepare(sql).get()
console.log(`database : ${dbPath}`)
console.log(`  records      : ${count('SELECT count(*) AS n FROM record').n}`)
console.log(`  confirmed    : ${count("SELECT count(*) AS n FROM record WHERE status = 'confirmed'").n}`)
console.log(`  by evidence  : ${side.prepare(
  'SELECT evidence, count(*) AS n FROM record GROUP BY evidence ORDER BY n DESC',
).all().map(row => `${row.evidence}=${row.n}`).join(' ')}`)
console.log(`  by scope     : ${side.prepare(
  'SELECT scope, count(*) AS n FROM record GROUP BY scope ORDER BY n DESC',
).all().map(row => `${row.scope}=${row.n}`).join(' ')}`)

// The audit trail: `usage` and `correction` are append-only and were written but
// never read by anything, so "why did this lose its place, or leave entirely?"
// had no answer short of opening SQLite by hand. That is the question this tool
// exists to answer, so it reads them here.
const trail = side.prepare(
  'SELECT (SELECT count(*) FROM usage) AS uses,'
  + ' (SELECT count(*) FROM usage WHERE outcome = ?) AS successes,'
  + ' (SELECT count(*) FROM usage WHERE outcome = ?) AS failures,'
  + ' (SELECT count(*) FROM correction) AS corrections',
).get('success', 'failure')
console.log(`  usage rows   : ${trail.uses} (success ${trail.successes} / failure ${trail.failures})`)
console.log(`  corrections  : ${trail.corrections}`)

const retired = side.prepare(
  "SELECT r.id, r.title, r.scope, c.reason, c.at FROM record r"
  + " LEFT JOIN correction c ON c.record_id = r.id"
  + " WHERE r.status = 'retired' ORDER BY c.at DESC LIMIT 20",
).all()
if (retired.length > 0) {
  console.log(`  retired      : ${retired.length}${retired.length === 20 ? '+' : ''} (newest first)`)
  for (const row of retired) {
    const when = row.at === null ? 'no correction row' : new Date(row.at).toISOString().slice(0, 10)
    console.log(`    ${when}  [${row.id}] ${String(row.title).slice(0, 48)} — ${row.reason ?? 'unknown'}`)
  }
}
side.close()

const ctx = new Context()
try {
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(memory, { enabled: true, dbPath })

  const agent = (text) => ({
    id: 'preview',
    session: { header: { cwd }, events: text === undefined ? [] : [
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } },
    ] },
  })

  for (const query of queries) {
    console.log('')
    console.log(`── query: ${JSON.stringify(query)}   cwd: ${cwd}`)

    const assembly = await ctx.systemPrompt.assemble({ agent: agent(query) })
    const entry = assembly.contexts.find(item => item.name === 'experience-memory:resident')
    const digest = entry?.text ?? ''
    console.log(`  resident digest: ${digest === '' ? '(empty — nothing injected this turn)' : ''}`)
    if (digest !== '') console.log(digest.split('\n').map(line => `    ${line}`).join('\n'))

    const definition = ctx.tools.get('memory_recall')
    const pack = await definition.execute({ query }, {
      signal: new AbortController().signal,
      agent: agent(query),
    })
    console.log(`  memory_recall  : returned ${pack.returned} of ${pack.total}`
      + `${pack.truncated ? ' (truncated by the byte budget)' : ''}`)
    for (const line of String(pack.text).split('\n').slice(0, 24)) console.log(`    ${line}`)
  }
} finally {
  await ctx.fiber.dispose()
}
