import { NextResponse } from "next/server";
import { loadEnv, GATEWAY_URL } from "@/app/api/_lib/paths";
import { modelCostPer1M } from "@/app/api/_lib/model-utils";

export const revalidate = 60;

import { agentMetadata, agentKeys, agentKeyFromId } from "@/lib/agent-config";

const AGENT_NAMES = agentMetadata();
const KNOWN_AGENTS = agentKeys();

export async function GET() {
  const env = loadEnv();
  const gatewayToken = env["OPENCLAW_GATEWAY_TOKEN"] || "";

  try {
    const res = await fetch(`${GATEWAY_URL}/tools/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${gatewayToken}` },
      body: JSON.stringify({ tool: "cron", args: { action: "list", includeDisabled: true }, sessionKey: "main" }),
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) {
      return NextResponse.json({ ok: false, error: `Gateway returned ${res.status}` }, { status: 502 });
    }

    const data = await res.json();
    // tools/invoke wraps result in { ok, result: { content: [{ type: "text", text: "<json>" }] } }
    let jobs: Record<string, unknown>[] = [];
    const textContent = data?.result?.content?.[0]?.text;
    if (textContent) {
      try {
        const parsed = JSON.parse(textContent);
        jobs = parsed?.jobs ?? [];
      } catch {}
    } else {
      jobs = data?.result?.jobs ?? data?.jobs ?? [];
    }

    // Group crons by agentId
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const agentMap: Record<string, { crons: any[]; model: string | null; lastActive: string | null }> = {};

    for (const agentId of KNOWN_AGENTS) {
      agentMap[agentId] = { crons: [], model: null, lastActive: null };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const job of jobs as any[]) {
      const rawAgentId: string = job.agentId ?? "main";
      const agentId: string = agentKeyFromId(rawAgentId);
      if (!agentMap[agentId]) {
        agentMap[agentId] = { crons: [], model: null, lastActive: null };
      }

      agentMap[agentId].crons.push(job);

      // Track model (use first non-null model found)
      const model: string | null = (job.payload?.model as string) ?? null;
      if (model && !agentMap[agentId].model) {
        agentMap[agentId].model = model;
      }

      // Track lastActive from state
      const lastRanAt: string | null = job.state?.lastRanAt ?? job.state?.lastRunAt ?? null;
      if (lastRanAt) {
        if (!agentMap[agentId].lastActive || lastRanAt > agentMap[agentId].lastActive!) {
          agentMap[agentId].lastActive = lastRanAt;
        }
      }
    }

    // Build usage array for known agents
    const usage = KNOWN_AGENTS.map((agentId) => {
      const entry = agentMap[agentId];
      const meta = AGENT_NAMES[agentId] ?? { name: agentId, emoji: "🤖" };
      const cronCount = entry.crons.length;

      // Estimate cost: sum across crons using token usage from state if available,
      // otherwise use a flat estimate of cost-per-run * estimated tokens
      let estimatedCost = 0;
      for (const job of entry.crons) {
        const model: string | null = (job.payload?.model as string) ?? entry.model;
        const costPer1M = modelCostPer1M(model);
        if (costPer1M === 0) continue;

        // If the job has tracked token usage, use it; otherwise skip (no data)
        const totalTokens: number =
          job.state?.totalTokensUsed ??
          job.state?.tokensUsed ??
          job.state?.totalTokens ??
          0;

        estimatedCost += (totalTokens / 1_000_000) * costPer1M;
      }

      return {
        agentId,
        agentName: `${meta.emoji} ${meta.name}`,
        model: entry.model,
        cronCount,
        estimatedCost: Math.round(estimatedCost * 10000) / 10000,
        lastActive: entry.lastActive,
      };
    });

    return NextResponse.json({ ok: true, usage });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      usage: [],
    });
  }
}
