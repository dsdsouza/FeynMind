/** Replaces every occurrence of each secret in `text`, so a key can never leak through an error. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret.length > 0) out = out.split(secret).join('[redacted]')
  }
  return out
}

/** Turns any thrown value into a short, user-safe message with secrets removed. */
export function toUserMessage(error: unknown, secrets: readonly string[]): string {
  const raw = error instanceof Error ? error.message : 'Unknown error'
  // Keep messages short: some SDK errors embed whole response bodies.
  const trimmed = raw.length > 300 ? `${raw.slice(0, 300)}…` : raw
  return redact(trimmed, secrets)
}

/** Maps an HTTP status from a provider to a message the user can act on. */
export function describeHttpStatus(status: number, providerMessage: string | undefined): string {
  const detail = providerMessage ? ` (${providerMessage})` : ''
  if (status === 400 || status === 401 || status === 403) {
    return `The provider rejected the API key or request${detail}.`
  }
  if (status === 404) return `The provider could not find that model${detail}.`
  if (status === 429) return `Rate limit reached. Wait a minute and try again${detail}.`
  if (status >= 500) return `The provider had a server error (HTTP ${status}). Try again later.`
  return `The provider returned HTTP ${status}${detail}.`
}
