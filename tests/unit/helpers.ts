import { join } from 'node:path'

/** Absolute path of a file in tests/fixtures. */
export function fixture(name: string): string {
  return join(import.meta.dirname, '..', 'fixtures', name)
}
