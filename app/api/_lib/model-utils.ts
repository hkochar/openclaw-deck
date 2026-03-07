/**
 * Model-related utility functions.
 *
 * Extracted from model-swap/route.ts, agent-models/route.ts, and usage/route.ts
 * for testability.
 */

export type SessionEntry = {
  model?: string;
  modelProvider?: string;
  providerOverride?: string;
  modelOverride?: string;
};

/** Parse full model id → { provider, modelId } */
export function parseModel(fullModel: string): { provider: string; modelId: string } {
  const parts = fullModel.split("/");
  return { provider: parts[0], modelId: parts.slice(1).join("/") };
}

/**
 * Resolve the effective model for a session, preferring explicit overrides
 * over the configured primary.
 */
export function resolveSessionModel(entry: SessionEntry | undefined, configuredPrimary: string): string {
  if (!entry) return configuredPrimary;
  const provider = entry.providerOverride?.trim();
  const model = entry.modelOverride?.trim();
  if (provider && model) return `${provider}/${model}`;
  if (model) return model;
  return configuredPrimary;
}

/** Cost in USD per 1M tokens */
const MODEL_COST_PER_1M: Record<string, number> = {
  haiku: 0.25,
  sonnet: 3.0,
  opus: 15.0,
};

/** Models that are free (kimi, nvidia, etc.) */
const FREE_MODEL_PATTERNS = ["kimi", "nvidia"];

/** Look up approximate cost per 1M tokens for a model string. */
export function modelCostPer1M(model: string | null): number {
  if (!model) return 0;
  const lower = model.toLowerCase();
  if (FREE_MODEL_PATTERNS.some((p) => lower.includes(p))) return 0;
  for (const [key, cost] of Object.entries(MODEL_COST_PER_1M)) {
    if (lower.includes(key)) return cost;
  }
  return 0;
}
