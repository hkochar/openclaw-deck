import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

const HOME = process.env.HOME || "~";
const CONFIG_PATH = path.join(HOME, ".openclaw", "openclaw.json");

interface ModelEntry {
  id: string;           // full provider/modelId
  name: string;         // human-readable name
  provider: string;     // provider key
}

export async function GET() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const cfg = JSON.parse(raw);

    const models: ModelEntry[] = [];
    const seen = new Set<string>();

    // 1. Collect models from providers section
    const providers = cfg?.models?.providers ?? {};
    for (const [provKey, prov] of Object.entries(providers)) {
      const provObj = prov as Record<string, unknown>;
      const provModels = (provObj.models ?? []) as Array<Record<string, unknown>>;
      for (const m of provModels) {
        const fullId = `${provKey}/${m.id}`;
        if (!seen.has(fullId)) {
          seen.add(fullId);
          models.push({
            id: fullId,
            name: (m.name as string) || String(m.id),
            provider: provKey,
          });
        }
      }
    }

    // 2. Collect models referenced by agents (may include anthropic, openai, etc. not in providers)
    const agents = cfg?.agents?.list ?? [];
    for (const agent of agents as Array<Record<string, unknown>>) {
      const model = agent.model as Record<string, unknown> | undefined;
      if (!model) continue;

      const primary = model.primary as string | undefined;
      const fallbacks = (model.fallbacks ?? []) as string[];

      for (const mid of [primary, ...fallbacks]) {
        if (!mid || seen.has(mid)) continue;
        seen.add(mid);
        const parts = mid.split("/");
        const provider = parts[0];
        const shortName = parts[parts.length - 1];
        models.push({ id: mid, name: shortName, provider });
      }
    }

    // Sort: provider groups, then alphabetical
    models.sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));

    return NextResponse.json({ ok: true, models });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
