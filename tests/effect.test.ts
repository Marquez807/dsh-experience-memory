/**
 * Deletion effect and the decision-loss rule.
 *
 * `docs/GROWTH.md` §三 makes the controlled deletion test the input to everything else the "growth"
 * route wants to do, so the arithmetic that turns two arm counts into a number has to be pinned
 * here rather than trusted. The cases below all failed in practice at least once, in this project or
 * in the first T2 round:
 *
 *   - a **ceiling** and a **floor** both read as `effect = 0`, and writing those zeros down would
 *     have recorded "measured as redundant" for experiments that could not detect anything;
 *   - `null` ("nobody measured this") and `0` ("measured; removing it changed nothing") are
 *     different facts, and conflating them would let the retirement rule delete a whole store on
 *     the day it shipped;
 *   - the two switches must default to a byte-for-byte unchanged ranking, because the experiment
 *     that would justify turning them on has not passed.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, eq } from './assert.ts'
import {
  configureEffect,
  decisionLossReason,
  describeEffect,
  EFFECT_FLOOR,
  effectWeight,
  measureEffect,
  measurable,
  MIN_EFFECT_RUNS,
} from '../src/effect.ts'
import { importance } from '../src/rank.ts'
import { getRecord, openDb, SCHEMA_VERSION, upsert } from '../src/db.ts'
import type { MemoryRecord } from '../src/types.ts'

const NOW = 1_800_000_000_000

function make(over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'r1',
    workspaceId: 'ws1',
    domain: '',
    scope: 'workspace',
    kind: 'experience',
    status: 'confirmed',
    evidence: 'verified-file',
    title: '标题',
    body: '正文',
    trigger: '',
    failureMode: '',
    lesson: '',
    sourceRef: '',
    reuseCount: 0,
    successCount: 0,
    failureCount: 0,
    failStreak: 0,
    distinctWorkspaces: 1,
    createdAt: NOW,
    occurredAt: NOW,
    updatedAt: NOW,
    lastUsedAt: null,
    reviewAfter: null,
    expiresAt: null,
    contentFingerprint: 'fp-r1',
    supersededBy: null,
    needsReview: null,
    origin: 'model',
    harvestSignal: null,
    effect: null,
    ...over,
  }
}

export function run(): void {
  const dir = mkdtempSync(join(tmpdir(), 'expmem-effect-'))
  try {
    // ── The arithmetic ────────────────────────────────────────────────────────
    const necessary = measureEffect({ without: { pass: 0, ran: 3 }, withRecord: { pass: 3, ran: 3 } })
    eq(necessary.effect, 1, '不给记录 0/3、给记录 3/3 ⇒ 效果 +1（这条记录是必需的）')
    assert(measurable(necessary), '不给记录 0/3、给记录 3/3 ⇒ 这是有判别力的读数，可以写进记录')

    const redundant = measureEffect({ without: { pass: 1, ran: 3 }, withRecord: { pass: 1, ran: 3 } })
    eq(redundant.effect, 0, '两边都 1/3 ⇒ 效果 0')
    assert(measurable(redundant), '两侧都不是地板/天花板（1/3）⇒ 0 是**测出来的 0**，可以写')

    const harmful = measureEffect({ without: { pass: 2, ran: 3 }, withRecord: { pass: 0, ran: 3 } })
    // 想拿到 -1 就需要"不给记录 3/3"，而那按定义是天花板（测量作废）——所以**有判别力**的读数里，
    // 负效果的极限是 -(n-1)/n。这条断言把这件事钉住，免得以后有人以为负值只能取整数。
    eq(harmful.effect, -2 / 3, '给了记录反而更差 ⇒ 效果是负的')

    // ── The two "no signal" shapes must not be written down as zeros ──────────
    const floor = measureEffect({ without: { pass: 0, ran: 3 }, withRecord: { pass: 0, ran: 3 } })
    eq(floor.effect, 0, '地板：算术上也是 0')
    assert(!measurable(floor), '地板**不许**当"测出来没用"——它是一次分辨不出差别的测量')
    assert(floor.degenerateWhy.includes('地板'), `地板的理由要写清楚，实际是：${floor.degenerateWhy}`)

    // 同样是两侧 0/3，但**任务做出来了**（taskDone，判据要求的行为只是没出现）：这是测出来的 0，
    // 不是分辨不出——T2 的 wipeguard 就是这一格（每个臂都把库清对了，只有"加护栏"没人做，
    // 记录就在库里也没用）。把它当"地板"丢掉，等于丢掉"经验能不能拦住错误"最直接的反面证据。
    const measuredZero = measureEffect({
      without: { pass: 0, ran: 3, taskDone: true },
      withRecord: { pass: 0, ran: 3, taskDone: true },
    })
    eq(measuredZero.effect, 0, '两侧 0 但任务做完了 ⇒ 效果仍是 0')
    assert(measurable(measuredZero), '任务做出来的 0 是**可写**的实测值，不算地板')
    assert(!measuredZero.degenerate && floor.degenerate, '同为 0/3，只有"任务做出来了"才翻转判读')
    assert(!describeEffect(measuredZero).includes('分辨不出'),
      `测出来的 0 的说辞不能是"分辨不出"，实际是：${describeEffect(measuredZero)}`)

    const ceiling = measureEffect({ without: { pass: 3, ran: 3 }, withRecord: { pass: 3, ran: 3 } })
    assert(!measurable(ceiling), '天花板（不给记录也全过）同样不许当"测出来没用"')
    assert(ceiling.degenerateWhy.includes('天花板'), `天花板的理由要写清楚，实际是：${ceiling.degenerateWhy}`)

    const tooFew = measureEffect({ without: { pass: 0, ran: 1 }, withRecord: { pass: 1, ran: 1 } })
    assert(!measurable(tooFew), `次数不够（1 次/臂 < ${String(MIN_EFFECT_RUNS)}）⇒ 不写进记录`)
    assert(!measurable(measureEffect({ without: { pass: 0, ran: 0 }, withRecord: { pass: 0, ran: 0 } })),
      '一次都没跑完 ⇒ 更不许写')

    // 说给人听的话里，不能出现"这条记录没用"这种结论（那次测量根本没这个资格）——
    // 所以读数的措辞必须**主动拒绝**这个读法，而不只是含糊。
    assert(describeEffect(floor).includes('分辨不出'), '地板要说清"这次分辨不出差别"')
    assert(describeEffect(floor).includes('不能当作'),
      `地板的读数必须明说"不能当作那条记录没用"，实际是：${describeEffect(floor)}`)
    assert(describeEffect(necessary).includes('+1.00'), '有判别力的读数要把数字说出来')

    // ── The switches default to "changes nothing" ─────────────────────────────
    configureEffect({ weight: 0, decisionLossRetirement: false })
    eq(effectWeight(), 0, '默认权重是 0')
    const base = {
      evidence: 'verified-file' as const,
      successCount: 0, reuseCount: 0, failStreak: 0, distinctWorkspaces: 1,
      createdAt: NOW, lastUsedAt: null, reviewAfter: null, now: NOW,
    }
    const unmeasuredScore = importance({ ...base, effect: null })
    const necessaryScore = importance({ ...base, effect: 1 })
    const harmfulScore = importance({ ...base, effect: -1 })
    eq(necessaryScore, unmeasuredScore, '权重 0 时，测得必需也不抬高分数（默认行为一字不变）')
    eq(harmfulScore, unmeasuredScore, '权重 0 时，测得有害也不压低分数')
    eq(decisionLossReason(make({ effect: 0 })), undefined, '开关关着时，测过没用也不会因此退役')

    // ── Turning the weight on moves the score in both directions ──────────────
    configureEffect({ weight: 2 })
    assert(importance({ ...base, effect: 1 }) > unmeasuredScore, '权重打开后，正效果把分数抬上去')
    assert(importance({ ...base, effect: -1 }) < unmeasuredScore, '负效果把分数压下去（不能只会加分）')
    eq(importance({ ...base, effect: null }), unmeasuredScore, '没测过的记录不受权重影响（拿 0 补，不是拿 0 罚）')
    configureEffect({ weight: 0 })

    // ── The decision-loss retirement rule ────────────────────────────────────
    configureEffect({ decisionLossRetirement: true })
    assert(decisionLossReason(make({ effect: null })) === undefined,
      '**没测过**不等于没用：effect 为 NULL 的记录不许被这条规则退役')
    assert(decisionLossReason(make({ effect: EFFECT_FLOOR + 0.01 })) === undefined,
      '正效果（哪怕很小）⇒ 不许退役')
    eq(decisionLossReason(make({ effect: 0 })), 'deletion test: no measurable effect on the outcome',
      '测过、效果 0 ⇒ 这条规则给出退役理由')
    assert(decisionLossReason(make({ effect: -1 })) !== undefined, '测出有害的也在这条规则的射程内')
    assert(decisionLossReason(make({ effect: 0, reuseCount: 1 })) === undefined,
      '真被复用过的记录不因一次实验退役（实际使用压过实验）')
    assert(decisionLossReason(make({ effect: 0, successCount: 1 })) === undefined,
      '有过成功复用的同理')
    configureEffect({ decisionLossRetirement: false })
    assert(decisionLossReason(make({ effect: 0 })) === undefined, '开关再关掉 ⇒ 规则立刻失效')
    // 收尾：别把开关留给别的套件（这是模块级状态，测试之间会串）
    configureEffect({ weight: 0, decisionLossRetirement: false })

    // ── The column, and the difference between NULL and 0 ────────────────────
    const path = join(dir, 'legacy.db')
    const first = openDb(path)
    upsert(first, make({ id: 'legacy', contentFingerprint: 'fp-legacy' }))
    // 造一个"升级前"的库：把列删掉、版本号退回 6。库里那条老记录必须是 NULL，
    // 不能变成 0 —— 变成 0 就等于凭空宣称"我测过它、它没用"。
    first.exec('ALTER TABLE record DROP COLUMN effect')
    first.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)').run('schema_version', '6')
    first.exec('PRAGMA user_version = 6')
    first.close()

    const reopened = openDb(path)
    try {
      const columns = (reopened.prepare('PRAGMA table_info(record)').all() as { name: string }[]).map(c => c.name)
      assert(columns.includes('effect'), '老库升级后会补上 effect 列')
      eq(getRecord(reopened, 'legacy')?.effect, null, '升级前的记录读出来是 NULL（没人测过），不是 0')
      eq((reopened.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, SCHEMA_VERSION,
        '升级后版本号跟 SCHEMA_VERSION 一致（不是硬写的数字）')

      const row = getRecord(reopened, 'legacy')
      assert(row !== undefined, '老记录还在')
      upsert(reopened, { ...row, effect: 1 })
      eq(getRecord(reopened, 'legacy')?.effect, 1, '实测效果能写进库、能读回来')
      upsert(reopened, { ...row, effect: 0 })
      eq(getRecord(reopened, 'legacy')?.effect, 0, 'effect = 0（测过、没影响）与 NULL（没测过）必须是两个不同的值')
      upsert(reopened, { ...row, effect: -0.5 })
      eq(getRecord(reopened, 'legacy')?.effect, -0.5, '负效果存得下（REAL 列，不是只有 0/1）')
    } finally {
      reopened.close()
    }
  } finally {
    configureEffect({ weight: 0, decisionLossRetirement: false })
    rmSync(dir, { recursive: true, force: true })
  }
}
