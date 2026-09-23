#!/usr/bin/env node
/**
 * Replace one declared anchor on one record — with the target printed before anything is resolved.
 *
 * Why this exists: a record's anchors are written at `memory_remember` time and nothing updates
 * them afterwards (re-reporting the same content corroborates it and leaves `trigger` alone). So
 * when an anchor turns out to be too broad — `path:node_modules` matched 702 of 15,896 calls and
 * one record took 78.8% of every hint the store delivered (docs/DELIVERY-GAPS.md 25) — the only
 * fix is a deliberate edit. This is that edit, and it is deliberately narrow:
 *
 *   - the store path is printed first, before anything else is resolved;
 *   - `--from` and `--to` must both parse as anchors, so a typo cannot be written;
 *   - the record must exist and its trigger must contain `--from` exactly, or nothing happens;
 *   - it changes exactly one record. No bulk mode, on purpose: a class of bad anchors is a
 *     write-time rule (not yet built), not a mass edit;
 *   - dry run by default. `--apply` writes, and records who did it in the audit log.
 *
 *   node tools/replace-anchor.mjs --id <record-id> --from path:node_modules \
 *        --to path:dsh-experience-memory/node_modules [--apply]
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = name => pathToFileURL(join(here, '..', 'lib', name)).href
const { defaultDbPath, openDb, getRecord, upsert, noteCorrection } = await import(lib('db.js'))
const { parseAnchor, splitTrigger, joinTrigger } = await import(lib('anchors.js'))

const args = process.argv.slice(2)
const flag = name => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
const apply = args.includes('--apply')
const id = flag('id')
const from = flag('from')
const to = flag('to')
const drop = args.includes('--drop')

// Habit 1 from the 271-record incident: announce the target before resolving anything else.
const storePath = flag('db') ?? defaultDbPath()
console.log(`store : ${storePath}`)
console.log(`mode  : ${apply ? 'APPLY（会写库）' : 'dry run（不写库）'}${drop ? ' · drop（删掉锚点）' : ''}`)
if (id === undefined || from === undefined || (to === undefined && !drop)) {
  console.error('需要 --id <record-id> --from <anchor> （--to <anchor> 或 --drop）')
  process.exit(2)
}
if (drop && to !== undefined) {
  console.error('--drop 与 --to 不能同时给：要么换掉、要么删掉。')
  process.exit(2)
}
const parsedFrom = parseAnchor(from)
if (parsedFrom === undefined) {
  console.error(`--from 不是一个合法锚点：${from}（形如 path:a/b.ts、tool:read、command:git）`)
  process.exit(2)
}
const parsedTo = to === undefined ? undefined : parseAnchor(to)
if (to !== undefined && parsedTo === undefined) {
  console.error(`--to 不是一个合法锚点：${to}`)
  process.exit(2)
}

const db = openDb(storePath)
const record = getRecord(db, id)
if (record === undefined) {
  console.error(`没有这条记录：${id}`)
  db.close()
  process.exit(3)
}
const { prose, anchors } = splitTrigger(record.trigger)
console.log(`record: ${id}  ${record.title}`)
console.log(`before: ${anchors.length === 0 ? '(没有锚点)' : anchors.join('  |  ')}`)
if (!anchors.includes(from)) {
  console.error(`这条记录的锚点里没有「${from}」——什么都不做。`)
  db.close()
  process.exit(4)
}

const next = drop
  ? anchors.filter(anchor => anchor !== from)
  : anchors.map(anchor => (anchor === from ? to : anchor))
console.log(`after : ${next.length === 0 ? '(没有锚点——记录仍进每轮摘要与搜索，只是不再动手前弹)' : next.join('  |  ')}`)
if (!apply) {
  db.close()
  console.log('\n（dry run。加 --apply 才写库。）')
  process.exit(0)
}

upsert(db, { ...record, trigger: joinTrigger(prose, next), updatedAt: Date.now() })
noteCorrection(
  db,
  id,
  'replace-anchor',
  drop ? `anchor dropped: ${from}` : `anchor replaced: ${from} -> ${to}`,
  Date.now(),
)
const reread = getRecord(db, id)
db.close()

const after = splitTrigger(reread?.trigger ?? '').anchors
const ok = drop
  ? !after.includes(from) && after.length === next.length
  : !after.includes(from) && after.includes(to)
console.log(`\n回读: ${after.length === 0 ? '(没有锚点)' : after.join('  |  ')}`)
console.log(ok ? (drop ? '✅ 已删除，并记了一条审计' : '✅ 已替换，并记了一条审计') : '❌ 回读与预期不符——请检查')
process.exit(ok ? 0 : 5)
