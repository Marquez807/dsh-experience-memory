/**
 * Plugin integration: mount the real services, load the plugin, and drive every
 * tool through its own registration.
 *
 * A bundle passing `--dump-config` only proves the configuration composes. This
 * suite mounts SystemPrompt and ToolRuntime — the two services the plugin
 * injects — and then exercises the whole loop: record, recall, link an outcome,
 * retire.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as experienceMemory from '../src/index.ts'
import { recentQueryText } from '../src/index.ts'
import { assert, eq } from './assert.ts'
import type { DatabaseSync } from 'node:sqlite'

const TOOLS = ['memory_recall', 'memory_remember', 'memory_feedback', 'memory_forget'] as const

interface Agent {
  id?: string
  session: { header: { cwd: string }; events: readonly unknown[] }
}

const userMessage = (text: string, kind = 'user') => ({
  type: 'user/message',
  data: { source: { kind }, content: [{ type: 'text', text }] },
})

export async function run(): Promise<void> {
  // ── Query derivation is pure, so test it without a Context ───────────────
  eq(recentQueryText(undefined), '', 'no agent yields no query')
  eq(recentQueryText({}), '', 'an agent without a session yields no query')
  const m = (text: string, kind?: string) => ({
    type: 'user/message',
    data: { source: { kind: kind ?? 'user' }, content: [{ type: 'text', text }] },
  })
  eq(recentQueryText({ session: { events: [m('第一句'), m('第二句')] } }),
    '第一句\n第二句', 'the last user messages become the query')
  eq(recentQueryText({ session: { events: [m('旧'), m('新'), m('我注入的', 'plugin')] } }),
    '旧\n新', 'a plugin-sourced message is never read back as the query')
  eq(recentQueryText({ session: { events: [m('   ')] } }), '', 'a blank message contributes nothing')

  const dir = mkdtempSync(join(tmpdir(), 'expmem-plugin-'))
  const dbPath = join(dir, 'memory.db')
  const ctx = new Context()
  let stopped = false
  try {
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(experienceMemory, { enabled: true, dbPath })

    // ── Every tool is registered and visible to the registry ──────────────
    const schemas = ctx.tools.schemas().map(schema => schema.name)
    for (const tool of TOOLS) {
      assert(ctx.tools.get(tool) !== undefined, `${tool} is registered`)
      assert(schemas.includes(tool), `${tool} has a visible schema`)
    }

    /** Run one tool exactly as the pipeline would, with an optional agent. */
    const call = async <T>(name: string, args: unknown, agent?: Agent): Promise<T> => {
      const definition = ctx.tools.get(name)
      assert(definition !== undefined, `${name} exists`)
      return await definition!.execute(args, {
        signal: new AbortController().signal,
        agent,
      }) as T
    }

    const agentFor = (events: readonly unknown[]): Agent => ({ id: 'session-1', session: { header: { cwd: dir }, events } })

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

    // ── An unverifiable claim stays a candidate and is not recalled ────────
    const weak = await call<{ outcome: string; id: string; status: string; evidence: string }>(
      'memory_remember',
      { kind: 'experience', title: '部署目标盘', body: '部署一律写到 F 盘' },
      agentFor([]),
    )
    eq(weak.evidence, 'inferred', 'a claim with no passage is graded as an inference')
    eq(weak.status, 'candidate', 'and stays a candidate')
    const weakRecall = await call<{ returned: number }>('memory_recall', { query: '部署' }, agentFor([]))
    eq(weakRecall.returned, 0, 'a candidate is not recalled, because only confirmed records are')

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
        { id: 'core-session', session: { header: { cwd: root }, events: [userMessage(sharedQuote)] } },
      )

    const firstCopy = await rememberIn(domainRoots[0]!, '回滚前先备份')
    eq(firstCopy.outcome, 'created', 'the first workspace keeps the lesson local to itself')
    // A different title on the same body still corroborates, because identity is
    // the assertion rather than its label.
    const secondCopy = await rememberIn(domainRoots[1]!, '回滚前先导出副本')
    eq(secondCopy.outcome, 'promoted', 'the second workspace promotes it to the domain')

    const digestFor = async (root: string, text: string): Promise<string> => {
      const assembly = await ctx.systemPrompt.assemble({
        agent: { id: 'core-session', session: { header: { cwd: root }, events: [userMessage(text)] } },
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
      { id: 'core-session', session: { header: { cwd: domainRoots[0]! }, events: [] } },
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
