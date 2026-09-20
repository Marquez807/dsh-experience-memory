/** Minimal assertions. No test framework: the plugin must install without a build step. */

/**
 * How many assertions this run has executed.
 *
 * The README quotes a total, and a quoted total is a number that goes stale: it said
 * "470+" while the suite had grown well past it, and a receipt quoted 27 checks for a
 * probe that printed 26. Counting here means the number is reported, not remembered.
 */
let checks = 0

/** Assertions executed so far in this process. */
export function assertions(): number {
  return checks
}

export function assert(condition: unknown, message: string): void {
  checks += 1
  if (!condition) throw new Error(`FAIL  ${message}`)
}

export function eq(actual: unknown, expected: unknown, message: string): void {
  checks += 1
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`FAIL  ${message}\n        expected ${e}\n        actual   ${a}`)
}

export function hasAll(actual: readonly string[], expected: readonly string[], message: string): void {
  checks += 1
  for (const item of expected) {
    if (!actual.includes(item)) {
      throw new Error(`FAIL  ${message}\n        missing ${JSON.stringify(item)}\n        in ${JSON.stringify(actual)}`)
    }
  }
}

export function lacks(actual: readonly string[], forbidden: readonly string[], message: string): void {
  checks += 1
  for (const item of forbidden) {
    if (actual.includes(item)) {
      throw new Error(`FAIL  ${message}\n        unexpected ${JSON.stringify(item)}\n        in ${JSON.stringify(actual)}`)
    }
  }
}
