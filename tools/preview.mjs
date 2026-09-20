#!/usr/bin/env node
/**
 * Show exactly what the model would see for a given database, directory and query.
 *
 * The census comes from `lib/census.js` and the digest from the plugin's real
 * assembly path, so what it prints is what would actually be sent. This file only
 * parses arguments and formats output.
 *
 *   node tools/preview.mjs --db <path> --cwd <project root> --query "..." [--query "..."]
 *
 * It loads the built artifact from lib/ rather than the TypeScript sources, so it
 * runs from an installed package as well as from the repository.
 */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { DatabaseSync } from 'node:sqlite'
import { census, renderCensus } from '../lib/census.js'
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

const side = new DatabaseSync(dbPath, { readOnly: true })
try {
  console.log(renderCensus(census(side, { now: Date.now() }), { dbPath }))
} finally {
  side.close()
}

const ctx = new Context()
try {
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(memory, { enabled: true, dbPath })

  const agent = text => ({
    id: 'preview',
    session: {
      header: { cwd },
      events: text === undefined ? [] : [
        { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } },
      ],
    },
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
