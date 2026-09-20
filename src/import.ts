/**
 * Migration from the archived runtime.
 *
 * The old store kept `entries.jsonl` next to each project (and, after migration,
 * a `memory.sqlite3`), with a different vocabulary: `type` rather than `kind`,
 * `text`/`summary` rather than `body`/`title`, and `scope: 'global'` for records
 * meant to cross projects.
 *
 * Two decisions are deliberate.
 *
 * *Imported records are written directly, not re-graded.* Passing them through
 * {@link remember} would grade every one as `inferred`, because a migration has
 * no session to quote from — and that would silently demote a store full of
 * verified facts on the way in.
 *
 * *A legacy `global` record becomes workspace-local.* We cannot tell which
 * domain it was meant for, and broadcasting it to every project is exactly the
 * leak the new scope rules exist to prevent. The count is reported so the
 * decision can be made deliberately, one record at a time.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { findByFingerprint, upsert } from './db.ts'
import { inferDomain, workspaceId } from './domain.ts'
import { fingerprint, newId } from './lifecycle.ts'
import type { Evidence, Kind, MemoryRecord, Scope, Status } from './types.ts'

/** One discovered old store. */
export interface LegacyStore {
  projectRoot: string
  memoryDir: string
  records: unknown[]
  /** Records dropped because this store already held the same content. */
  duplicates: number
}

/** A store that holds a copy of a live store rather than a live store. */
export interface ExcludedStore {
  path: string
  reason: string
}

export interface ScanResult {
  stores: LegacyStore[]
  /** Paths that could not be read, with the reason. */
  errors: string[]
  /** Stores deliberately not imported, with the reason. */
  excluded: ExcludedStore[]
}

const DEFAULT_MAX_DEPTH = 6
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', '__pycache__', 'dist', 'build'])

/** A directory name that marks a copy rather than a live store. */
const COPY_SEGMENT = /^(?:.*[-_])?(?:backup|snapshot|copy|rehearsal)(?:[-_].*)?$/i

/**
 * Why a `.memory` directory is a copy rather than a live store, or `undefined`
 * when it is live.
 *
 * The archived tree keeps both side by side: a project's `.memory` next to
 * `.codex/project-memory-backups/<stamp>/.memory`, packaged copies under
 * `.dev-packages/`, and evaluation pilots under `.eval-pilots/`. Importing the
 * copies multiplies one lesson by however many snapshots happen to exist, which
 * is how the archived tree reached 62 exact-duplicate groups and 34 copies of a
 * single record. They are excluded and reported rather than imported, so the
 * decision to include one stays visible and deliberate.
 */
function classifyStore(memoryDir: string): string | undefined {
  const segments = memoryDir.split(/[\\/]+/).filter(part => part !== '')
  if (segments.includes('.codex') && segments.includes('project-memory-backups')) return 'memory backup snapshot'
  if (segments.includes('.dev-packages')) return 'packaged development copy'
  if (segments.includes('.eval-pilots')) return 'evaluation pilot copy'
  const named = segments.find(segment => segment !== '.memory' && COPY_SEGMENT.test(segment))
  return named === undefined ? undefined : `copy directory (${named})`
}

/**
 * Drop records repeated inside one store.
 *
 * A store that has been migrated holds the same record twice — once in
 * `entries.jsonl`, once in `memory.sqlite3` — and a store written by repeated
 * runs of the old runtime holds it more often than that: one record in the
 * archived tree appeared 34 times. The key deliberately omits the timestamp,
 * because a repeated write of the same assertion is not new knowledge, and the
 * first occurrence is the one that records when the lesson was first learned.
 *
 * Only object records carrying a text field are keyed; everything else passes
 * through so the mapper still reports it as unreadable input instead of hiding
 * it.
 */
function dedupeRaw(records: readonly unknown[]): { records: unknown[]; duplicates: number } {
  const seen = new Set<string>()
  const unique: unknown[] = []
  let duplicates = 0
  for (const raw of records) {
    if (typeof raw !== 'object' || raw === null) { unique.push(raw); continue }
    const source = raw as Record<string, unknown>
    if (typeof source['text'] !== 'string') { unique.push(raw); continue }
    const key = [source['type'], source['text'], source['summary'], source['subject']].join('\u0000')
    if (seen.has(key)) { duplicates += 1; continue }
    seen.add(key)
    unique.push(raw)
  }
  return { records: unique, duplicates }
}

