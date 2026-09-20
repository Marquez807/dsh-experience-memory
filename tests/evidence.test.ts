/**
 * Evidence grading regressions.
 *
 * Grading is what keeps a guess out of the always-on digest, so it has to be
 * both hard to fool and cheap enough to actually run. The archived runtime made
 * it expensive instead of automatic, and the store stayed empty for it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, eq } from './assert.ts'
import { gradeEvidence, parseSourceRef, readWorkspaceFile, unsafeStatement } from '../src/evidence.ts'
import type { SessionEventLike } from '../src/evidence.ts'

const userMessage = (text: string, kind = 'user'): SessionEventLike => ({
  type: 'user/message',
  data: { source: { kind }, content: [{ type: 'text', text }] },
})

const toolResult = (callId: string, isError: boolean): SessionEventLike => ({
  type: 'tool/result',
  data: { message: { source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [], isError }] } },
})

// The real shape: a Session exposes its log through `snapshotEvents()`. A fixture
// built on a plain `events` array would exercise only the compatibility branch, and
// the production path is exactly what went unexercised while a verbatim user quote
// silently graded as `inferred` in a live run.
const session = (events: SessionEventLike[], cwd = process.cwd()) =>
  ({ session: { header: { cwd }, snapshotEvents: () => events } })

export function run(): void {
  // ── Phrasing that must not become a confirmed fact ───────────────────────
  assert(unsafeStatement('是这样吗？'), 'a question is a request, not an assertion')
  assert(unsafeStatement('可能是这样'), 'a hedge is not a commitment')
  assert(unsafeStatement('也许应该改成 F 盘'), 'a hedge mid-sentence counts too')
  assert(unsafeStatement('「他说的」'), 'a quoted citation is someone else\u2019s words')
  assert(unsafeStatement('   '), 'blank text asserts nothing')
  assert(!unsafeStatement('部署在 F 盘'), 'a plain assertion is safe')

  // ── Source reference parsing ─────────────────────────────────────────────
  eq(parseSourceRef('src/db.ts:12'), { path: 'src/db.ts', line: 12 }, 'path and line are split')
  eq(parseSourceRef('src/db.ts'), { path: 'src/db.ts', line: null }, 'a line number is optional')
  eq(parseSourceRef('   '), null, 'a blank reference parses to nothing')

  const dir = mkdtempSync(join(tmpdir(), 'expmem-ev-'))
  try {
    writeFileSync(join(dir, 'note.md'), 'the deployment target is the F drive\n')

    // ── File access stays inside the workspace, and says why when it fails ──
    // A bare `undefined` for four different situations is what let a caller misdiagnose
    // three of its own records: each failure arrived as "the quote did not match".
    const readable = readWorkspaceFile(dir, 'note.md')
    assert(readable.ok && readable.text.includes('F drive'), 'a workspace file is readable')
    const escaped = readWorkspaceFile(dir, '../escape.txt')
    assert(!escaped.ok && escaped.miss === 'escape', 'a path escaping the workspace is named as such')
    const absolute = readWorkspaceFile(dir, 'F:/elsewhere/note.md')
    assert(!absolute.ok && absolute.miss === 'absolute', 'an absolute path is named as such')
    const missing = readWorkspaceFile(dir, 'missing.md')
    assert(!missing.ok && missing.miss === 'missing', 'a missing file is named as such')
    assert(!missing.ok && (missing.entries ?? []).includes('note.md'),
      'and the directory listing shows what is actually there')
    eq(readWorkspaceFile(dir, 'note.md').ok, true, 'and none of it throws')

    // The listing mixes directories with files, and a caller reading it took a
    // directory for a file. Directories are therefore sorted ahead of files and marked
    // with a trailing slash, so "what this directory holds" never presents a file as a
    // directory — and the entry that explains the miss is never buried by the cut.
    mkdirSync(join(dir, 'zeta'))
    mkdirSync(join(dir, 'alpha'))
    const ordered = readWorkspaceFile(dir, 'missing.md')
    eq((ordered.ok ? [] : ordered.entries ?? []).join(','), 'alpha/,zeta/,note.md',
      'directories sort first and are marked, files follow unmarked')

    const crowded = mkdtempSync(join(tmpdir(), 'expmem-crowded-'))
    try {
      for (let i = 0; i < 15; i += 1) mkdirSync(join(crowded, `d${String(i).padStart(2, '0')}`))
      writeFileSync(join(crowded, 'file.md'), 'x\n')
      const capped = readWorkspaceFile(crowded, 'nowhere.md')
      eq(capped.ok ? 0 : capped.entriesTotal, 16, 'the whole count is reported, not just what fits')
      eq((capped.ok ? [] : capped.entries ?? []).length, 12, 'and the list itself is capped')
      const cappedReason = gradeEvidence({
        quote: 'x', sourceRef: 'nowhere.md', workspaceRoot: crowded,
      }).reason
      assert(cappedReason.includes('holds 16 entries (showing the first 12 of 16; directories first, marked "/")'),
        `the truncation is admitted rather than hidden: ${cappedReason}`)
    } finally {
      rmSync(crowded, { recursive: true, force: true })
    }

    // ── verified-tool needs a successful result, not merely a cited id ──────
    eq(gradeEvidence({
      quote: 'anything', sourceRef: 'call-1', workspaceRoot: dir,
      agent: session([userMessage('hello', 'user'), toolResult('call-1', false)]),
    }).grade, 'verified-tool', 'a cited tool call that succeeded verifies the claim')

    eq(gradeEvidence({
      quote: 'anything', sourceRef: 'call-1', workspaceRoot: dir,
      agent: session([toolResult('call-1', true)]),
    }).grade, 'inferred', 'a cited tool call that errored proves nothing')

    eq(gradeEvidence({
      quote: 'anything', sourceRef: 'call-9', workspaceRoot: dir,
      agent: session([toolResult('call-1', false)]),
    }).grade, 'inferred', 'a cited id with no matching result proves nothing')

    // ── verified-user needs a real user message, not our own injection ──────
    eq(gradeEvidence({
      quote: '部署在 F 盘', workspaceRoot: dir,
      agent: session([userMessage('部署在 F 盘')]),
    }).grade, 'verified-user', 'a verbatim user assertion verifies the claim')

    eq(gradeEvidence({
      quote: '部署在 F 盘', workspaceRoot: dir,
      agent: session([userMessage('部署在 F 盘吗？')]),
    }).grade, 'inferred', 'the same words inside a question do not verify')

    eq(gradeEvidence({
      quote: '我注入的', workspaceRoot: dir,
      agent: session([userMessage('我注入的', 'plugin')]),
    }).grade, 'inferred', 'a plugin-sourced message is not the user speaking')

    // ── verified-file needs the quote to actually be in the file ────────────
    eq(gradeEvidence({
      quote: 'the deployment target is the F drive', sourceRef: 'note.md', workspaceRoot: dir,
    }).grade, 'verified-file', 'a quote present in the cited file verifies the claim')

    eq(gradeEvidence({
      quote: 'something not in the file', sourceRef: 'note.md', workspaceRoot: dir,
    }).grade, 'inferred', 'a quote absent from the cited file does not')

    // ── No passage, no verified grade ───────────────────────────────────────
    eq(gradeEvidence({ workspaceRoot: dir }).grade, 'inferred', 'no quote means nothing can be verified')
    eq(gradeEvidence({ quote: 'x', workspaceRoot: dir }).grade, 'inferred',
      'no session and no source reference means nothing can be verified')

    // ── A failure names what was tried, and which route was read ───────────
    // The three defects a caller reported after spending five recording experiments on
    // them: an absolute path silently dropped, a quote defeated by markdown decoration,
    // and one generic sentence covering every cause.
    const asAbsolute = gradeEvidence({
      quote: 'the deployment target is the F drive',
      sourceRef: `${dir}/note.md:1`, workspaceRoot: dir,
    })
    eq(asAbsolute.grade, 'inferred', 'an absolute source_ref does not verify')
    eq(asAbsolute.route, 'none', 'and no route claims to have verified it')
    assert(asAbsolute.reason.includes('absolute path'),
      `the reason names the absolute path, not the quote: ${asAbsolute.reason}`)
    assert(asAbsolute.reason.includes('workspace-relative'),
      'and says what to write instead')

    const absentFile = gradeEvidence({
      quote: 'anything', sourceRef: 'lib/nowhere.ts:4', workspaceRoot: dir,
    })
    assert(absentFile.reason.includes('no such file') && absentFile.reason.includes('lib/nowhere.ts'),
      `a missing file is reported as missing: ${absentFile.reason}`)
    assert(absentFile.reason.includes('note.md'),
      `and the nearest existing directory is listed, so the real path is one glance away: ${absentFile.reason}`)

    eq(gradeEvidence({
      quote: 'the deployment target is the F drive', sourceRef: 'note.md', workspaceRoot: dir,
    }).route, 'file', 'a verified file claim reports the file route')

    writeFileSync(join(dir, 'styled.md'), '**为什么这里不写**：那是一个会过期的状态。\n')
    const decorated = gradeEvidence({
      quote: '为什么这里不写：那是一个会过期的状态。', sourceRef: 'styled.md', workspaceRoot: dir,
    })
    eq(decorated.grade, 'inferred',
      'decoration still breaks verbatim matching — the grade is not softened for it')
    assert(decorated.reason.includes('markdown decoration'),
      `but the reason identifies the decoration as the cause: ${decorated.reason}`)

    const nearMiss = gradeEvidence({
      quote: '为什么这里不写那段：那是一个会过期的状态。', sourceRef: 'styled.md', workspaceRoot: dir,
    })
    assert(nearMiss.reason.includes('line 1'),
      `a near miss points at the closest line: ${nearMiss.reason}`)

    eq(gradeEvidence({
      quote: '部署在 F 盘', workspaceRoot: dir,
      agent: session([userMessage('部署在 F 盘')]),
    }).route, 'user-message', 'a user assertion reports the message route')

    eq(gradeEvidence({
      quote: 'anything', sourceRef: 'call-1', workspaceRoot: dir,
      agent: session([toolResult('call-1', false)]),
    }).route, 'tool-call', 'a tool call reports the tool route')

    // ── The tool-call route is reachable: the ids are handed over ──────────
    // A caller cited "memory_stats（本会话调用输出）" — prose where an id was needed —
    // because a model never sees a call id as text, so the strongest route was
    // unreachable in practice and the record stayed a candidate forever.
    const withCall = gradeEvidence({
      quote: 'the deployment target is the F drive',
      sourceRef: 'memory_stats（本会话调用输出）',
      workspaceRoot: dir,
      agent: session([toolResult('call-7', false)]),
    })
    assert(withCall.reason.includes('call-7'),
      `the failure reason names a call id the caller could cite instead: ${withCall.reason}`)
    eq(gradeEvidence({
      quote: 'anything', sourceRef: 'call-7', workspaceRoot: dir,
      agent: session([toolResult('call-7', false)]),
    }).grade, 'verified-tool', 'and citing that id verifies the claim')

    // ── Tool evidence outranks file evidence when both are available ────────
    eq(gradeEvidence({
      quote: 'the deployment target is the F drive', sourceRef: 'call-1', workspaceRoot: dir,
      agent: session([toolResult('call-1', false)]),
    }).grade, 'verified-tool', 'a successful tool call is the strongest available signal')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  console.log('  evidence   ok')
}
