/**
 * OpenClaw config and schedule validators.
 *
 * Extracted from cron-manage/route.ts for testability.
 */

/**
 * Validate an openclaw.json config string.
 * Checks: valid JSON, agents.list exists + non-empty, each agent has id,
 * no empty primary models, models.providers is object if present.
 */
export function validateConfig(raw: string): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(raw);
  } catch (e) {
    return { ok: false, errors: [`Invalid JSON: ${e instanceof SyntaxError ? e.message : String(e)}`] };
  }

  // Check agents.list
  const agents = config.agents as Record<string, unknown> | undefined;
  if (!agents || typeof agents !== "object") {
    errors.push("Missing 'agents' section");
  } else {
    const list = agents.list;
    if (!Array.isArray(list)) {
      errors.push("'agents.list' must be an array");
    } else if (list.length === 0) {
      errors.push("'agents.list' is empty");
    } else {
      for (const agent of list) {
        if (!agent || typeof agent !== "object" || !("id" in agent)) {
          errors.push("Each agent in agents.list must have an 'id' field");
          break;
        }
        const model = (agent as Record<string, unknown>).model as Record<string, unknown> | undefined;
        if (model && typeof model.primary === "string" && model.primary.trim() === "") {
          errors.push(`Agent '${(agent as Record<string, unknown>).id}' has an empty primary model`);
        }
      }
    }
  }

  // Check models.providers
  const models = config.models as Record<string, unknown> | undefined;
  if (models && typeof models === "object") {
    if (models.providers && typeof models.providers !== "object") {
      errors.push("'models.providers' must be an object");
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Validate a cron schedule object.
 * Returns an error message string, or null if valid.
 */
export function validateSchedule(schedule: Record<string, unknown>): string | null {
  const kind = schedule.kind;
  if (kind === "cron") {
    const expr = schedule.expr;
    if (typeof expr !== "string") return "cron schedule requires 'expr' string";
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 5) return `cron expression must have 5 fields, got ${fields.length}`;
    for (const f of fields) {
      if (!f) return "empty field in cron expression";
    }
    return null;
  }
  if (kind === "every") {
    const ms = schedule.everyMs;
    if (typeof ms !== "number" || ms <= 0) return "'everyMs' must be a positive number";
    return null;
  }
  return `unknown schedule kind: '${kind}'`;
}
