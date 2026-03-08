import fs from "fs";
import path from "path";
import os from "os";
import { getLogger } from "../logger";
import { getDb } from "./db-core";

// ── Billing mode resolution ──────────────────────────────────────

/**
 * Provider → billing mode lookup from openclaw.json auth profiles.
 * OAuth and token modes are subscription (no per-request cost).
 * API key mode is metered (pay per token).
 */
let billingMap: Record<string, "metered" | "subscription"> = {};
let billingMapLoaded = false;

export function loadBillingMap(): void {
  try {
    const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const profiles = config?.auth?.profiles ?? {};
    const newMap: Record<string, "metered" | "subscription"> = {};
    for (const profile of Object.values(profiles) as Array<{ provider?: string; mode?: string }>) {
      if (!profile.provider) continue;
      const mode = profile.mode === "api_key" ? "metered" as const : "subscription" as const;
      // If any profile for this provider is metered, mark as metered (conservative)
      if (!newMap[profile.provider] || mode === "metered") {
        newMap[profile.provider] = mode;
      }
    }
    billingMap = newMap;
    billingMapLoaded = true;
  } catch {
    // Can't read config — leave map empty, billing will be null
  }
}

/** Resolve billing mode for a provider. Returns undefined if unknown. */
export function getBillingMode(provider: string): "metered" | "subscription" | undefined {
  if (!billingMapLoaded) loadBillingMap();
  return billingMap[provider];
}

/** Reload billing map (called on config change). */
export function reloadBillingMap(): void {
  billingMapLoaded = false;
}

// ── Cost estimation ──────────────────────────────────────────────

