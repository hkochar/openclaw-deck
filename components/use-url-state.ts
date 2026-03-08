"use client";

import { useState, useEffect, useCallback, useRef } from "react";

// ── Types ────────────────────────────────────────────────────────────

export interface StringParam {
  type: "string";
  default: string;
  aliases?: string[];
}
export interface NumberParam {
  type: "number";
  default: number;
  aliases?: string[];
}
export interface BooleanParam {
  type: "boolean";
  default: boolean;
  aliases?: string[];
}
export interface SetParam {
  type: "set";
  default: Set<string>;
  aliases?: string[];
}

export type ParamDef = StringParam | NumberParam | BooleanParam | SetParam;
export type ParamSchema = Record<string, ParamDef>;

/** Map a schema to its runtime value types */
export type ParamValues<S extends ParamSchema> = {
  [K in keyof S]: S[K] extends StringParam
    ? string
    : S[K] extends NumberParam
      ? number
      : S[K] extends BooleanParam
        ? boolean
        : S[K] extends SetParam
          ? Set<string>
          : never;
};

// ── Serialization ────────────────────────────────────────────────────

function serializeValue(def: ParamDef, value: unknown): string | null {
  switch (def.type) {
    case "string": {
      const v = value as string;
      return v === def.default ? null : v;
    }
    case "number": {
      const v = value as number;
      return v === def.default ? null : String(v);
    }
    case "boolean": {
      const v = value as boolean;
      return v === def.default ? null : v ? "1" : "0";
    }
    case "set": {
      const v = value as Set<string>;
      if (v.size === 0 && def.default.size === 0) return null;
      if (v.size === 0) return null;
      return [...v].sort().join(",");
    }
  }
}

function deserializeValue(def: ParamDef, raw: string | null): unknown {
  if (raw === null || raw === undefined) {
    return def.type === "set" ? new Set(def.default) : def.default;
  }
  switch (def.type) {
    case "string":
      return raw;
    case "number": {
      const n = Number(raw);
      return Number.isFinite(n) ? n : def.default;
    }
    case "boolean":
      return raw === "1" || raw === "true";
    case "set":
      return raw ? new Set(raw.split(",").filter(Boolean)) : new Set<string>();
  }
}

/** Read a param from URLSearchParams, checking aliases too */
function readParam(params: URLSearchParams, key: string, def: ParamDef): string | null {
  const v = params.get(key);
  if (v !== null) return v;
  if (def.aliases) {
    for (const alias of def.aliases) {
      const av = params.get(alias);
      if (av !== null) return av;
    }
  }
  return null;
}

// ── Hook ─────────────────────────────────────────────────────────────

/**
 * Sync state to URL query params via history.replaceState.
 *
 * SSR-safe: starts with defaults, syncs from URL on mount.
 * Debounces URL writes to batch rapid state changes.
 * Omits default values from URL. Preserves hash and unknown params.
 */
export function useUrlState<S extends ParamSchema>(
  schema: S,
): [ParamValues<S>, (key: keyof S, value: ParamValues<S>[keyof S]) => void, (updates: Partial<ParamValues<S>>) => void] {
  // Always initialize with defaults to avoid hydration mismatch.
  // URL params are synced in the useEffect below on mount.
  const [values, setValues] = useState<ParamValues<S>>(() => {
    const init = {} as Record<string, unknown>;
    for (const [key, def] of Object.entries(schema)) {
      init[key] = def.type === "set" ? new Set(def.default) : def.default;
    }
    return init as ParamValues<S>;
  });

  const schemaRef = useRef(schema);
  const valuesRef = useRef(values);
  valuesRef.current = values;

  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(false);

  // Read from URL on mount (client only)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    // Also read params embedded in the hash (e.g. #system?sys.cat=cron&sys.status=error)
    const hashQIdx = window.location.hash.indexOf("?");
    if (hashQIdx !== -1) {
      const hashParams = new URLSearchParams(window.location.hash.slice(hashQIdx + 1));
      for (const [k, v] of hashParams) {
        if (!params.has(k)) params.set(k, v);
      }
    }
    const parsed = {} as Record<string, unknown>;
    let changed = false;

    for (const [key, def] of Object.entries(schemaRef.current)) {
      const raw = readParam(params, key, def);
      const val = deserializeValue(def, raw);
      parsed[key] = val;

      // Check if different from default
      if (def.type === "set") {
        const defSet = def.default as Set<string>;
        const valSet = val as Set<string>;
        if (valSet.size !== defSet.size || [...valSet].some((v) => !defSet.has(v))) {
          changed = true;
        }
      } else if (val !== def.default) {
        changed = true;
      }
    }

    if (changed) {
      setValues(parsed as ParamValues<S>);
    }
    mountedRef.current = true;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Write to URL (debounced)
  const writeToUrl = useCallback(() => {
    if (!mountedRef.current) return;
    const url = new URL(window.location.href);
    const params = url.searchParams;

    // Remove all managed keys (including aliases)
    for (const [key, def] of Object.entries(schemaRef.current)) {
      params.delete(key);
      if (def.aliases) {
        for (const alias of def.aliases) params.delete(alias);
      }
    }

    // Set non-default values
    const currentValues = valuesRef.current;
    for (const [key, def] of Object.entries(schemaRef.current)) {
      const serialized = serializeValue(def, (currentValues as Record<string, unknown>)[key]);
      if (serialized !== null) {
        params.set(key, serialized);
      }
    }

    const newUrl = `${url.pathname}${params.toString() ? `?${params.toString()}` : ""}${url.hash}`;
    if (newUrl !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      history.replaceState(null, "", newUrl);
    }
  }, []);

  const scheduleWrite = useCallback(() => {
    if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
    writeTimerRef.current = setTimeout(writeToUrl, 50);
  }, [writeToUrl]);

  // Single key update
  const update = useCallback(
    (key: keyof S, value: ParamValues<S>[keyof S]) => {
      setValues((prev) => {
        const next = { ...prev, [key]: value };
        return next;
      });
      // Schedule URL write after state update
      setTimeout(scheduleWrite, 0);
    },
    [scheduleWrite],
  );

  // Batch update
  const batchUpdate = useCallback(
    (updates: Partial<ParamValues<S>>) => {
      setValues((prev) => ({ ...prev, ...updates }));
      setTimeout(scheduleWrite, 0);
    },
    [scheduleWrite],
  );

  return [values, update, batchUpdate];
}