/** Recursively find `.memory` directories, bounded in depth and breadth. */
export function scanForStores(root: string, maxDepth: number = DEFAULT_MAX_DEPTH): ScanResult {
  const stores: LegacyStore[] = []
  const errors: string[] = []
  const excluded: ExcludedStore[] = []
  const start = resolve(root)
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch (error) {
      errors.push(`${dir}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue
      const child = join(dir, name)
      let isDir = false
      try {
        isDir = statSync(child).isDirectory()
      } catch {
        continue
      }
      if (!isDir) continue
      if (name === '.memory') {
        const reason = classifyStore(child)
        if (reason !== undefined) {
          excluded.push({ path: child, reason })
          continue
        }
        const store = readStore(child, dir, errors)
        if (store !== undefined) stores.push(store)
        continue
      }
      walk(child, depth + 1)
    }
  }
  walk(start, 0)
  return { stores, errors, excluded }
}

function readStore(memoryDir: string, projectRoot: string, errors: string[]): LegacyStore | undefined {
  const jsonl = join(memoryDir, 'entries.jsonl')
  const sqlite = join(memoryDir, 'memory.sqlite3')
  const found: unknown[] = []

  if (existsSync(jsonl)) {
    try {
      for (const line of readFileSync(jsonl, 'utf8').split(/\r?\n/)) {
        if (line.trim() === '') continue
        found.push(JSON.parse(line))
      }
    } catch (error) {
      errors.push(`${jsonl}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (existsSync(sqlite)) {
    try {
      const db = new DatabaseSync(sqlite, { readOnly: true })
      try {
        const rows = db.prepare('SELECT record FROM l2').all() as { record: string }[]
        for (const row of rows) found.push(JSON.parse(row.record))
      } finally {
        db.close()
      }
    } catch (error) {
      errors.push(`${sqlite}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (found.length === 0 && !existsSync(jsonl) && !existsSync(sqlite)) return undefined

  const { records, duplicates } = dedupeRaw(found)
  return { projectRoot, memoryDir, records, duplicates }
}

/** Labels the old runtime prefixed onto generated summaries. */
const SUMMARY_LABELS = /^(?:用户声明|文件记载|工具观察|待验证|已审核)[：:]\s*/

const KIND_MAP: Readonly<Record<string, Kind>> = {
  fact: 'fact', experience: 'experience', strategy: 'strategy', capability: 'strategy',
}

/**
 * Work-history event types the old runtime wrote into the same stream as
 * knowledge records (`memory_mvp.py event`). They are the raw observation, not
 * the lesson: a `failure` event says something broke, not what to do instead.
 * Importing them as experience would fill the store with exactly the noise the
 * resident threshold exists to keep out, so they are counted and left behind —
 * named, so the decision to keep or import them later stays visible.
 */
const EVENT_TYPES: ReadonlySet<string> = new Set([
  'task', 'attempt', 'fix', 'decision', 'failure', 'note',
])

/**
 * A tool-outcome event the old runtime wrote as ordinary knowledge.
 *
 * Filtering by `type` is not enough. When a tool call failed the old runtime
 * recorded `type: fact` with `admission.proof.kind: tool`, so these arrive with
 * the *strongest* evidence grade and `status: confirmed` while asserting nothing
 * at all: the whole record is `Tool call_00_... exited 1`, naming no command, no
 * error and no fix. There were 92 of them in the archived tree, and because
 * importance is dominated by the evidence grade, importing them would have put
 * them above every real lesson in the digest.
 *
 * The match is deliberately anchored to the whole body and to the two prefixes
 * the old runtime used, so a genuine lesson that happens to mention a failing
 * command — "npm test exited 1 until the lockfile was regenerated" — is still
 * knowledge and is still imported.
 */
const TOOL_EVENT_BODY = /^\s*tool\s+(?:call|exec)[-_][\w-]+\s+exited\s+-?\d+\s*$/i

const STATUS_MAP: Readonly<Record<string, Status>> = {
  confirmed: 'confirmed', active: 'confirmed', candidate: 'candidate', draft: 'candidate',
  archived: 'retired', deleted: 'retired', superseded: 'retired', expired: 'retired',
}

const PROOF_MAP: Readonly<Record<string, Evidence>> = {
  user: 'verified-user', file: 'verified-file', tool: 'verified-tool',
}

export interface MappedRecords {
  records: MemoryRecord[]
  /** Records dropped, by reason. */
  skipped: Record<string, number>
  /** Legacy `global` records pulled back to workspace scope. */
  globalDowngraded: number
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asTime(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return fallback
}

/**
 * Map one store's records onto the new schema.
 *
 * Unknown shapes are skipped and counted rather than guessed at, so an
 * unfamiliar field never silently becomes a confident record.
 */
export function mapStore(store: LegacyStore, now: number): MappedRecords {
  const workspace = workspaceId(store.projectRoot)
  const domain = inferDomain(store.projectRoot)
  const records: MemoryRecord[] = []
  const skipped: Record<string, number> = {}
  let globalDowngraded = 0
  const skip = (reason: string): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1
  }

  for (const raw of store.records) {
    if (typeof raw !== 'object' || raw === null) { skip('not an object'); continue }
    const source = raw as Record<string, unknown>
    const body = asString(source['text']).trim()
    if (body === '') { skip('no text'); continue }
    if (TOOL_EVENT_BODY.test(body)) { skip('tool-outcome event, not durable knowledge'); continue }

    const rawType = asString(source['type'])
    if (rawType === '') { skip('no type field'); continue }
    const kind = KIND_MAP[rawType]
    if (kind === undefined) {
      skip(EVENT_TYPES.has(rawType)
        ? `event record, not durable knowledge (${rawType})`
        : `unknown type (${rawType})`)
      continue
    }

    const rawTitle = asString(source['summary']).replace(SUMMARY_LABELS, '').trim()
    const title = (rawTitle === '' ? body.slice(0, 80) : rawTitle).slice(0, 200)

    // The old runtime often wrote its auto-generated summary as both the title
    // and the subject. A trigger that is the title, or a truncation of it, adds
    // nothing the record does not already say — and the FTS index weights the
    // trigger column highest, so keeping it would rank a record on its own label.
    // Measured on the 36 recommended archived records: 11 of the 31 non-empty
    // triggers were in this state, while the other 20 carried real new text.
    const rawTrigger = asString(source['subject']).trim()
    const trigger = rawTrigger !== '' && !title.startsWith(rawTrigger) ? rawTrigger : ''

    const legacyScope = asString(source['scope'], 'project')
    let scope: Scope = 'workspace'
    if (legacyScope === 'global') {
      // Deliberately pulled back to workspace scope; see the module comment.
      globalDowngraded += 1
    } else if (legacyScope !== 'project' && legacyScope !== 'workspace') {
      skip('unknown scope')
      continue
    }

    const admission = source['admission']
    const proof = typeof admission === 'object' && admission !== null
      ? (admission as { proof?: { kind?: unknown } }).proof
      : undefined
    const evidence = PROOF_MAP[asString(proof?.kind)] ?? 'inferred'

    const created = asTime(source['created_at'], now)
    const expires = source['expires_at']
    const review = source['review_after']

    records.push({
      id: newId(),
      workspaceId: workspace,
      domain,
      scope,
      kind,
      status: STATUS_MAP[asString(source['status'], 'candidate')] ?? 'candidate',
      evidence,
      title,
      body,
      trigger,
      failureMode: asString(source['failure_mode']),
      lesson: asString(source['lesson']),
      sourceRef: asString(source['evidence']) || asString(source['source']),
      reuseCount: 0,
      successCount: 0,
      failureCount: 0,
      failStreak: 0,
      distinctWorkspaces: 1,
      createdAt: created,
      occurredAt: created,
      updatedAt: now,
      lastUsedAt: null,
      reviewAfter: typeof review === 'string' || typeof review === 'number' ? asTime(review, now) : null,
      expiresAt: typeof expires === 'string' || typeof expires === 'number' ? asTime(expires, now) : null,
      contentFingerprint: fingerprint(kind, body),
      supersededBy: null,
      needsReview: asString(source['needs_review']) || null,
    })
  }

  return { records, skipped, globalDowngraded }
}

export interface ImportPlan {
  stores: number
  found: number
  mapped: number
  skipped: Record<string, number>
  globalDowngraded: number
  errors: string[]
  /** Stores left out because they are copies, with the reason. */
  excludedStores: ExcludedStore[]
  /** Records dropped because the same store already held them. */
  duplicateRecords: number
  /** Mapped records left out because a selection file did not name them. */
  unselected: number
}

/**
 * Stable key for one mapped record, so a selection file produced by the audit can
 * name exact records without depending on ids, which are generated per import.
 *
 * The pair is the same one the audit de-duplicates on, so a selection cannot
 * silently refer to two different records.
 */
export function selectionKey(record: MemoryRecord): string {
  return `${record.workspaceId}\u0000${record.contentFingerprint}`
}

export interface ImportOutcome extends ImportPlan {
  inserted: number
  merged: number
}

/**
 * Write mapped records.
 *
 * A record that already exists at the same scope and content is merged rather
 * than duplicated: the stronger evidence grade wins and the usage counters add
 * up, which is what re-importing after a partial run should do.
 *
 * `selection` names the records to write. Deciding *which* records deserve to be
 * imported is an editorial judgement about the data, and it belongs to the audit
 * that can justify it; this function only obeys a list it is handed. The filter
 * is applied before the `apply` check so a dry run reports what a selection would
 * exclude, which is the only way to review it.
 */
export function runImport(
  db: DatabaseSync,
  scan: ScanResult,
  options: { apply: boolean; now: number; selection?: ReadonlySet<string> },
): ImportOutcome {
  const plan: ImportPlan = {
    stores: scan.stores.length,
    found: 0,
    mapped: 0,
    skipped: {},
    globalDowngraded: 0,
    errors: scan.errors,
    excludedStores: scan.excluded,
    duplicateRecords: 0,
    unselected: 0,
  }
  let inserted = 0
  let merged = 0
  const selection = options.selection

  for (const store of scan.stores) {
    plan.found += store.records.length + store.duplicates
    plan.duplicateRecords += store.duplicates
    const { records, skipped, globalDowngraded } = mapStore(store, options.now)
    plan.mapped += records.length
    plan.globalDowngraded += globalDowngraded
    for (const [reason, count] of Object.entries(skipped)) {
      plan.skipped[reason] = (plan.skipped[reason] ?? 0) + count
    }

    const chosen: MemoryRecord[] = []
    for (const record of records) {
      if (selection !== undefined && !selection.has(selectionKey(record))) {
        plan.unselected += 1
        continue
      }
      chosen.push(record)
    }
    if (!options.apply) continue

    for (const record of chosen) {
      const existing = findByFingerprint(db, record.contentFingerprint, record.scope, record.workspaceId, record.domain)
      if (existing === undefined) {
        upsert(db, record)
        inserted += 1
        continue
      }
      const stronger = existing.evidence === 'inferred' && record.evidence !== 'inferred'
      upsert(db, {
        ...existing,
        evidence: stronger ? record.evidence : existing.evidence,
        status: stronger ? 'confirmed' : existing.status,
        needsReview: stronger ? null : existing.needsReview,
        updatedAt: options.now,
      })
      merged += 1
    }
  }

  return { ...plan, inserted, merged }
}

/**
 * Read a selection document written by the audit.
 *
 * Throws rather than returning an empty set when the document is malformed. An
 * empty selection is a legitimate answer — "import nothing" — so a file this
 * module cannot understand must never be silently equivalent to it.
 */
export function parseSelection(document: unknown): Set<string> {
  if (typeof document !== 'object' || document === null) {
    throw new TypeError('selection: expected an object with a "records" array')
  }
  const records = (document as { records?: unknown }).records
  if (!Array.isArray(records)) {
    throw new TypeError('selection: expected an object with a "records" array')
  }
  const keys = new Set<string>()
  for (const [index, entry] of records.entries()) {
    if (typeof entry !== 'object' || entry === null) {
      throw new TypeError(`selection: record ${index} is not an object`)
    }
    const { workspaceId, contentFingerprint } = entry as Record<string, unknown>
    if (typeof workspaceId !== 'string' || typeof contentFingerprint !== 'string') {
      throw new TypeError(`selection: record ${index} needs string workspaceId and contentFingerprint`)
    }
    keys.add(`${workspaceId}\u0000${contentFingerprint}`)
  }
  return keys
}

/**
 * The migration report, shared by the command line and the slash command.
 *
 * `skipped` names every reason records were left behind, including the two the
 * old runtime made easy to miss: work-history events, and tool-outcome events
 * that were written as `type: fact` with tool proof.
 */
export function summarizeImport(outcome: ImportOutcome, options: { apply: boolean }): string {
  const lines: string[] = []
  lines.push(`活库 ${outcome.stores} 个，副本库 ${outcome.excludedStores.length} 个（已排除）`)
  lines.push(`扫描到 ${outcome.found} 条，其中同库重复 ${outcome.duplicateRecords} 条`)
  lines.push(`可映射 ${outcome.mapped} 条`)
  if (outcome.unselected > 0) {
    lines.push(`清单未选中 ${outcome.unselected} 条，将导入 ${outcome.mapped - outcome.unselected} 条`)
  }
  if (outcome.globalDowngraded > 0) {
    lines.push(`旧 global 降为工作区级 ${outcome.globalDowngraded} 条`)
  }
  const skipped = Object.entries(outcome.skipped).sort((a, b) => b[1] - a[1])
  if (skipped.length > 0) {
    lines.push(`跳过：${skipped.map(([reason, count]) => `${reason} ${count}`).join('、')}`)
  }
  if (options.apply) {
    lines.push(`写入完成：新增 ${outcome.inserted} 条，合并 ${outcome.merged} 条`)
    if (outcome.merged > 0) {
      lines.push('（合并表示同一作用域下已有相同内容：更强的证据等级胜出，计数器累加）')
    }
  } else {
    lines.push('试运行 —— 未写入任何内容。加 --apply 才会写入。')
    lines.push('注意：导入记录是直接写入的，所以旧 global 记录会变成工作区级，需要你决定是否重新定范围。')
  }
  return lines.join('\n')
}
