import { join } from 'node:path'

/** Absolute path of a file in tests/fixtures. */
export function fixture(name: string): string {
  return join(import.meta.dirname, '..', 'fixtures', name)
}

/** Returns the value, failing the test if it is missing. */
export function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`Expected ${what} to be present.`)
  return value
}
