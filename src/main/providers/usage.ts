import type Database from 'better-sqlite3'
import type { TokenUsage } from './types'

// The model cache and the ledger of every request. Both live in the app database (migration 3).

export type CallOutcome = 'ok' | 'cache-hit' | 'invalid' | 'rate-limited' | 'quota' | 'error'

export interface CallRecord {
  sessionId: number | null
  jobId: number | null
  prompt: string
  model: string
  cacheKey: string | null
  outcome: CallOutcome
  usage: TokenUsage | null
  estimate: { inputTokens: number; outputTokens: number } | null
}

export interface UsageTotals {
  /** Billed requests: ones that returned a reply, valid or not. */
  calls: number
  /** Every request sent, including ones refused for limits or failed. */
  requests: number
  cacheHits: number
  inputTokens: number
  outputTokens: number
  thinkingTokens: number
  /** Tokens per model, so cost can be priced per model. */
  byModel: { model: string; inputTokens: number; outputTokens: number }[]
}

/** Ratios of actual to estimated tokens, from recent calls of one prompt on one model. */
export interface Calibration {
  inputFactor: number
  outputFactor: number
  samples: number
}

/** Outcomes that reached the model and were billed. */
const BILLED = "('ok', 'invalid')"
const CALIBRATION_WINDOW = 50

export class UsageStore {
  constructor(private readonly db: Database.Database) {}

  cacheGet(key: string): string | undefined {
    return this.db.prepare<[string], { response: string }>('SELECT response FROM model_cache WHERE key = ?').get(key)?.response
  }

  cachePut(entry: { key: string; prompt: string; promptVersion: number; model: string; response: string; usage: TokenUsage }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO model_cache (key, prompt, prompt_version, model, response, input_tokens, output_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(entry.key, entry.prompt, entry.promptVersion, entry.model, entry.response, entry.usage.inputTokens, entry.usage.outputTokens)
  }

  record(call: CallRecord): void {
    this.db
      .prepare(
        `INSERT INTO model_calls (session_id, job_id, prompt, model, cache_key, outcome, input_tokens, output_tokens,
           thinking_tokens, est_input_tokens, est_output_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        call.sessionId,
        call.jobId,
        call.prompt,
        call.model,
        call.cacheKey,
        call.outcome,
        call.usage?.inputTokens ?? 0,
        call.usage?.outputTokens ?? 0,
        call.usage?.thinkingTokens ?? 0,
        call.estimate?.inputTokens ?? null,
        call.estimate?.outputTokens ?? null
      )
  }

  sessionTotals(sessionId: number): UsageTotals {
    return this.totals('session_id = ?', sessionId)
  }

  jobTotals(jobId: number): UsageTotals {
    return this.totals('job_id = ?', jobId)
  }

  private totals(where: string, id: number): UsageTotals {
    const row = this.db
      .prepare<[number], { calls: number; requests: number; cacheHits: number; inputTokens: number; outputTokens: number; thinkingTokens: number }>(
        `SELECT count(*) FILTER (WHERE outcome IN ${BILLED}) AS calls,
           count(*) FILTER (WHERE outcome != 'cache-hit') AS requests,
           count(*) FILTER (WHERE outcome = 'cache-hit') AS cacheHits,
           coalesce(sum(input_tokens), 0) AS inputTokens, coalesce(sum(output_tokens), 0) AS outputTokens,
           coalesce(sum(thinking_tokens), 0) AS thinkingTokens
         FROM model_calls WHERE ${where}`
      )
      .get(id)
    const byModel = this.db
      .prepare<[number], { model: string; inputTokens: number; outputTokens: number }>(
        `SELECT model, sum(input_tokens) AS inputTokens, sum(output_tokens) AS outputTokens
         FROM model_calls WHERE ${where} AND (input_tokens > 0 OR output_tokens > 0) GROUP BY model ORDER BY model`
      )
      .all(id)
    return {
      calls: row?.calls ?? 0,
      requests: row?.requests ?? 0,
      cacheHits: row?.cacheHits ?? 0,
      inputTokens: row?.inputTokens ?? 0,
      outputTokens: row?.outputTokens ?? 0,
      thinkingTokens: row?.thinkingTokens ?? 0,
      byModel
    }
  }

  /**
   * How far off recent estimates were for this prompt and model, as factors to multiply new
   * estimates by. 1 when there is no history. Only successful calls with an estimate count.
   */
  calibration(prompt: string, model: string): Calibration {
    const row = this.db
      .prepare<[string, string, number], { samples: number; input: number | null; output: number | null; estInput: number | null; estOutput: number | null }>(
        `SELECT count(*) AS samples, sum(input_tokens) AS input, sum(output_tokens) AS output,
           sum(est_input_tokens) AS estInput, sum(est_output_tokens) AS estOutput
         FROM (SELECT * FROM model_calls WHERE prompt = ? AND model = ? AND outcome = 'ok' AND est_input_tokens > 0 AND est_output_tokens > 0
               ORDER BY id DESC LIMIT ?)`
      )
      .get(prompt, model, CALIBRATION_WINDOW)
    if (!row || row.samples === 0 || !row.estInput || !row.estOutput) return { inputFactor: 1, outputFactor: 1, samples: 0 }
    return { inputFactor: (row.input ?? 0) / row.estInput, outputFactor: (row.output ?? 0) / row.estOutput, samples: row.samples }
  }
}
