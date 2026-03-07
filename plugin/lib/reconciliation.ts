import { getDb } from "./db-core";
import { getLogger } from "../logger";
import { invalidateCostCache } from "./queries-cost";

// ── OpenRouter cost reconciliation ──────────────────────────────────
// OpenRouter's "auto" route returns cost=0 in the streaming response because
// the gateway's OpenAI-compat layer doesn't pass through the non-standard
// `usage.cost` field. This reconciler polls the Activity API to get real
// costs and backfills them into DB events proportionally by token count.

interface OpenRouterActivityItem {
  date: string;
  model: string;
  usage: number;         // cost in USD
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
}

let lastReconcileDate = "";

/**
 * Fetch OpenRouter activity for a date and backfill provider_cost + resolved_model
 * on events that have cost=0 and model LIKE 'openrouter/%'.
 * Distributes daily per-model cost across events proportionally by total token count.
 * Returns number of events updated.
 */
export async function reconcileOpenRouterCosts(apiKey: string, fullBackfill = false): Promise<number> {
  if (!apiKey) return 0;

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  let dates: string[];
  if (fullBackfill) {
    // Find all dates with unreconciled openrouter events
    const db = getDb();
    const rows = db.prepare(`
      SELECT DISTINCT date(ts / 1000, 'unixepoch') as day
      FROM events
      WHERE type = 'llm_output'
        AND model LIKE 'openrouter/%'
        AND (provider_cost IS NULL OR provider_cost = 0)
        AND (COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) > 0
      ORDER BY day
    `).all() as Array<{ day: string }>;
    dates = rows.map(r => r.day);
  } else {
    // Normal mode: just yesterday + today
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    dates = [yesterday, today];
  }

  let totalUpdated = 0;
  for (const date of dates) {
    totalUpdated += await reconcileDate(apiKey, date);
  }
  lastReconcileDate = today;
  return totalUpdated;
}