export interface ModelPricing {
  input: number;   // $/1M tokens
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Default pricing ($/1M tokens). Used when no config pricing table is set. */
const DEFAULT_PRICING: Record<string, ModelPricing> = {
  opus:     { input: 15,    output: 75,    cacheRead: 1.5,   cacheWrite: 18.75 },
  sonnet:   { input: 3,     output: 15,    cacheRead: 0.3,   cacheWrite: 3.75 },
  haiku:    { input: 0.25,  output: 1.25,  cacheRead: 0.025, cacheWrite: 0.3125 },
  "gpt-4o": { input: 2.5,   output: 10,    cacheRead: 1.25,  cacheWrite: 0 },
  "gpt-4":  { input: 30,    output: 60,    cacheRead: 0,     cacheWrite: 0 },
  deepseek: { input: 0.27,  output: 1.10,  cacheRead: 0.07,  cacheWrite: 0 },
  "gemini":  { input: 0.15,  output: 0.60,  cacheRead: 0.04,  cacheWrite: 0 },
  "llama":   { input: 0.20,  output: 0.80,  cacheRead: 0,     cacheWrite: 0 },
  "qwen":    { input: 0.15,  output: 0.60,  cacheRead: 0,     cacheWrite: 0 },
  "nemotron": { input: 0.20, output: 0.80,  cacheRead: 0,     cacheWrite: 0 },
};

/** Fallback pricing for unknown models (conservative mid-range estimate). */
const FALLBACK_PRICING: ModelPricing = { input: 1.0, output: 4.0, cacheRead: 0.25, cacheWrite: 0 };

/** OpenRouter auto/free route to cheap models — use low estimate, provider_cost will correct later. */
const OPENROUTER_AUTO_PRICING: ModelPricing = { input: 0.10, output: 0.40, cacheRead: 0.025, cacheWrite: 0 };

/** Active pricing table — updated via setPricingTable(). */
let activePricing: Record<string, ModelPricing> = { ...DEFAULT_PRICING };

/** Learned pricing from historical provider_cost data — overrides defaults. */
let learnedPricing: Record<string, ModelPricing> = {};

/** Replace the pricing table (called when Deck config is loaded/reloaded). */
export function setPricingTable(pricing: Record<string, ModelPricing>): void {
  activePricing = { ...pricing };
}

/** Get the current pricing table. */
export function getPricingTable(): Record<string, ModelPricing> {
  return activePricing;
}

// ── Pricing recalc hook ──────────────────────────────────────────
// Called after recalcLearnedModelCosts to let consumers (e.g. cost module)
// invalidate their caches.
let onPricingRecalc: (() => void) | null = null;

/** Register a callback to be called after pricing recalculation. */
export function setOnPricingRecalc(fn: () => void): void {
  onPricingRecalc = fn;
}

/**
 * Learn per-model pricing from historical events that have provider_cost.
 * Computes effective output rate from events where output tokens dominate cost.
 * Runs on startup and periodically (e.g. daily) to calibrate estimates.
 */
export function learnPricingFromHistory(): void {
  try {
    const db = getDb();
    // Get models with enough reconciled events (provider_cost > 0, tokens > 0)
    const rows = db.prepare(`
      SELECT model,
        SUM(provider_cost) as total_cost,
        SUM(COALESCE(input_tokens,0)) as total_input,
        SUM(COALESCE(output_tokens,0)) as total_output,
        SUM(COALESCE(cache_read,0)) as total_cache_read,
        SUM(COALESCE(cache_write,0)) as total_cache_write,
        COUNT(*) as n
      FROM events
      WHERE type = 'llm_output'
        AND provider_cost > 0
        AND (COALESCE(input_tokens,0) + COALESCE(output_tokens,0)) > 0
      GROUP BY model
      HAVING COUNT(*) >= 5
    `).all() as Array<{
      model: string; total_cost: number;
      total_input: number; total_output: number; total_cache_read: number;
      total_cache_write: number; n: number;
    }>;

    const newLearned: Record<string, ModelPricing> = {};
    for (const r of rows) {
      // Estimate: assume output is 5x input rate (industry standard ratio)
      // total_cost ≈ input * inputRate + output * outputRate + cacheRead * cacheRate + cacheWrite * cacheWriteRate
      // With outputRate = 5 * inputRate, cacheRate = 0.1 * inputRate, cacheWriteRate = 1.25 * inputRate:
      // total_cost ≈ inputRate * (input + 5*output + 0.1*cacheRead + 1.25*cacheWrite)
      const effectiveTokens = r.total_input + 5 * r.total_output + 0.1 * r.total_cache_read + 1.25 * r.total_cache_write;
      if (effectiveTokens <= 0) continue;
      const inputRate = (r.total_cost / effectiveTokens) * 1_000_000; // $/M tokens
      if (inputRate <= 0 || inputRate > 100) continue; // sanity check

      newLearned[r.model] = {
        input: inputRate,
        output: inputRate * 5,
        cacheRead: inputRate * 0.1,
        cacheWrite: inputRate * 1.25,
      };
    }
    learnedPricing = newLearned;
    if (Object.keys(newLearned).length > 0) {
      getLogger().info(`[event-log] Learned pricing for ${Object.keys(newLearned).length} models from ${rows.reduce((s, r) => s + r.n, 0)} reconciled events`);
      // Recalculate all events for learned models so estimates match reality
      recalcLearnedModelCosts(db, newLearned);
    }
  } catch (err) {
    getLogger().warn(`[event-log] Failed to learn pricing from history: ${err}`);
  }
}

/**
 * Recalculate cost estimates for ALL events of learned models.
 * Updates both reconciled and unreconciled events so the `cost` column
 * consistently reflects learned rates. The `provider_cost` column (when present)
 * remains the authoritative real cost; `cost` is always an estimate.
 */
function recalcLearnedModelCosts(db: Database.Database, learned: Record<string, ModelPricing>): void {
  let totalUpdated = 0;
  for (const [model, pricing] of Object.entries(learned)) {
    const rows = db.prepare(`
      SELECT id, COALESCE(input_tokens,0) as inp, COALESCE(output_tokens,0) as out,
             COALESCE(cache_read,0) as cr, COALESCE(cache_write,0) as cw
      FROM events
      WHERE type = 'llm_output' AND model = ?
    `).all(model) as Array<{ id: number; inp: number; out: number; cr: number; cw: number }>;

    if (rows.length === 0) continue;

    const stmt = db.prepare("UPDATE events SET cost = ? WHERE id = ?");
    const txn = db.transaction(() => {
      for (const r of rows) {
        const cost = (r.inp / 1e6) * pricing.input + (r.out / 1e6) * pricing.output +
                     (r.cr / 1e6) * pricing.cacheRead + (r.cw / 1e6) * pricing.cacheWrite;
        // Reject negative or absurd costs (> $100/event) — bad learned pricing
        if (cost < 0 || cost > 100) continue;
        stmt.run(Math.round(cost * 1e6) / 1e6, r.id);
      }
    });
    txn();
    totalUpdated += rows.length;
  }
  if (totalUpdated > 0) {
    getLogger().info(`[event-log] Recalculated ${totalUpdated} events with learned pricing`);
    if (onPricingRecalc) onPricingRecalc();
  }
}

/**
 * Estimate cost in USD for an LLM call.
 * Matches model name against pricing table keys via substring match.
 * Returns 0 for unknown/free models.
 */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheRead: number,
  cacheWrite?: number,
): number {
  const lower = model.toLowerCase();
  let pricing: ModelPricing | undefined;

  // 1. Check learned pricing (exact model match from historical provider_cost data)
  if (learnedPricing[model]) {
    pricing = learnedPricing[model];
  }

  // 2. Substring match against configured/default pricing table
  if (!pricing) {
    const keys = Object.keys(activePricing).sort((a, b) => b.length - a.length);
    for (const key of keys) {
      if (lower.includes(key.toLowerCase())) {
        pricing = activePricing[key];
        break;
      }
    }
  }

  // 3. For openrouter models without a match, use cheap auto/free or mid-range fallback
  if (!pricing && lower.includes("openrouter/")) {
    pricing = (lower.includes("/auto") || lower.includes("/free")) ? OPENROUTER_AUTO_PRICING : FALLBACK_PRICING;
  }
  if (!pricing) return 0;

  return (
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output +
    (cacheRead / 1_000_000) * pricing.cacheRead +
    ((cacheWrite ?? 0) / 1_000_000) * pricing.cacheWrite
  );
}
