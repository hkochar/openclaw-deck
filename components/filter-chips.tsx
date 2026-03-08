"use client";

import { useCallback } from "react";

// ── Types ────────────────────────────────────────────────────────────

export interface ChipOption {
  key: string;
  label: string;
  /** Optional count displayed after label */
  count?: number;
}

interface FilterChipsBaseProps {
  /** Uppercase label shown to the left of the chips */
  label: string;
  options: ChipOption[];
  /** Show "Clear" button when there's an active selection (default: true for multi, false for single) */
  clearable?: boolean;
  /** Extra className on the outer wrapper */
  className?: string;
}

// Multi-select: selected is a Set, onChange receives a Set
interface FilterChipsMultiProps extends FilterChipsBaseProps {
  selected: Set<string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onChange: (value: any) => void;
}

// Single-select: selected is a string, onChange receives a string
interface FilterChipsSingleProps extends FilterChipsBaseProps {
  selected: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onChange: (value: any) => void;
}

export type FilterChipsProps = FilterChipsMultiProps | FilterChipsSingleProps;

// ── Component ────────────────────────────────────────────────────────

export function FilterChips(props: FilterChipsProps) {
  const { label, options, className, selected, onChange } = props;
  const multi = selected instanceof Set;

  const handleClick = useCallback(
    (key: string) => {
      if (multi) {
        const next = new Set(selected as Set<string>);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        onChange(next);
      } else {
        onChange(key);
      }
    },
    [selected, onChange, multi],
  );

  const handleClear = useCallback(() => {
    if (multi) onChange(new Set());
  }, [onChange, multi]);

  const hasSelection = multi ? (selected as Set<string>).size > 0 : false;
  const clearable = props.clearable ?? multi;

  return (
    <div className={`logs-filter-group${className ? ` ${className}` : ""}`}>
      {label && <span className="logs-filter-label">{label}</span>}
      <div className="logs-chips">
        {options.map((opt) => {
          const active = multi
            ? (selected as Set<string>).has(opt.key)
            : selected === opt.key;
          return (
            <button
              key={opt.key}
              className={`logs-chip${active ? " active" : ""}`}
              onClick={() => handleClick(opt.key)}
            >
              {opt.label}
              {opt.count !== undefined && (
                <span className="logs-chip-count">({opt.count})</span>
              )}
            </button>
          );
        })}
        {clearable && hasSelection && (
          <button className="logs-chip logs-chip-clear" onClick={handleClear}>
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