async function reconcileDate(apiKey: string, date: string): Promise<number> {
  // Fetch activity from OpenRouter
  let items: OpenRouterActivityItem[];
  try {
    const resp = await fetch(`https://openrouter.ai/api/v1/activity?date=${date}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!resp.ok) return 0;
    const body = await resp.json() as { data?: OpenRouterActivityItem[] };
    items = body.data ?? [];
  } catch {
    return 0;
  }

  if (items.length === 0) return 0;

  // Compute date range in ms
  const dayStart = new Date(date + "T00:00:00Z").getTime();
  const dayEnd = dayStart + 86_400_000;

  const db = getDb();
  let updated = 0;

  for (const item of items) {
    if (!item.usage || item.usage <= 0) continue;

    // Find matching DB events: openrouter/* model, in this date, with no real cost
    // The model in the activity is the resolved model (e.g. "google/gemini-2.5-flash-lite")
    // but our DB has "openrouter/auto" or "openrouter/free". Match by date range + zero cost.
    const events = db.prepare(`
      SELECT id, COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) as total_tokens
      FROM events
      WHERE type = 'llm_output'
        AND model LIKE 'openrouter/%'
        AND ts >= ? AND ts < ?
        AND (provider_cost IS NULL OR provider_cost = 0)
        AND (COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) > 0
        AND COALESCE(billing, 'metered') != 'subscription'
      ORDER BY ts
    `).all(dayStart, dayEnd) as Array<{ id: number; total_tokens: number }>;

    if (events.length === 0) continue;

    // Distribute cost proportionally by token count
    const totalTokens = events.reduce((sum, e) => sum + e.total_tokens, 0);
    if (totalTokens === 0) continue;

    const updateStmt = db.prepare(`
      UPDATE events SET provider_cost = ?, resolved_model = COALESCE(resolved_model, ?)
      WHERE id = ?
    `);

    const txn = db.transaction(() => {
      for (const ev of events) {
        const share = (ev.total_tokens / totalTokens) * item.usage;
        const roundedCost = Math.round(share * 1_000_000) / 1_000_000;
        updateStmt.run(roundedCost, item.model, ev.id);
        updated++;
      }
    });
    txn();
  }

  // Clear cost cache so dashboard picks up new values
  if (updated > 0) invalidateCostCache();

  return updated;
}

// ── Anthropic cost reconciliation ──────────────────────────────────
// Uses the Admin API to get actual USD costs and backfill provider_cost.
// Requires an admin key (sk-ant-admin-...) from an org account.

interface AnthropicCostBucket {
  start_time: string;
  end_time: string;
  results: Array<{
    amount: string;  // cents as decimal string
    currency: string;
    model?: string;
    cost_type?: string;
    token_type?: string;
  }>;
}

/**
 * Fetch Anthropic cost report for yesterday+today and backfill provider_cost.
 * Groups by description to get per-model costs, then distributes proportionally.
 */
export async function reconcileAnthropicCosts(adminKey: string): Promise<number> {
  if (!adminKey) return 0;

  const now = new Date();
  const yesterday = new Date(now.getTime() - 86_400_000);
  const startingAt = yesterday.toISOString().slice(0, 10) + "T00:00:00Z";
  const endingAt = now.toISOString().slice(0, 10) + "T23:59:59Z";

  // Fetch cost report grouped by description (gives model + cost_type breakdown)
  let buckets: AnthropicCostBucket[];
  try {
    const url = `https://api.anthropic.com/v1/organizations/cost_report?starting_at=${startingAt}&ending_at=${endingAt}&bucket_width=1d&group_by[]=description`;
    const resp = await fetch(url, {
      headers: {
        "x-api-key": adminKey,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return 0;
    const body = await resp.json() as { data?: AnthropicCostBucket[] };
    buckets = body.data ?? [];
  } catch {
    return 0;
  }

  if (buckets.length === 0) return 0;

  const db = getDb();
  let updated = 0;

  for (const bucket of buckets) {
    const dayStart = new Date(bucket.start_time).getTime();
    const dayEnd = new Date(bucket.end_time).getTime();

    // Sum cost per model from the bucket results
    // Cost report amount is in cents as a decimal string
    const modelCosts = new Map<string, number>();
    for (const r of bucket.results) {
      if (!r.model || !r.amount) continue;
      const costUsd = parseFloat(r.amount) / 100; // cents → dollars
      if (costUsd <= 0 || isNaN(costUsd)) continue;
      modelCosts.set(r.model, (modelCosts.get(r.model) ?? 0) + costUsd);
    }

    if (modelCosts.size === 0) continue;

    // Total cost for all Anthropic models this day
    let totalDayCost = 0;
    for (const cost of modelCosts.values()) totalDayCost += cost;
    if (totalDayCost <= 0) continue;

    // Find unreconciled Anthropic events in this day
    const events = db.prepare(`
      SELECT id, model, COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) as total_tokens
      FROM events
      WHERE type = 'llm_output'
        AND model LIKE 'anthropic/%'
        AND ts >= ? AND ts < ?
        AND (provider_cost IS NULL OR provider_cost = 0)
        AND (COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) > 0
        AND COALESCE(billing, 'metered') != 'subscription'
      ORDER BY ts
    `).all(dayStart, dayEnd) as Array<{ id: number; model: string; total_tokens: number }>;

    if (events.length === 0) continue;

    const totalTokens = events.reduce((sum, e) => sum + e.total_tokens, 0);
    if (totalTokens === 0) continue;

    // Distribute total day cost proportionally by token count
    const updateStmt = db.prepare(`
      UPDATE events SET provider_cost = ? WHERE id = ?
    `);

    const txn = db.transaction(() => {
      for (const ev of events) {
        const share = (ev.total_tokens / totalTokens) * totalDayCost;
        const roundedCost = Math.round(share * 1_000_000) / 1_000_000;
        updateStmt.run(roundedCost, ev.id);
        updated++;
      }
    });
    txn();
  }

  if (updated > 0) invalidateCostCache();
  return updated;
}

// ── OpenAI cost reconciliation ──────────────────────────────────
// Uses the Admin API to get actual USD costs and backfill provider_cost.
// Requires an admin key from platform.openai.com/settings/organization/admin-keys.

interface OpenAICostBucket {
  start_time: number; // unix seconds
  end_time: number;
  results: Array<{
    amount: { value: number; currency: string };
    line_item?: string;
    project_id?: string;
  }>;
}

/**
 * Fetch OpenAI cost report for yesterday+today and backfill provider_cost.
 */
export async function reconcileOpenAICosts(adminKey: string): Promise<number> {
  if (!adminKey) return 0;

  const now = Math.floor(Date.now() / 1000);
  const startTime = now - 2 * 86400; // 2 days ago

  let buckets: OpenAICostBucket[];
  try {
    const url = `https://api.openai.com/v1/organization/costs?start_time=${startTime}&bucket_width=1d&group_by[]=line_item`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${adminKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return 0;
    const body = await resp.json() as { data?: OpenAICostBucket[] };
    buckets = body.data ?? [];
  } catch {
    return 0;
  }

  if (buckets.length === 0) return 0;

  const db = getDb();
  let updated = 0;

  for (const bucket of buckets) {
    const dayStartMs = bucket.start_time * 1000;
    const dayEndMs = bucket.end_time * 1000;

    // Sum total cost for this day
    let totalDayCost = 0;
    for (const r of bucket.results) {
      if (r.amount?.value > 0) totalDayCost += r.amount.value;
    }
    if (totalDayCost <= 0) continue;

    // Find unreconciled OpenAI events in this day
    const events = db.prepare(`
      SELECT id, model, COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) as total_tokens
      FROM events
      WHERE type = 'llm_output'
        AND model LIKE 'openai/%'
        AND ts >= ? AND ts < ?
        AND (provider_cost IS NULL OR provider_cost = 0)
        AND (COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) > 0
        AND COALESCE(billing, 'metered') != 'subscription'
      ORDER BY ts
    `).all(dayStartMs, dayEndMs) as Array<{ id: number; model: string; total_tokens: number }>;

    if (events.length === 0) continue;

    const totalTokens = events.reduce((sum, e) => sum + e.total_tokens, 0);
    if (totalTokens === 0) continue;

    const updateStmt = db.prepare(`
      UPDATE events SET provider_cost = ? WHERE id = ?
    `);

    const txn = db.transaction(() => {
      for (const ev of events) {
        const share = (ev.total_tokens / totalTokens) * totalDayCost;
        const roundedCost = Math.round(share * 1_000_000) / 1_000_000;
        updateStmt.run(roundedCost, ev.id);
        updated++;
      }
    });
    txn();
  }

  if (updated > 0) invalidateCostCache();
  return updated;
}
