/**
 * Anchors: the record declaring which call it applies to.
 *
 * This is the contract that replaced token inference (see `criteria.ts` for the measurements
 * that retired it), so it is worth pinning on its own: what a record may anchor on, what a
 * call satisfies, and — the part that decides whether the framework is trustworthy — that a
 * record which declares nothing is silent rather than guessed at.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, upsert } from '../src/db.ts'
import { decideForCall, recordAnchors } from '../src/criteria.ts'
import type { MemoryRecord } from '../src/types.ts'
import {
  ANCHOR_MARKER,
  anchorSatisfied,
  callFacts,
  deriveAnchorFromSourceRef,
  joinTrigger,
  parseAnchor,
  splitTrigger,
  suggestAnchors,
} from '../src/anchors.ts'
import { resolveWorkspace } from '../src/domain.ts'
import { explainRefusals, guardAnchors } from '../src/anchor-cost.ts'
import { ANCHOR_COST_TABLE } from '../src/anchor-cost-table.ts'
import { assert, eq } from './assert.ts'

export async function run(): Promise<void> {
  // ── Parsing: three kinds, and nothing else ────────────────────────────────
  eq(parseAnchor('path:src/tools.js'), { kind: 'path', token: 'src/tools.js' }, 'path: parses')
  eq(parseAnchor('tool:bigfat_research'), { kind: 'tool', token: 'bigfat_research' }, 'tool: parses')
  eq(parseAnchor('command:run_all.ps1'), { kind: 'command', token: 'run_all.ps1' }, 'command: parses')
  eq(parseAnchor('NOTICE-masterdata.md'), undefined,
    'a bare name is only an anchor when it is code — a report is evidence, not a location')
  eq(parseAnchor('repos/dsh-bigfat/lib/tools.js'), { kind: 'path', token: 'repos/dsh-bigfat/lib/tools.js' },
    'and a bare code path is read as one')
  eq(parseAnchor('   '), undefined, 'blank text anchors nothing')

  // ── What a call satisfies ─────────────────────────────────────────────────
  const edit = callFacts('edit', { file_path: 'F:\\ws\\repos\\dsh-bigfat\\lib\\tools.js', old_string: 'a' })
  assert(anchorSatisfied({ kind: 'path', token: 'tools.js' }, edit),
    'a path anchor matches on the file name, whatever directory it came from')
  assert(!anchorSatisfied({ kind: 'path', token: 'NOTICE-masterdata.json' }, edit),
    'but the extension has to match: a lesson about a different file of the same stem is not this call')
  const runCall = callFacts('pwsh', { command: 'pwsh -File .\\tests\\run_all.ps1' })
  assert(anchorSatisfied({ kind: 'command', token: 'run_all.ps1' }, runCall),
    'a command anchor matches the command line')
  assert(anchorSatisfied({ kind: 'tool', token: 'pwsh' }, runCall), 'a tool anchor matches the tool name')
  assert(!anchorSatisfied({ kind: 'tool', token: 'pwshx' }, runCall), 'and only exactly')
  assert(!anchorSatisfied({ kind: 'path', token: 'tools.js' }, runCall),
    'a call that does not name the file does not satisfy it')

  // ── The prose/delivery split inside the trigger column ────────────────────
  const joined = joinTrigger('准备在 pwsh 里执行 git 命令时', ['command:git'])
  assert(joined.includes(ANCHOR_MARKER), 'the anchors are joined under the marker')
  const back = splitTrigger(joined)
  eq(back.prose, '准备在 pwsh 里执行 git 命令时', 'and the prose comes back unchanged for the digest')
  eq(back.anchors, ['command:git'], 'with the anchor strings beside it')
  eq(splitTrigger('只有散文，没有锚点').anchors, [], 'a record written before the change parses cleanly')

  // ── Derivation from `source_ref`, and its two refusals ────────────────────
  eq(deriveAnchorFromSourceRef('dsh-experience-memory/src/domain.ts:27'),
    { kind: 'path', token: 'dsh-experience-memory/src/domain.ts' },
    'a file-verified record anchors on the whole path — three files here are called tools.js, '
    + 'and anchoring on the name alone fired 508 times')
  eq(deriveAnchorFromSourceRef('call_00_aBcDeF1234567890'), undefined,
    'a tool-call id proves the record, it does not locate it')
  eq(deriveAnchorFromSourceRef('audit/量化项目-现状体检报告.md:285'), undefined,
    'and a report is not a location either — that is the false-positive class the audit found')

  // ── Proposals from the turn (T1): read the calls, write nothing ──────────
  // The measured basis: a record's cited file appears among the turn's own calls in 67.3% of
  // cases at a ±8-call window and 90.6% at ±24 (random control 0%). So this proposes and stops —
  // a wrong anchor fires a lesson at the wrong moment, and 67–90% is a suggestion, not a fact.
  const turn = [
    { type: 'turn/start', data: {} },
    { type: 'tool/call', data: { callId: 'c1', name: 'read', arguments: JSON.stringify({ file_path: 'src/db.ts' }) } },
    { type: 'tool/call', data: { callId: 'c2', name: 'edit', arguments: JSON.stringify({ file_path: 'F:\\ws\\src\\anchors.ts' }) } },
    { type: 'tool/call', data: { callId: 'c3', name: 'pwsh', arguments: JSON.stringify({ command: 'node tools/status-report.mjs' }) } },
  ]
  eq(suggestAnchors({ events: turn, limit: 6 }).map(item => item.anchor),
    ['path:tools/status-report.mjs', 'command:node', 'tool:pwsh', 'tool:edit', 'path:src/db.ts', 'tool:read'],
    'newest call first; an absolute path yields no anchor, a workspace-relative one does')
  eq(suggestAnchors({ events: turn, limit: 1 }).length, 1, 'the limit is honoured')
  eq(suggestAnchors({ events: [] }), [], 'no turn, no proposals')
  // Live check 2026-09-24: the first real call proposed `command:$target`, because that turn's
  // PowerShell started with an assignment. A variable is not a program.
  eq(
    suggestAnchors({
      events: [
        { type: 'turn/start', data: {} },
        { type: 'tool/call', data: { callId: 'c8', name: 'pwsh', arguments: JSON.stringify({ command: '$target = "x"; Write-Output $target' }) } },
      ],
    }).map(item => item.anchor),
    ['tool:pwsh'],
    'a variable assignment is not proposed as a command anchor',
  )
  eq(
    suggestAnchors({ events: turn, sourceRef: 'dsh-experience-memory/src/anchors.ts:277' }).map(item => item.anchor),
    ['path:dsh-experience-memory/src/anchors.ts', 'path:tools/status-report.mjs'],
    'the cited path comes first: it is what the writer already decided the lesson is about',
  )
  // A report is evidence, not a location — the rule `deriveAnchorFromSourceRef` already applies.
  // Live check 2026-09-24: a real call proposed `path:.../DELIVERY-GAPS.md` because the turn had
  // read it, which would fire the lesson on whoever edits the audit trail.
  eq(
    suggestAnchors({
      events: [
        { type: 'turn/start', data: {} },
        { type: 'tool/call', data: { callId: 'c9', name: 'read', arguments: JSON.stringify({ file_path: 'docs/DELIVERY-GAPS.md' }) } },
      ],
    }).map(item => item.anchor),
    ['tool:read'],
    'a report file is not proposed as a location; the tool anchor still is',
  )

  // ── The write-time cost guard, measured anchors only ─────────────────────
  // `docs/DELIVERY-GAPS.md` §25: `path:node_modules` matched 702 of 15,896 calls and `tool:pwsh`
  // matched 5,936, and the second record owned 94.8% of every hint delivered. A guard that only
  // runs after the fact is a post-mortem; this one runs where the anchor is chosen.
  const synthetic = {
    generatedAt: '2026-09-24T00:00:00.000Z',
    corpus: 'tools/calls.jsonl',
    calls: 100,
    thresholdHits: 300,
    tokens: { 'tool:pwsh': 600 },
  }
  const guard = guardAnchors(['tool:pwsh', 'path:src/db.ts'], { table: synthetic })
  eq(guard.kept, ['path:src/db.ts'], 'an anchor over the gate is dropped and the narrow one kept')
  eq(guard.refused.length, 1, 'and the drop is reported once')
  eq(guard.refused[0]?.reason, 'too-common', 'with a reason a reader can act on')
  eq(guard.refused[0]?.hits, 600, 'and the measurement itself')
  assert(explainRefusals(guard)[0]?.includes('600'), 'the message carries the number that dropped it')
  eq(
    guardAnchors(['tool:pwsh'], { table: { ...synthetic, tokens: {} } }).kept,
    ['tool:pwsh'],
    'an empty table fails open rather than blocking every write',
  )
  eq(
    guardAnchors(['tool:pwsh'], { table: synthetic, enabled: false }).kept,
    ['tool:pwsh'],
    'turning the check off keeps whatever the caller declared',
  )
  eq(
    guardAnchors(['NOTICE-masterdata.md'], { table: synthetic }).refused[0]?.reason,
    'unparseable',
    'an anchor no reader could use is reported instead of stored to do nothing',
  )
  const mostExpensive = Object.entries(ANCHOR_COST_TABLE.tokens).sort((a, b) => b[1] - a[1])[0]
  assert(mostExpensive !== undefined, 'the shipped cost table has at least one entry')
  if (mostExpensive !== undefined) {
    eq(guardAnchors([mostExpensive[0]]).kept, [], 'the shipped table refuses its own most expensive token')
  }

  // ── End to end on a store ────────────────────────────────────────────────
  const dir = mkdtempSync(join(tmpdir(), 'expmem-anchors-'))
  const dbPath = join(dir, 'memory.db')
  const db = openDb(dbPath)
  try {
    const workspace = resolveWorkspace(dir, '')
    const now = Date.now()
    // Records are inserted directly rather than through `remember` for the delivery cases:
    // grading a record `confirmed` needs a verified passage (a user message or a file that
    // exists), and this suite is about what happens *after* a record is eligible, not about
    // how it earned the grade. `delivery.test.ts` drives the graded path end to end.
    const make = (over: Partial<MemoryRecord>): MemoryRecord => ({
      id: 'r1',
      workspaceId: workspace.id,
      domain: workspace.domain,
      scope: 'workspace',
      kind: 'experience',
      status: 'confirmed',
      evidence: 'verified-file',
      title: '标题',
      body: '正文。',
      trigger: '',
      failureMode: '',
      lesson: '',
      sourceRef: '',
      reuseCount: 0,
      successCount: 0,
      failureCount: 0,
      failStreak: 0,
      distinctWorkspaces: 1,
      createdAt: now,
      occurredAt: now,
      updatedAt: now,
      lastUsedAt: now,
      reviewAfter: null,
      expiresAt: null,
      contentFingerprint: 'fp',
      supersededBy: null,
      needsReview: null,
      ...over,
    })

    // The one that declares its own anchor, prose first.
    const declared = make({
      id: 'declared',
      contentFingerprint: 'fp-declared',
      title: '加参数要同时改 lib/tools.js',
      trigger: joinTrigger('要给工具加参数时', ['path:lib/tools.js']),
      sourceRef: 'lib/tools.js:3',
    })
    // The one that only has a code file in its provenance, so the anchor is derived.
    const derivedRecord = make({
      id: 'derived',
      contentFingerprint: 'fp-derived',
      title: '改 other.js 之前要先看 schema',
      sourceRef: 'lib/other.js:12',
    })
    // The one that anchors on neither: written before the change, provenance is a report.
    const silent = make({
      id: 'silent',
      contentFingerprint: 'fp-silent',
      title: '纯中文经验，出处是笔记',
      sourceRef: 'audit/某次复盘.md:12',
    })
    for (const record of [declared, derivedRecord, silent]) upsert(db, record)

    eq(recordAnchors(declared).via, 'declared', 'the declaring record is read from its own trigger')
    eq(recordAnchors(derivedRecord).via, 'derived', 'and the undeclared one falls back to its source file')
    eq(recordAnchors(silent).anchors.length, 0,
      'a record with neither a declared nor a derivable anchor offers none, so it stays silent')
    eq(splitTrigger(declared.trigger).prose, '要给工具加参数时',
      'and the prose half is still what the resident digest renders')

    const hit = decideForCall(db, workspace.id, workspace.domain, { file_path: 'lib/tools.js' }, now, { tool: 'edit' })
    assert(hit !== undefined, 'a call naming an anchored file gets a hint')
    eq(hit?.via, 'declared', 'and the declared anchor is the one that decided')
    eq(hit?.record.id, declared.id, 'against the record that declared it')
    assert(hit?.matched.includes('path:lib/tools.js'), `with the anchor recorded: ${hit?.matched.join(',')}`)

    // The same file, but only *read*: the declared anchor said so itself, so it applies.
    const readDecision = decideForCall(db, workspace.id, workspace.domain, { file_path: 'lib/tools.js' }, now, { tool: 'read' })
    eq(readDecision?.record.id, declared.id,
      'the declared anchor still applies on a read — the record named the file, not the act')

    // A derived anchor is the weaker claim, so it is **off by default** and, when switched on,
    // fires only when the call is about to change that file. Both halves are asserted: the
    // default is what ships, and the measured ceiling is what keeps it from shipping yet.
    const derivedRead = decideForCall(db, workspace.id, workspace.domain, { file_path: 'lib/other.js' }, now,
      { tool: 'read', derivedAnchors: true })
    eq(derivedRead, undefined, 'a derived anchor does not fire on a look')
    const derivedEdit = decideForCall(db, workspace.id, workspace.domain, { file_path: 'lib/other.js' }, now,
      { tool: 'edit', derivedAnchors: true })
    eq(derivedEdit?.record.id, derivedRecord.id, 'but it does fire when that file is about to be written')
    eq(derivedEdit?.via, 'derived', 'and the delivery says the anchor was derived, not declared')
    eq(decideForCall(db, workspace.id, workspace.domain, { file_path: 'lib/other.js' }, now, { tool: 'edit' }), undefined,
      'and it stays off unless the caller asks for it — the default is silence')

    const unrelated = decideForCall(db, workspace.id, workspace.domain, { file_path: 'lib/unrelated.js' }, now, { tool: 'edit' })
    eq(unrelated, undefined, 'a call naming nothing anchored gets nothing')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }

  console.log('  anchors    ok')
}
