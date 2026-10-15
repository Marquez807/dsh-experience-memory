#!/usr/bin/env node
/**
 * Clear the `出处文件已不存在` notes that were written against the wrong workspace root.
 *
 * `checkProvenance` resolves a record's `source_ref` against the **calling session's** cwd,
 * while the maintenance batch it runs over is the whole store — every workspace's records. A
 * record belonging to another workspace therefore had its relative path joined to a root it
 * does not live under, and was flagged as gone when the file was there all along. Measured on
 * the live store, 2026-10-15: of 140 notes, **88 were this** — and the wrongness ran both
 * ways, since records of the root that *was* passed got flagged by sessions running elsewhere.
 *
 * `src/lifecycle.ts` now skips records whose `workspace_id` is not the caller's, so no new
 * note can be written this way. This tool cleans up the ones already in the store, and it is
 * deliberately conservative:
 *
 *   - only a note that *is* this marker is touched; a note a human wrote is left alone;
 *   - a record is cleared only when its cited file is found **under its own root**;
 *   - a record whose root cannot be enumerated is reported, never guessed at.
 *
 * Roots can only be enumerated, not looked up: `workspace_id` is a one-way hash, so the tool
 * walks the tree, recomputes the id of each directory and matches. A workspace rooted outside
 * that tree will not be found — which is the reason an unmatched record is reported rather
 * than resolved.
 *
 *   node tools/repair-provenance.mjs --cwd <workspace root> [--depth 2] [--apply] [--out <md>]
 */
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { defaultDbPath } from '../lib/db.js'
import { workspaceId } from '../lib/domain.js'
import { SOURCE_GONE } from '../lib/lifecycle.js'

const args = process.argv.slice(2)
const flag = name => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
const has = name => args.includes(`--${name}`)

const dbPath = flag('db') ?? defaultDbPath()
const cwd = flag('cwd') ?? process.cwd()
const depth = Number(flag('depth') ?? 2)
const apply = has('apply')
const outPath = flag('out')

// Directories that cannot hold a workspace root and are expensive to walk.
const SKIP = new Set([
  'node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build',
  '.quant', '.bigfat', '_frozen', '.build-check', '.pnpm',
])
const SKIP_PREFIX = ['_升级前备份', 'data']

function candidateRoots(base, maxDepth) {
  const out = []
  const walk = (dir, level) => {
    if (level > maxDepth) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (SKIP.has(entry.name) || SKIP_PREFIX.some(p => entry.name.startsWith(p))) continue
      const child = join(dir, entry.name)
      out.push(child)
      walk(child, level + 1)
    }
  }
  walk(base, 1)
  return out
}

/** `path:12` / `path:12:34` -> `path`, keeping a Windows drive colon out of the way. */
const stripRef = ref => {
  const parts = String(ref).trim().replace(/\\/g, '/').split(':')
  while (parts.length > 1 && /^\d+$/.test(parts[parts.length - 1])) parts.pop()
  return parts.join(':')
}

// Read-only unless `--apply`: a dry run must not be able to write even by accident.
const db = new DatabaseSync(dbPath, { readOnly: !apply })
const flagged = db.prepare(
  `SELECT id, title, source_ref, workspace_id, needs_review
     FROM record
    WHERE needs_review LIKE ?`,
).all(`${SOURCE_GONE}%`)

const roots = new Map([[workspaceId(cwd), cwd]])
for (const dir of candidateRoots(cwd, depth)) roots.set(workspaceId(dir), dir)

const clearable = []
const kept = []
const unknown = []
for (const row of flagged) {
  const ref = String(row.source_ref ?? '').trim()
  const path = isAbsolute(ref) ? '' : stripRef(ref)
  const root = roots.get(String(row.workspace_id))
  if (root === undefined || path === '') {
    unknown.push({ ...row, path })
    continue
  }
  if (existsSync(join(root, path))) clearable.push({ ...row, path, root })
  else kept.push({ ...row, path, root })
}

const say = []
const line = text => { say.push(text); console.log(text) }

line(`库：${dbPath}`)
line(`写入者根：${cwd}（枚举到 ${roots.size} 个工作区根，深度 ${depth}）`)
line(`带「${SOURCE_GONE}」标记的记录：${flagged.length}`)
line('')
line(`  可清除（引用的文件就在记录自己的工作区里）：${clearable.length}`)
line(`  保留（文件确实不在它自己的根下）          ：${kept.length}`)
line(`  无法判定（根未枚举到、或出处不是相对路径）  ：${unknown.length}`)

if (clearable.length > 0) {
  line('')
  line('## 将清除的（前 25 条）')
  for (const row of clearable.slice(0, 25)) {
    line(`- \`${row.id}\` ${String(row.title).slice(0, 52)} — ${row.root} / ${row.path}`)
  }
}
if (kept.length > 0) {
  line('')
  line('## 保留的（前 15 条）')
  for (const row of kept.slice(0, 15)) {
    line(`- \`${row.id}\` ${String(row.title).slice(0, 52)} — ${row.path}`)
  }
}
if (unknown.length > 0) {
  line('')
  line('## 无法判定的（全部）')
  for (const row of unknown) {
    line(`- \`${row.id}\` ${String(row.title).slice(0, 52)} — ws=${row.workspace_id} ref=${row.path || row.source_ref}`)
  }
}

line('')
if (!apply) {
  line('（试运行。加 `--apply` 才会清掉上面这些标记；清空前先跑 `node tools/snapshot.mjs`。）')
} else {
  const update = db.prepare('UPDATE record SET needs_review = NULL WHERE id = ? AND needs_review LIKE ?')
  let wrote = 0
  for (const row of clearable) {
    const result = update.run(row.id, `${SOURCE_GONE}%`)
    wrote += Number(result.changes ?? 0)
  }
  line(`已清除 ${wrote} 条标记。未触碰其余 ${kept.length + unknown.length} 条。`)
}
db.close()

if (outPath !== undefined) {
  writeFileSync(outPath, `${say.join('\n')}\n`, 'utf8')
  console.log(`\n已写入：${outPath}`)
}
