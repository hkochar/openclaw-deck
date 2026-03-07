/**
 * Security utilities.
 *
 * Extracted from agent-docs/route.ts for testability.
 */

/** Redact API keys, tokens, and credentials from content. */
export function stripSecrets(content: string): string {
  return content
    .replace(/sk-[a-zA-Z0-9_-]{20,}/g, "[REDACTED]")       // Anthropic / OpenRouter keys
    .replace(/sk_[a-zA-Z0-9]{20,}/g, "[REDACTED]")          // OpenAI keys
    .replace(/Bot\s+[A-Za-z0-9._-]{50,}/g, "Bot [REDACTED]") // Discord bot tokens
    .replace(/Bearer\s+[a-zA-Z0-9._-]{20,}/gi, "Bearer [REDACTED]") // Bearer tokens
    .replace(/xoxb-[a-zA-Z0-9-]+/g, "[REDACTED]")           // Slack bot tokens
    .replace(/xoxp-[a-zA-Z0-9-]+/g, "[REDACTED]")           // Slack user tokens
    .replace(/ghp_[a-zA-Z0-9]{36,}/g, "[REDACTED]")         // GitHub PATs
    .replace(/ghu_[a-zA-Z0-9]{36,}/g, "[REDACTED]");        // GitHub user tokens
}

/** Sanitize an error for client-facing responses (strip secrets + truncate). */
export function safeErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return stripSecrets(msg).slice(0, 500);
}
