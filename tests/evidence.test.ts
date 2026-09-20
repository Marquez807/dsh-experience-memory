/**
 * Evidence grading regressions.
 *
 * Grading is what keeps a guess out of the always-on digest, so it has to be
 * both hard to fool and cheap enough to actually run. The archived runtime made
 * it expensive instead of automatic, and the store stayed empty for it.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

const session = (events: SessionEventLike[], cwd = process.cwd()) => ({ session: { header: { cwd }, events } })

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

    // ── File access stays inside the workspace ──────────────────────────────
    assert(readWorkspaceFile(dir, 'note.md')?.includes('F drive') === true, 'a workspace file is readable')
    eq(readWorkspaceFile(dir, '../escape.txt'), undefined, 'a path escaping the workspace is refused')
    eq(readWorkspaceFile(dir, '/etc/passwd'), undefined, 'an absolute path is refused')
    eq(readWorkspaceFile(dir, 'missing.md'), undefined, 'a missing file is undefined, never a throw')

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
