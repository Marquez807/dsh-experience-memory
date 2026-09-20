/** Minimal assertions. No test framework: the plugin must install without a build step. */

export function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`FAIL  ${message}`)
}

export function eq(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`FAIL  ${message}\n        expected ${e}\n        actual   ${a}`)
}

export function hasAll(actual: readonly string[], expected: readonly string[], message: string): void {
  for (const item of expected) {
    if (!actual.includes(item)) {
      throw new Error(`FAIL  ${message}\n        missing ${JSON.stringify(item)}\n        in ${JSON.stringify(actual)}`)
    }
  }
}

export function lacks(actual: readonly string[], forbidden: readonly string[], message: string): void {
  for (const item of forbidden) {
    if (actual.includes(item)) {
      throw new Error(`FAIL  ${message}\n        unexpected ${JSON.stringify(item)}\n        in ${JSON.stringify(actual)}`)
    }
  }
}
