/**
 * Which workspace a record's relative paths resolve against.
 *
 * `record.workspace_id` is `sha256(root.toLowerCase())[:16]` (`src/domain.ts`), and one store
 * holds every workspace that has ever used it — six or more on this machine. A tool that joins
 * a record's `source_ref` to the directory it happens to be run from therefore reports files as
 * missing that are sitting in the workspace that owns them: measured 2026-10-15, 74 of the first
 * 138 "missing sources" were exactly that, and the check that fed the same conclusion wrote it
 * into the store (109 of 161 notes, `src/lifecycle.ts` `checkProvenance` fixes the same defect).
 *
 * The id is one-way, so a root cannot be looked up — it is *enumerated*: walk the tree, recompute
 * each directory's id, keep the matches. A workspace rooted outside that tree will not be found,
 * and callers must treat "no root" as **undecidable**, never as "missing": the whole point of
 * this module is that a wrong root used to look exactly like an absent file.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { workspaceId } from '../../lib/domain.js'

/** Directories that cannot hold a workspace root and are expensive to walk. */
const SKIP = new Set([
  'node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build',
  '.quant', '.bigfat', '_frozen', '.build-check', '.pnpm',
])
const SKIP_PREFIX = ['_升级前备份', 'data']

/**
 * Every directory under `base` up to `maxDepth`, as a candidate workspace root.
 *
 * Depth 2 covers the layouts in use here (`repos/<name>`, `<sub-workspace>`); deeper trees cost
 * more than they find, and a missed root degrades to "undecidable" rather than to a wrong answer.
 */
export function enumerateRoots(base, maxDepth = 2) {
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
      if (SKIP.has(entry.name) || SKIP_PREFIX.some(prefix => entry.name.startsWith(prefix))) continue
      const child = join(dir, entry.name)
      out.push(child)
      walk(child, level + 1)
    }
  }
  walk(base, 1)
  return out
}

/**
 * `workspace_id` -> root, including `base` itself.
 *
 * Recomputed with the plugin's own `workspaceId`, so a directory resolves to the same id the
 * writing session did — guessing at the hash format is how a tool ends up disagreeing with the
 * store it is auditing.
 */
export function rootsById(base, maxDepth = 2) {
  const roots = new Map()
  for (const dir of enumerateRoots(base, maxDepth)) roots.set(workspaceId(dir), dir)
  roots.set(workspaceId(base), base)
  return roots
}

/**
 * The root to resolve one record against.
 *
 * `known: false` means this walk did not find the record's workspace. The caller must report
 * that as its own outcome — counting it as missing is the defect this module exists to stop.
 */
export function rootFor(record, roots) {
  const root = roots.get(String(record.workspace_id ?? ''))
  return root === undefined ? { root: undefined, known: false } : { root, known: true }
}

/** `path:12` / `path:12:34` -> `path`, keeping a Windows drive colon out of the way. */
export function stripRefLines(ref) {
  const parts = String(ref ?? '').trim().replace(/\\/g, '/').split(':')
  while (parts.length > 1 && /^\d+$/.test(parts[parts.length - 1])) parts.pop()
  return parts.join(':')
}
