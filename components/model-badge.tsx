/**
 * Shared ModelBadge component.
 *
 * Renders a colored pill badge for a model identifier.
 * Uses CSS classes from globals.css (.model-badge--*).
 */

export function modelShortName(model: string | undefined | null): string {
  if (!model) return "unknown";
  if (model === "openrouter/auto") return "auto (openrouter)";
  if (model.includes("nemotron")) return "nemotron-ultra";
  if (model.includes("codex-mini")) return "codex-mini";
  if (model.includes("gpt-5.3-codex")) return "gpt-5.3-codex";
  const parts = model.split("/");
  if (parts.length >= 2) {
    if (parts[0] === "nvidia" && model.includes("kimi")) return "kimi-k2.5 (nvidia)";
    return parts[parts.length - 1];
  }
  return model;
}

export function modelColorClass(model: string | undefined | null): string {
  if (!model) return "unknown";
  if (model.includes("nvidia") || model.includes("kimi-k2.5")) return "nvidia";
  if (model.includes("opus")) return "opus";
  if (model.includes("haiku")) return "haiku";
  if (model.includes("codex")) return "codex";
  if (model.includes("nemotron")) return "nvidia";
  if (model.includes("openrouter/auto")) return "openrouter";
  if (model.includes("openai/")) return "openai";
  return "sonnet";
}

export function ModelBadge({ model }: { model: string | undefined | null }) {
  if (!model) return <span className="model-badge model-badge--unknown">unknown</span>;
  const cls = modelColorClass(model);
  return (
    <span className={`model-badge model-badge--${cls}`}>
      {modelShortName(model)}
    </span>
  );
}
