/**
 * Plugin integration: mount the real services, load the plugin, and drive every
 * tool through its own registration.
 *
 * A bundle passing `--dump-config` only proves the configuration composes. This
 * suite mounts SystemPrompt, ToolRuntime and the command service — everything the
 * plugin injects — and then exercises the whole loop: record, recall, link an
 * outcome, retire.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Commands from '@deepseek-ai/dsh-commands'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as experienceMemory from '../src/index.ts'
import { recentQueryText } from '../src/index.ts'
import { buildIdentity } from '../src/build-id.ts'
import { openDb } from '../src/db.ts'
import { assert, eq } from './assert.ts'
import type { DatabaseSync } from 'node:sqlite'

const TOOLS = ['memory_recall', 'memory_remember', 'memory_feedback', 'memory_forget', 'memory_stats'] as const

interface Agent {
  id?: string
  session: {
    header: { cwd: string }
    /**
     * The real shape. A Session exposes its log through `snapshotEvents()`; a plain
     * `events` array exists only for hand-built sessions. Fixtures must carry the
     * method, because a fixture that only has the array tests the fallback and
     * leaves the production path unexercised — which is how a broken
     * `agent.session.events` read survived the whole suite once already.
     */
    snapshotEvents?: () => readonly unknown[]
    events?: readonly unknown[]
  }
}

const userMessage = (text: string, kind = 'user') => ({
  type: 'user/message',
  data: { source: { kind }, content: [{ type: 'text', text }] },
})

/** A session in the shape a real one has: the log behind a method. */
const sessionWith = (events: readonly unknown[], cwd = process.cwd()) => ({
  header: { cwd },
  snapshotEvents: () => events,
})

/**
 * One successful tool result, in the shape the harness records it.
 *
 * The grade for `route: tool-call` is matched against `message.source.callId`, so a
 * fixture that omits the envelope cannot exercise the route at all — the same way a
 * plain `events` array only exercises the session compatibility branch.
 */
const toolResult = (callId: string, isError = false): unknown => ({
  type: 'tool/result',
  data: {
    message: {
      source: { kind: 'tool', callId },
      content: [{ type: 'tool-result', toolCallId: callId, content: [], isError }],
    },
  },
})

