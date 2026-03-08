/**
 * Barrel re-export for event-log module.
 *
 * All implementation has been split into focused modules under ./lib/.
 * This file preserves the public import surface so that existing
 * `import { ... } from "@/plugin/event-log"` and `from "./event-log.js"`
 * continue to work unchanged.
 */

export * from "./lib/db-core";
export * from "./lib/loop-detection";
export * from "./lib/billing";
export * from "./lib/event-logging";
export * from "./lib/queries-core";
export * from "./lib/queries-cost";
export * from "./lib/queries-specialized";
export * from "./lib/reconciliation";
export * from "./lib/sessions";
export * from "./lib/backfill-transcripts";
export * from "./lib/reporting";
