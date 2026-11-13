import type { TokenUsage } from './types'
import type { KeyValueStore } from './keystore'

/** US dollars per million tokens. Output includes thinking tokens. */
export interface Price {
  inputPerMillion: number
  outputPerMillion: number
  /** 'table' prices are from the provider's pricing page on `checked`; 'user' prices were entered in Settings. */
  source: 'table' | 'user'
  checked: string | null
}

// Paid-tier standard prices from Google's pricing page (aistudio.google.com/docs/pricing),
// checked 2026-11-13. Free-tier use costs nothing; these show what the same work would cost on
// the paid tier. Models not listed have no known price, so only call and token caps apply to them.
const PRICE_TABLE_CHECKED = '2026-11-13'
const PRICE_TABLE: Record<string, { input: number; output: number }> = {
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.5 }
}

const priceSettingKey = (modelId: string): string => `provider.gemini.price.${modelId}`

/** The user's price for a model if they entered one, otherwise the table's, otherwise null. */
export function priceOf(modelId: string, settings: KeyValueStore): Price | null {
  const saved = settings.get(priceSettingKey(modelId))
  if (saved) {
    try {
      const value = JSON.parse(saved) as { input?: unknown; output?: unknown }
      if (typeof value.input === 'number' && typeof value.output === 'number') {
        return { inputPerMillion: value.input, outputPerMillion: value.output, source: 'user', checked: null }
      }
    } catch {
      // A damaged setting is ignored; the table price (or none) applies.
    }
  }
  const row = PRICE_TABLE[modelId]
  return row ? { inputPerMillion: row.input, outputPerMillion: row.output, source: 'table', checked: PRICE_TABLE_CHECKED } : null
}

/** Saves the user's price for a model, or removes it (back to the table) when `price` is null. */
export function setUserPrice(modelId: string, price: { input: number; output: number } | null, settings: KeyValueStore): void {
  if (price === null) settings.delete(priceSettingKey(modelId))
  else settings.set(priceSettingKey(modelId), JSON.stringify(price))
}

export function costUsd(price: Price, usage: Pick<TokenUsage, 'inputTokens' | 'outputTokens'>): number {
  return (usage.inputTokens * price.inputPerMillion + usage.outputTokens * price.outputPerMillion) / 1_000_000
}
