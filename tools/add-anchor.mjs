#!/usr/bin/env node
/**
 * Add one declared anchor to one record — deliberately, with the target printed first.
 *
 * `replace-anchor.mjs` swaps or drops an anchor that is already there. This is its sibling for the
 * case that produced this file: a record that carries a real lesson but **declares nowhere it
 * applies**, so it is only ever delivered in the per-turn digest and never just before the action.
 * T2 measured what that costs — the wipeguard record sat in the digest, contained the exact rule the
 * judge wanted, and changed no behaviour in 15 cells (`docs/DELIVERY-GAPS.md` §26).
 *
 * Narrow on purpose, for the same reasons as its sibling:
 *
 *   - the store path and the record are printed before anything is resolved;
 *   - every `--add` must parse as an anchor, or nothing is written;
 *   - **the cost table is consulted first**: an anchor at or above the threshold (300 of 15,896 real
 *     calls) is refused outright rather than silently dropped — this is a deliberate edit, so the
 *     operator should see the number and choose a narrower anchor;
 *   - an anchor already present is refused, not duplicated;
 *   - it changes exactly one record, and it never touches body/title/lesson;
 *   - dry run by default. `--apply` writes and leaves one `noteCorrection` audit row.
 *
 *   node tools/add-anchor.mjs --id <record-id> --add path:wipe.mjs --add command:wipe.mjs
 *   node tools/add-anchor.mjs --id <record-id> --add path:wipe.mjs --apply
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = name => pathToFileURL(join(here, '..', 'lib', name)).href
const { defaultDbPath, openDb, getRecord, upsert, noteCorrection } = await import(lib('db.js'))
const { parseAnchor, splitTrigger, joinTrigger } = await import(lib('anchors.js'))
const { guardAnchors } = await import(lib('anchor-cost.js'))
// The guard's result carries a *summary* of the table, not the per-token counts, so the hit numbers
// printed below come from the generated table itself.
const { ANCHOR_COST_TABLE } = await import(lib('anchor-cost-table.js'))

const args = process.argv.slice(2)
const flag = name => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
const allFlags = name => {
  const out = []
  for (let i = 0; i < args.length; i++) if (args[i] === `--${name}`) out.push(args[i + 1])
  return out.filter(v => v !== undefined)
}
const apply = args.includes('--apply')
const id = flag('id')
const add = allFlags('add')

// Habit 1 from the 271-record incident: announce the target before resolving anything else.
const storePath = flag('db') ?? defaultDbPath()
console.log(`store : ${storePath}`)
console.log(`mode  : ${apply ? 'APPLY（会写库）' : 'dry run（不写库）'}`)
if (id === undefined || add.length === 0) {
  console.error('需要 --id <record-id> --add <anchor>（可重复给多个 --add）')
  process.exit(2)
}
for (const anchor of add) {
  if (parseAnchor(anchor) === undefined) {
    console.error(`不是一个合法锚点：${anchor}（形如 path:a/b.ts、tool:read、command:git）`)
    process.exit(2)
  }
}
// An anchor that fires on a large share of real calls is what took 94.8% of the hint budget once.
// Refuse loudly here instead of dropping quietly: this is a hand edit, so the number is the point.
const guard = guardAnchors(add, { enabled: true })
if (guard.refused.length > 0) {
  for (const refusal of guard.refused) {
    console.error(`拒绝写入：${refusal.anchor} 命中 ${refusal.hits} 次（阈值 ${guard.table?.thresholdHits}）—— 换成更窄的锚点`)
  }
  process.exit(3)
}

const db = openDb(storePath)
const record = getRecord(db, id)
if (record === undefined) {
  console.error(`没有这条记录：${id}`)
  db.close()
  process.exit(4)
}
const { prose, anchors } = splitTrigger(record.trigger)
console.log(`record: ${id}  ${record.title}`)
console.log(`before: ${anchors.length === 0 ? '(没有锚点——只进每轮摘要，从不"动手前"弹)' : anchors.join('  |  ')}`)

const duplicates = add.filter(a => anchors.includes(a))
if (duplicates.length > 0) {
  console.error(`这些锚点已经在记录上，不动：${duplicates.join('、')}`)
  db.close()
  process.exit(5)
}
const next = [...anchors, ...add]
console.log(`after : ${next.join('  |  ')}`)
console.log(`命中共计（${ANCHOR_COST_TABLE.calls} 次真实调用里，阈值 ${ANCHOR_COST_TABLE.thresholdHits}）: ${add.map(a => `${a}=${ANCHOR_COST_TABLE.tokens[a] ?? 0}`).join('  ')}`)

if (!apply) {
  db.close()
  console.log('\n（dry run。加 --apply 才写库；写前建议先跑一次 node tools/snapshot.mjs。）')
  process.exit(0)
}

upsert(db, { ...record, trigger: joinTrigger(prose, next), updatedAt: Date.now() })
noteCorrection(db, id, 'add-anchor', `anchors added: ${add.join(', ')}`, Date.now())
const reread = getRecord(db, id)
db.close()

const after = splitTrigger(reread?.trigger ?? '').anchors
const ok = add.every(a => after.includes(a)) && after.length === next.length
console.log(`\n回读: ${after.join('  |  ')}`)
console.log(ok ? '✅ 已添加，并记了一条审计' : '❌ 回读与预期不符——请检查')
process.exit(ok ? 0 : 6)