export async function run(): Promise<void> {
  // ── Query derivation is pure, so test it without a Context ───────────────
  eq(recentQueryText(undefined), '', 'no agent yields no query')
  eq(recentQueryText({}), '', 'an agent without a session yields no query')
  const m = (text: string, kind?: string) => ({
    type: 'user/message',
    data: { source: { kind: kind ?? 'user' }, content: [{ type: 'text', text }] },
  })
  // The primary path: a real session, whose log is only reachable by calling.
  eq(recentQueryText({ session: sessionWith([m('第一句'), m('第二句')]) }),
    '第一句\n第二句', 'the last user messages become the query, read from a real session')
  eq(recentQueryText({ session: sessionWith([m('旧'), m('新'), m('我注入的', 'plugin')]) }),
    '旧\n新', 'a plugin-sourced message is never read back as the query')
  eq(recentQueryText({ session: sessionWith([m('   ')]) }), '', 'a blank message contributes nothing')
  // The compatibility branch, kept so a hand-built session still works — and
  // labelled as such, so it is never mistaken for the real contract again.
  eq(recentQueryText({ session: { events: [m('回退分支')] } }),
    '回退分支', 'a plain events array is still accepted from a hand-built session')
  eq(recentQueryText({ session: { snapshotEvents: () => { throw new Error('no log') } } }), '',
    'a session whose log cannot be materialized contributes no query rather than throwing')

  // ── What the agent is doing is part of the query, not only what was asked ──
  // This is the Steam case, and it is the reason the query no longer reads only the user's
  // words. On the turn where work started the user said "开始吧" — three characters sharing
  // no term with the recorded lesson "confirm Steam is logged in before launching
  // Bannerlord" — so the always-on layer went empty at the only moment it mattered, while
  // the agent was visibly about to run the launcher. The turn's own activity is the signal
  // that was being thrown away.
  const active = sessionWith([
    m('开始吧'),
    { type: 'tool/call', data: { name: 'pwsh', arguments: '{"command":".\\launch-a-runtime-clean.ps1"}' } },
    {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'reasoning', text: '私有推理不该进查询' }, { type: 'text', text: '现在启动游戏做无人值守验证' }] } },
    },
    { type: 'todo/write', data: { todos: [{ content: '启动 Bannerlord 跑一轮' }, { content: '收集日志' }] } },
  ])
  const withActivity = recentQueryText({ session: active })
  assert(withActivity.includes('launch-a-runtime-clean.ps1'),
    `the command the agent is running is searchable: ${withActivity}`)
  assert(withActivity.includes('现在启动游戏做无人值守验证'),
    'and so is what it just said it is doing')
  assert(withActivity.includes('启动 Bannerlord 跑一轮'), 'and the task list it is working through')
  assert(!withActivity.includes('私有推理'),
    'but its private reasoning is not: feeding its own speculation back into the query is the loop this plugin already refuses on the injection side')
  eq(recentQueryText({ session: sessionWith([m('只有一句话')]) }), '只有一句话',
    'a session with no activity produces exactly the old query, so nothing changed for the quiet case')

  const dir = mkdtempSync(join(tmpdir(), 'expmem-plugin-'))
  const dbPath = join(dir, 'memory.db')
  const ctx = new Context()
  let stopped = false
  try {
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(Commands, {})
    await ctx.plugin(experienceMemory, { enabled: true, dbPath })

    // ── Every tool is registered and visible to the registry ──────────────
    const schemas = ctx.tools.schemas().map(schema => schema.name)
    for (const tool of TOOLS) {
      assert(ctx.tools.get(tool) !== undefined, `${tool} is registered`)
      assert(schemas.includes(tool), `${tool} has a visible schema`)
    }

    /** Run one tool exactly as the pipeline would, with an optional agent. */
    const call = async <T>(name: string, args: unknown, agent?: Agent, callId?: string): Promise<T> => {
      const definition = ctx.tools.get(name)
      assert(definition !== undefined, `${name} exists`)
      return await definition!.execute(args, {
        signal: new AbortController().signal,
        agent,
        ...callId === undefined ? {} : { callId },
      }) as T
    }

    const agentFor = (events: readonly unknown[]): Agent => ({
      id: 'session-1',
      session: { header: { cwd: dir }, snapshotEvents: () => events },
    })

    // ── The digest reaches the assembled prompt, and is re-evaluated ───────
    // Registering a context only proves the plugin *can* contribute. At least one
    // test must drive the real `assemble` API and read the result, because
    // injection is the plugin's entire purpose and it has its own failure modes:
    // a digest that never renders, or one frozen at boot instead of tracking the
    // live task.
    const digestOf = async (events: readonly unknown[] = []): Promise<string> => {
      const assembly = await ctx.systemPrompt.assemble({ agent: agentFor(events) })
      const entry = assembly.contexts.find(c => c.name === 'experience-memory:resident')
      assert(entry !== undefined, 'the plugin contributes a resident context to every assembly')
      return entry!.text
    }
    eq(await digestOf(), '', 'an empty memory renders nothing rather than an empty section')
    eq(await digestOf([userMessage('部署')]), '',
      'and a query with no matching record still renders nothing')

    // ── The record hint survives an empty store ───────────────────────────
    // Measured, not assumed: across five real sessions and ~5,900 tool calls, with
    // the memory tools offered in every request epoch, `memory_remember` was never
    // called until a human asked for a record by name. Folding the reminder into the
    // digest would have left it silent exactly here — an empty store is the state in
    // which the model most needs to be told that recording exists.
    const emptyAssembly = await ctx.systemPrompt.assemble({ agent: agentFor([]) })
    const emptyDigest = emptyAssembly.contexts.find(c => c.name === 'experience-memory:resident')
    const emptyHint = emptyAssembly.contexts.find(c => c.name === 'experience-memory:record-hint')
    assert(emptyDigest === undefined || emptyDigest.text === '',
      'with nothing stored, the digest contributes nothing')
    assert(emptyHint !== undefined, 'but the record hint is still contributed')
    assert(emptyHint!.text.includes('memory_remember'),
      'and it names the tool, so it is actionable rather than advice')

    // ── An unverifiable claim stays a candidate and is not recalled ────────
    const weak = await call<{ outcome: string; id: string; status: string; evidence: string }>(
      'memory_remember',
      { kind: 'experience', title: '部署目标盘', body: '部署一律写到 F 盘' },
      agentFor([]),
    )
    eq(weak.evidence, 'inferred', 'a claim with no passage is graded as an inference')
    eq(weak.status, 'candidate', 'and stays a candidate')
    const weakRecall = await call<{ returned: number; text: string }>('memory_recall', { query: '部署' }, agentFor([]))
    eq(weakRecall.returned, 0, 'a candidate is not recalled, because only confirmed records are')
    // A candidate is a claim recorded without a verifiable passage. If it could
    // never be listed again, the model could record unverified claims and never
    // see them — a store filling with assertions nobody can act on. `retrieve`
    // supported the review window from the start; no tool exposed it.
    const candidates = await call<{ returned: number; text: string }>(
      'memory_recall', { query: '部署', include_candidates: true }, agentFor([]),
    )
    eq(candidates.returned, 1, 'an explicit review can list candidates')
    assert(candidates.text.includes(weak.id), 'and names the record so it can be acted on')
    assert(candidates.text.includes('待复核'), 'and says what it is waiting for')

    // ── The same claim with a verbatim passage is confirmed and recalled ───
    const quote = '部署一律写到 F 盘，不要写 C 盘'
    const verified = await call<{ outcome: string; id: string; status: string; evidence: string }>(
      'memory_remember',
      { kind: 'experience', title: '部署目标盘', body: '部署一律写到 F 盘', quote, trigger: '部署' },
      agentFor([userMessage(quote)]),
    )
    eq(verified.evidence, 'verified-user', 'a verbatim user assertion verifies the claim')
    eq(verified.status, 'confirmed', 'so the record is confirmed')
    eq(verified.outcome, 'corroborated', 'and it upgraded the candidate instead of adding a row')

    const goodRecall = await call<{ returned: number; text: string; truncated: boolean }>(
      'memory_recall', { query: '部署' }, agentFor([]),
    )
    eq(goodRecall.returned, 1, 'the confirmed record is recalled')
    assert(goodRecall.text.includes(verified.id), 'the recall names the record id so it can be acted on')
    eq(goodRecall.truncated, false, 'a small answer is not marked truncated')

    // ── Searching a record out is recorded ────────────────────────────────
    // It is the only trace that a memory written earlier was ever reached for later. The
    // store could say what was written and nothing about what was read, so "is this pile
    // being used" had no answer — and a record nobody looks for cannot earn the bonus that
    // keeps it in the always-on layer, so it went silent and stayed that way.
    const readCount = (): number => {
      const side = openDb(dbPath)
      try {
        return (side.prepare('SELECT retrieve_count AS n FROM record WHERE id = ?')
          .get(verified.id) as { n: number }).n
      } finally {
        side.close()
      }
    }
    eq(readCount(), 2,
      'both recalls above recorded it: the candidate review and this one, onto the same row')
    // Automatic injection must not count, or a record once injected would keep itself
    // injected forever and the number would stop meaning "someone looked for this".
    await digestOf([userMessage('部署')])
    eq(readCount(), 2, 'being injected automatically is not the same as being searched for')
    await call('memory_recall', { query: '部署' }, agentFor([]))
    eq(readCount(), 3, 'and searching again counts again')
    const recalledText = (await call<{ text: string }>('memory_recall', { query: '部署' }, agentFor([]))).text
    assert(recalledText.includes('被查过'), `a recall says whether the record has been reached for before: ${recalledText}`)

    // ── The model can ask what it holds ───────────────────────────────────
    // Read-only, and the numbers must describe the store rather than the tool's
    // own idea of it. The candidate was upgraded in place, so there is one record.
    const stats = await call<{
      records: number; confirmed: number; candidates: number; retired: number
      resident_eligible: number; usage_total: number; corrections: number; text: string
    }>('memory_stats', {}, agentFor([]))
    eq(stats.records, 1, 'stats counts the records that exist')
    eq(stats.confirmed, 1, 'and separates confirmed from candidates')
    eq(stats.candidates, 0, 'with nothing left as a candidate')
    eq(stats.retired, 0, 'and nothing retired yet')
    eq(stats.resident_eligible, 1, 'and reports how many would be injected right now')
    eq(stats.usage_total, 0, 'a census records no usage of its own, because it is read-only')
    assert(stats.text.includes('记录 1 条'), 'the readable rendering agrees with the structured counts')
    // The build id leads, and it is the only answer a model-side caller can get:
    // the version never changes, and a plugin's own logger output does not reach
    // `harness.log`. Pinned here so the line cannot quietly lose its head.
    assert(/^插件构建 [0-9a-f]{12}（\d+ 个模块）\n/.test(stats.text),
      'the build id leads the readable stats, so a caller can tell which build is loaded')
    eq(stats.text.split('\n')[0], `插件构建 ${buildIdentity().id}（${buildIdentity().modules} 个模块）`,
      'and it is the real hash of the modules this run loaded, not a literal that could go stale')
    eq((await call<{ records: number; usage_total: number }>('memory_stats', {}, agentFor([]))).records, 1,
      'and asking twice changes nothing')

    // The same record now reaches the prompt through the resident context. This
    // also pins the layer's real contract: `retrieve` returns nothing when the
    // query has no indexable term, so the resident digest is query-gated rather
    // than unconditional — a turn about something else does not carry it.
    const firstDigest = await digestOf([userMessage('部署')])
    assert(firstDigest.includes(verified.id), 'the assembled prompt carries the record id')
    assert(firstDigest.includes('部署目标盘'), 'and the record title')
    eq(await digestOf([userMessage('今天天气不错')]), '',
      'the resident layer is query-gated: an unrelated turn does not carry the record')

    // ── Two consecutive failures retire it, and it stops being recalled ────
    const first = await call<{ outcome: string; fail_streak: number }>(
      'memory_feedback', { record_id: verified.id, outcome: 'failure' }, agentFor([]),
    )
    eq(first.outcome, 'recorded', 'one failure is recorded but does not retire')
    eq(first.fail_streak, 1, 'the streak counts')
    const second = await call<{ outcome: string; status: string }>(
      'memory_feedback', { record_id: verified.id, outcome: 'failure' }, agentFor([]),
    )
    eq(second.outcome, 'retired', 'the second consecutive failure retires the record')
    eq(second.status, 'retired', 'and the status reflects it')

    const afterFailure = await call<{ returned: number }>('memory_recall', { query: '部署' }, agentFor([]))
    eq(afterFailure.returned, 0, 'a retired record is not recalled by default')
    eq(await digestOf([userMessage('部署')]), '',
      'and it leaves the prompt on the next assembly, so the digest is not frozen at boot')
    const auditing = await call<{ returned: number }>(
      'memory_recall', { query: '部署', include_retired: true }, agentFor([]),
    )
    eq(auditing.returned, 1, 'but an audit can still see it')

    // ── A success clears the streak rather than accumulating one ───────────
    const keeper = await call<{ id: string }>(
      'memory_remember',
      { kind: 'fact', title: '测试命令', body: '用 node tests/run.ts 跑测试', quote: '用 node tests/run.ts 跑测试' },
      agentFor([userMessage('用 node tests/run.ts 跑测试')]),
    )
    await call('memory_feedback', { record_id: keeper.id, outcome: 'failure' }, agentFor([]))
    const recovered = await call<{ fail_streak: number; outcome: string }>(
      'memory_feedback', { record_id: keeper.id, outcome: 'success' }, agentFor([]),
    )
    eq(recovered.fail_streak, 0, 'a success clears the failure streak')
    eq(recovered.outcome, 'recorded', 'so the record is kept')

    // ── Forgetting is reversible by default ────────────────────────────────
    const retired = await call<{ outcome: string }>(
      'memory_forget', { record_id: keeper.id, reason: '命令已经改了' }, agentFor([]),
    )
    eq(retired.outcome, 'retired', 'forget retires rather than deleting')

    // ── Core memory: a corroborated lesson survives an unrelated turn ──────
    // This is the gap the query-gated resident layer cannot cover: the user
    // replies "继续", nothing matches, and the digest empties out mid-task. Two
    // workspaces must independently report the same content first — that is what
    // "core" means, and it is the whole reason the injection is allowed to be
    // unconditional.
    const sharedBody = '回滚前先导出一份当前状态的副本'
    const sharedQuote = '回滚前先导出一份当前状态的副本，别再直接覆盖'
    const domainRoots = ['core-a', 'core-b'].map(leaf => {
      const root = join(dir, leaf)
      mkdirSync(root, { recursive: true })
      // The same `name` in both manifests is what makes them the same domain
      // while staying two distinct workspaces.
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@probe/core-domain' }))
      return root
    })

    const rememberIn = async (root: string, title: string) =>
      await call<{ outcome: string; id: string }>(
        'memory_remember',
        { kind: 'experience', title, body: sharedBody, quote: sharedQuote, trigger: '回滚' },
        { id: 'core-session', session: { header: { cwd: root }, snapshotEvents: () => [userMessage(sharedQuote)] } },
      )

    const firstCopy = await rememberIn(domainRoots[0]!, '回滚前先备份')
    eq(firstCopy.outcome, 'created', 'the first workspace keeps the lesson local to itself')
    // A different title on the same body still corroborates, because identity is
    // the assertion rather than its label.
    const secondCopy = await rememberIn(domainRoots[1]!, '回滚前先导出副本')
    eq(secondCopy.outcome, 'promoted', 'the second workspace promotes it to the domain')

    const digestFor = async (root: string, text: string): Promise<string> => {
      const assembly = await ctx.systemPrompt.assemble({
        agent: { id: 'core-session', session: { header: { cwd: root }, snapshotEvents: () => [userMessage(text)] } },
      })
      const entry = assembly.contexts.find(c => c.name === 'experience-memory:resident')
      assert(entry !== undefined, 'the resident context is present')
      return entry!.text
    }

    const unrelated = await digestFor(domainRoots[0]!, '继续')
    assert(unrelated.includes(secondCopy.id),
      'a corroborated lesson appears even on a turn that matches nothing')
    assert(unrelated.includes('领域通用'),
      'and it is labelled as cross-project rather than as relevant to this turn')
    assert(!unrelated.includes('与本轮相关'),
      'the task-relevant section is omitted when nothing matched, not rendered empty')

    // The promoted record is shared; the workspace-local copy is retired behind
    // it, so the same lesson cannot be injected twice or from two places.
    const seenFromDomain = await call<{ returned: number; total: number }>(
      'memory_recall', { query: '回滚', include_retired: true },
      { id: 'core-session', session: { header: { cwd: domainRoots[0]! }, snapshotEvents: () => [] } },
    )
    eq(seenFromDomain.total, 1, 'one lesson remains, not one per workspace that learned it')

    // ── An unknown id is a loud error, not a silent success ────────────────
    let threw = false
    try {
      await call('memory_feedback', { record_id: 'does-not-exist', outcome: 'success' }, agentFor([]))
    } catch (error) {
      threw = error instanceof Error && error.message.includes('does-not-exist')
    }
    assert(threw, 'linking an outcome to an unknown record fails loudly')

    // ── The tool can arm the decay window ──────────────────────────────────
    // `expiresAt` and `reviewAfter` used to be settable only by the legacy
    // importer, so two of the three retirement paths were unreachable for
    // anything this plugin recorded itself.
    const expiresOf = (id: string): number | null => {
      const side = openDb(dbPath)
      try {
        return (side.prepare('SELECT expires_at FROM record WHERE id = ?').get(id) as {
          expires_at: number | null
        }).expires_at
      } finally {
        side.close()
      }
    }
    const windowed = await call<{ id: string }>(
      'memory_remember',
      {
        kind: 'fact', title: '当前版本基线', body: '当前客户端版本是 1.5.2',
        quote: '当前客户端版本是 1.5.2', expires_in_days: 5,
      },
      agentFor([userMessage('当前客户端版本是 1.5.2')]),
    )
    const storedExpiry = expiresOf(windowed.id)
    assert(storedExpiry !== null, 'expires_in_days is stored as an absolute expiry')
    eq(Math.round((storedExpiry! - Date.now()) / 86_400_000), 5, 'five days out from now')

    let refused = false
    try {
      await call(
        'memory_remember',
        { kind: 'fact', title: '零天窗口', body: '零天窗口应当被拒绝而不是静默忽略', expires_in_days: 0 },
        agentFor([]),
      )
    } catch {
      refused = true
    }
    assert(refused, 'a zero-day window is rejected rather than silently ignored')

    // ── Maintenance runs on the plugin's own turn-stopping hook ────────────
    // `maintain()` has unit tests of its own. What is unverified without this is
    // the wiring: that the plugin listens on the real `agent/turn-stopping`
    // event, that the pass reaches the store, and that a failing pass cannot
    // break a turn. The hook is dispatched exactly as `dsh-agent-loop` does it,
    // through the agent-scoped dispatcher.
    const expiring = await call<{ id: string }>(
      'memory_remember',
      { kind: 'fact', title: '即将过期的记录', body: '这条会被维护判为过期', quote: '这条会被维护判为过期' },
      agentFor([userMessage('这条会被维护判为过期')]),
    )
    const statusOf = (id: string): string => {
      const side = openDb(dbPath)
      try {
        return (side.prepare('SELECT status FROM record WHERE id = ?').get(id) as { status: string }).status
      } finally {
        side.close()
      }
    }
    eq(statusOf(expiring.id), 'confirmed', 'the record is live before the pass')
    // The tool has no expiry argument, so the expiry is set where it lives.
    const side = openDb(dbPath)
    side.prepare('UPDATE record SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, expiring.id)
    side.close()

    const dispatchTurnStopping = async (turn: number): Promise<void> => {
      await agentEvents(ctx, agentFor([])).serial('agent/turn-stopping', {
        turn,
        signal: new AbortController().signal,
      })
    }
    await dispatchTurnStopping(1)
    eq(statusOf(expiring.id), 'retired', 'the turn-stopping hook ran maintenance and retired the expired record')

    // ── The pass folds the write-ahead log back into the main file ─────────
    // `memory.db` is not the store on its own: recent writes live in `-wal` until a
    // checkpoint. Measured on a live store, the main file held 30 records while the store
    // held 53 — so a copy of that one file was 43% stale, with no error anywhere. The
    // checkpoint is what stops that, so the assertion is the copy itself: a file copied
    // away from the WAL must agree with the live store.
    const mainOnly = join(dir, 'main-only-copy.db')
    copyFileSync(dbPath, mainOnly)
    const copied = openDb(mainOnly)
    const copiedCount = (copied.prepare('SELECT count(*) AS n FROM record').get() as { n: number }).n
    copied.close()
    const liveCount = (await call<{ records: number }>('memory_stats', {}, agentFor([]))).records
    eq(copiedCount, liveCount,
      'the main file alone is current after a maintenance pass, so copying it is not silently stale')

    // ── A read-only observer names its own call, so it can be cited ────────
    // `route: tool-call` used to be reachable only through a failure: the id was
    // printed in a failing record's reason and nowhere else, so "record what the tool
    // just told me" cost a wasted attempt whose only purpose was to discover the id.
    const citedId = 'call_00_test_census'
    const observable = await call<{ text: string }>('memory_stats', {}, agentFor([]), citedId)
    assert(observable.text.includes(citedId),
      `a read-only observer names its own call id: ${observable.text}`)
    const anonymous = await call<{ text: string }>('memory_stats', {}, agentFor([]))
    assert(!anonymous.text.includes('本调用 id'),
      'and a call the registry assigned no id to omits the line rather than inventing one')
    assert((await call<{ text: string }>(
      'memory_recall', { query: '部署' }, agentFor([]), citedId,
    )).text.includes(citedId), 'memory_recall names its own call id too')

    // The point of naming it: one attempt, not two. The claim cites the observer that
    // produced it and lands on the strongest grade the framework has.
    const citing = await call<{ status: string; evidence: string; route: string }>(
      'memory_remember',
      {
        kind: 'fact',
        title: '只读工具的返回可以自证出处',
        body: '只读工具在自己的返回里带上 call id，记录主张时可直接引用，不必先失败一次去发现它。',
        quote: '本调用 id（把它填进 source_ref 即可判 verified-tool）',
        source_ref: citedId,
      },
      agentFor([toolResult(citedId)]),
    )
    eq(citing.route, 'tool-call', 'a claim citing a named observer takes the tool-call route')
    eq(citing.evidence, 'verified-tool', 'and reaches the strongest grade without a wasted attempt')
    eq(citing.status, 'confirmed', 'so the record is usable rather than a stranded candidate')

    // A pass that cannot run must stay invisible to the turn. Dropping the table
    // maintenance resumes from makes it fail on its first statement.
    const breaker = openDb(dbPath)
    breaker.exec('DROP TABLE meta')
    breaker.close()
    let survived = true
    try {
      await dispatchTurnStopping(2)
    } catch {
      survived = false
    }
    assert(survived, 'a failing maintenance pass is swallowed, so it can never fail a turn')

    // ── A mode can be left without memory ──────────────────────────────────
    // Why this has to live in the plugin rather than in the mode: a preset cannot switch off a
    // plugin the profile installed — its own `disabled` flags only affect rows it declares — so
    // "this mode has no memory" is decided here, by reading the preset id the session records.
    // Everything a session could notice is checked: the two prompt contributions, the recording
    // path, and the tools.
    const offDir = mkdtempSync(join(tmpdir(), 'expmem-off-'))
    const offPath = join(offDir, 'memory.db')
    const offQuote = '这条内容足够长，可以被注入也可以被查出来'
    const off = new Context()
    try {
      await off.plugin(SystemPrompt, {})
      await off.plugin(ToolRuntime, {})
      await off.plugin(Commands, {})
      await off.plugin(experienceMemory, { enabled: true, dbPath: offPath, disabledPresets: ['model-test'] })

      const presetAgent = (preset: string | undefined, switched?: string): Agent => {
        // The digest is query-gated, so "empty in the listed mode" only means anything if the
        // same session shape gets a non-empty digest in a normal mode. The user message is both
        // the evidence that confirms the record and the query that pulls it back.
        const events: unknown[] = [userMessage(offQuote)]
        if (switched !== undefined) events.push({ type: 'agent-preset/selected', data: { agentPreset: switched } })
        return {
          id: 'session-off',
          session: {
            header: preset === undefined ? { cwd: offDir } : { cwd: offDir, agentPreset: preset },
            snapshotEvents: () => events,
          },
        }
      }
      // Something worth injecting, so "empty digest" means the mode is off and not the store.
      await off.tools.get('memory_remember')!.execute(
        { kind: 'fact', title: '这条本来会被注入', body: `${offQuote}，所以它够长、也够可信`, quote: offQuote },
        { signal: new AbortController().signal, agent: presetAgent('standard') },
      )

      const assembled = async (agent: Agent): Promise<string> =>
        (await off.systemPrompt.assemble({ agent })).contexts
          .map(context => context.text ?? '').join('\n')

      const normal = await assembled(presetAgent('standard'))
      const disabledPreset = await assembled(presetAgent('model-test'))
      assert(normal.includes('这条本来会被注入'), 'a normal mode still gets its memory')
      assert(!disabledPreset.includes('这条本来会被注入'),
        'and a listed mode gets no digest at all')
      assert(!disabledPreset.includes('memory_recall'),
        'nor the standing instruction that tells it recording exists — a test mode should not be told')
      eq(disabledPreset.trim(), '', 'the two prompt contributions are both empty, so nothing is left')
      // A session that STARTED in a normal mode and switched into the listed one: the header
      // alone would say "has memory" and the mode would leak. The events decide.
      assert(!(await assembled(presetAgent('standard', 'model-test'))).includes('这条本来会被注入'),
        'a session that switched into the listed mode is treated as the mode it is in')

      // The tools refuse instead of answering. The preset's own filter hides them from the
      // catalogue, so this is the second line of defence — and it is the one that matters if
      // the filter is ever missing.
      let refused: string | undefined
      try {
        await off.tools.get('memory_recall')!.execute(
          { query: '随便问点什么' },
          { signal: new AbortController().signal, agent: presetAgent('model-test') },
        )
      } catch (error) {
        refused = error instanceof Error ? error.message : String(error)
      }
      assert(refused !== undefined && refused.includes('disabledPresets'),
        `a tool call in a listed mode is refused with the reason: ${refused}`)
      assert(refused !== undefined && refused.includes('Remove the preset id'),
        'and the message carries the remedy, not just the refusal')

      // Recording is off too: a turn that would normally file a harvested candidate files none.
      const countRecords = (): number => {
        const side = openDb(offPath)
        try {
          return (side.prepare('SELECT count(*) AS n FROM record').get() as { n: number }).n
        } finally {
          side.close()
        }
      }
      const before = countRecords()
      // A user correction is the one detector the calibration kept on by default, so a turn like
      // this files a candidate in any normal mode.
      await agentEvents(off, {
        id: 'session-off',
        session: {
          header: { cwd: offDir, agentPreset: 'model-test' },
          snapshotEvents: () => [
            { type: 'turn/start', data: { turn: 1 } },
            userMessage('不是实现的问题，是我预期错了'),
          ],
        },
      }).serial('agent/turn-stopping', { turn: 1, signal: new AbortController().signal })
      eq(countRecords(), before, 'a turn in a listed mode writes nothing to the store')
    } finally {
      await off.fiber.dispose()
      rmSync(offDir, { recursive: true, force: true })
    }

    // ── The plugin releases its database on unmount ────────────────────────
    await ctx.fiber.dispose()
    stopped = true
    const reopened: DatabaseSync = (await import('../src/db.ts')).openDb(dbPath)
    reopened.close()
  } finally {
    if (!stopped) await ctx.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  }

  console.log('  plugin     ok')
}
