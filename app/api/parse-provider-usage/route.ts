import { NextRequest, NextResponse } from "next/server";
import { loadEnv } from "@/app/api/_lib/paths";

export const dynamic = "force-dynamic";

const SYSTEM_PROMPT = `You parse provider usage text (copied from subscription dashboards like claude.ai/settings/usage, OpenAI usage page, etc.) into structured JSON.

Return ONLY valid JSON with this shape:
{
  "plan": "Max" | "Pro" | "Free" | "Team" | null,
  "windows": [
    {
      "id": "5h-rolling" | "daily" | "weekly" | "monthly" | string,
      "pct": <number 0-100>,
      "resetIn": "<human readable, e.g. '2 hr 57 min' or 'Thu 9:59 PM'>" | null
    }
  ]
}

Rules:
- "Current session" = "5h-rolling" (Anthropic's rolling window)
- "Weekly limits" = "weekly"
- "Daily limits" = "daily"
- Extract percentage from "X% used"
- Keep resetIn as the raw text, do not compute timestamps
- If you can detect the plan tier, include it
- If text is unrecognizable, return {"plan": null, "windows": []}`;

export async function POST(req: NextRequest) {
  try {
    const { text, provider } = await req.json();
    if (!text || typeof text !== "string") {
      return NextResponse.json({ error: "text is required" }, { status: 400 });
    }

    const env = loadEnv();
    const apiKey = env["ANTHROPIC_API_KEY"] || process.env["ANTHROPIC_API_KEY"] || "";
    if (!apiKey) {
      // Fall back to regex parsing on the client
      return NextResponse.json({ error: "no_api_key", fallback: true });
    }

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: `Provider: ${provider || "unknown"}\n\nUsage text:\n${text}` }],
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const err = await res.text();
      return NextResponse.json({ error: `Anthropic API error: ${res.status}`, detail: err, fallback: true });
    }

    const data = await res.json();
    const content = data.content?.[0]?.text ?? "";

    // Extract JSON from response (might be wrapped in markdown code blocks)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return NextResponse.json({ error: "Could not parse LLM response", raw: content, fallback: true });
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return NextResponse.json({ ok: true, parsed });
  } catch (e) {
    return NextResponse.json({ error: String(e), fallback: true });
  }
}
