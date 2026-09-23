/**
 * Effect: did this record change what happened?
 *
 * `docs/GROWTH.md` §三 says the controlled deletion test is the ground the other four questions
 * stand on, and G5 turns it into a retention rule: keep the distinctions that change decisions,
 * forget the ones that do not. This module is the vocabulary for that one number.
 *
 * **The number.** Run the same task twice, with and without one record, and subtract:
 *
 *   effect = (pass rate with the record) - (pass rate without it)
 *
 *   `+1`  necessary — without it the task fails, with it the task passes
 *     `0`  redundant — deleting it changed nothing measurable
 *   `<0`  harmful   — having it in the store made the outcome worse
 *
 * **What it deliberately is not.** It is not a semantic judgement about whether the record *should*
 * have applied. That is the judgement this project already failed at twice (`GROWTH.md` §二 wall 2:
 * word co-occurrence scored irrelevant records as relevant). Asking "did removing it change the
 * result" is answerable by experiment and needs no model of relevance at all.
 *
 * **The trap this module exists to avoid.** A scenario where both arms pass (a ceiling) and one
 * where both fail (a floor) produce `effect = 0` by the arithmetic above — and a store that wrote
 * those zeros down would be recording "measured as redundant" for a measurement that was incapable
 * of detecting anything. That is how the first T2 round produced 60 cells and one usable scenario.
 * So a measurement carries whether it *could* have detected a difference, and
 * {@link measurable} is the only thing that may authorise writing an effect into a record.
 *
 * **The switches.** Both consumers ship disabled (weight `0`, retention `false`), because the
 * acceptance criterion for turning them on is an experiment that has to be run and could fail:
 * `GROWTH.md` G5 wants "same byte budget, decision-loss retention beats reuse-count retention by
 * ≥5 points of task accuracy". A mechanism that changes ranking without that evidence would be
 * exactly the "growth" this project keeps measuring as absent. `configureEffect` is called once, by
 * the plugin, from resolved config; tests call it explicitly and restore it.
 */

/** Runs per arm below which a measurement is not taken seriously. Matches the T2 design. */
export const MIN_EFFECT_RUNS = 3

/** One arm of a deletion test: how many runs, and how many passed. */
export interface EffectRun {
  pass: number
  ran: number
}

/** A deletion test's reading, plus whether it was capable of reading anything. */
export interface EffectMeasurement {
  /** `with - without`, in `[-1, 1]`. */
  effect: number
  /** Pass rate of the arm that had the record. */
  withRate: number
  /** Pass rate of the arm that did not. */
  withoutRate: number
  /** Runs per arm actually completed. */
  runs: number
  /**
   * True when the measurement could not have distinguished anything: either arm was unanimous
   * *against* the task (both `0/n` — a floor) or the arm without the record already passed
   * everything (`withoutRate === 1` — a ceiling). Neither says the record is redundant.
   */
  degenerate: boolean
  /** Why it is degenerate, for the reader. Empty when it is not. */
  degenerateWhy: string
}

/**
 * Read one deletion test.
 *
 * `without` is the arm with no record; `withRecord` is the arm with it. Named arguments rather than
 * positional because swapping two same-shaped objects silently inverts every conclusion.
 */
export function measureEffect(arms: { without: EffectRun; withRecord: EffectRun }): EffectMeasurement {
  const rate = (run: EffectRun): number => (run.ran <= 0 ? 0 : run.pass / run.ran)
  const withoutRate = rate(arms.without)
  const withRate = rate(arms.withRecord)
  const runs = Math.min(arms.without.ran, arms.withRecord.ran)
  const reasons: string[] = []
  if (arms.withRecord.ran <= 0 || arms.without.ran <= 0) reasons.push('有一侧一次都没跑完')
  // A floor is **both** arms failing: the task could not be done with or without the record, so the
  // record was never given a chance to matter. `without = 0/n` on its own is the opposite — that is
  // the strongest reading the experiment can produce (`+1`), and mistaking it for a floor would
  // throw away the one result worth having. (The first version of this function did exactly that;
  // the effect suite caught it.)
  if (arms.without.ran > 0 && arms.without.pass === 0 && arms.withRecord.pass === 0) reasons.push('两侧全失败（地板）')
  if (arms.without.ran > 0 && arms.without.pass === arms.without.ran) reasons.push('不给记录的那一侧全通过（天花板）')
  return {
    effect: withRate - withoutRate,
    withRate,
    withoutRate,
    runs,
    degenerate: reasons.length > 0,
    degenerateWhy: reasons.join('；'),
  }
}

/**
 * May this measurement be written into a record as its effect?
 *
 * Three ways to fail, and all three are "the experiment did not answer the question" rather than
 * "the answer was zero": too few runs, a floor, or a ceiling.
 */
export function measurable(measurement: EffectMeasurement): boolean {
  return !measurement.degenerate && measurement.runs >= MIN_EFFECT_RUNS
}

/** Human-readable reading of one measurement. Used by tools and by `memory_recall`'s explanation. */
export function describeEffect(measurement: EffectMeasurement): string {
  const pct = (n: number): string => `${Math.round(n * 100)}%`
  const sign = measurement.effect > 0 ? '+' : ''
  const head = `删除测试 ${sign}${measurement.effect.toFixed(2)}（有记录 ${pct(measurement.withRate)} vs 无记录 ${pct(measurement.withoutRate)}，${measurement.runs} 次/臂）`
  if (!measurable(measurement)) return `${head} —— 这次测量分辨不出差别(${measurement.degenerateWhy || '次数不够'})，不能当作"这条没用"`
  return head
}

// ── The two switches ────────────────────────────────────────────────────────

/** Ranking weight on a measured effect. `0` means the effect does not move importance at all. */
let weight = 0
/** Whether a measured-as-redundant record may be retired for that reason alone. */
let retention = false

/**
 * Point the effect vocabulary at the resolved configuration. Called once by the plugin at apply
 * time; a test that changes it must put it back.
 */
export function configureEffect(options: { weight?: number; decisionLossRetirement?: boolean }): void {
  if (options.weight !== undefined) weight = Number.isFinite(options.weight) ? options.weight : 0
  if (options.decisionLossRetirement !== undefined) retention = options.decisionLossRetirement === true
}

/** Current ranking weight (read by `rank.ts`). */
export function effectWeight(): number {
  return weight
}

/** Whether decision-loss retirement is on (read by `lifecycle.ts`). */
export function decisionLossRetirement(): boolean {
  return retention
}

/** Sub-floor effects are counted as "no effect": measurement noise, not a decision difference. */
export const EFFECT_FLOOR = 0.01

/**
 * Why this record should leave the pool because measuring it said it changes nothing, or
 * `undefined`.
 *
 * **Only a measured record can be retired this way.** `effect === null` means nobody measured it,
 * which is not evidence of redundancy — treating "unmeasured" as "useless" would delete the whole
 * store the day this ships. The measurement must also have been capable of detecting a difference
 * ({@link measurable} was applied at write time, and the floor is re-checked here), and a record
 * that has actually been reused keeps its place: real use outranks an experiment on one task.
 */
export function decisionLossReason(
  record: { effect: number | null; reuseCount: number; successCount: number },
): string | undefined {
  if (!retention) return undefined
  if (record.effect === null || !Number.isFinite(record.effect)) return undefined
  if (record.effect > EFFECT_FLOOR) return undefined
  if (record.reuseCount > 0 || record.successCount > 0) return undefined
  return 'deletion test: no measurable effect on the outcome'
}
