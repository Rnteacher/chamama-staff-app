"use client";

import { useMemo, useState } from "react";

export interface MultiSelectOption {
  id: string;
  label: string;
  /** small hint text, e.g. "טרם התחבר/ה" */
  hint?: string;
}

/**
 * Searchable checkbox multi-select (RTL). Renders a fixed-height scroll list
 * so admin forms stay compact on desktop and mobile.
 */
export default function MultiSelectCheckbox({
  name,
  options,
  selectedIds,
  label,
  emptyText = "אין אפשרויות",
  searchable = true,
}: {
  name: string;
  options: MultiSelectOption[];
  selectedIds: string[];
  label: string;
  emptyText?: string;
  searchable?: boolean;
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return options;
    return options.filter((o) => o.label.includes(q));
  }, [query, options]);

  return (
    <fieldset>
      <legend className="text-sm font-bold">{label}</legend>
      {searchable && options.length > 6 && (
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="חיפוש…"
          aria-label={`חיפוש ב${label}`}
          className="mt-1.5 w-full rounded-xl border border-line px-3 py-1.5 text-sm"
        />
      )}
      <div className="mt-1.5 grid max-h-56 grid-cols-1 gap-1 overflow-y-auto rounded-xl border border-line bg-white p-2 sm:grid-cols-2">
        {options.length === 0 ? (
          <p className="text-sm text-muted">{emptyText}</p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-muted">לא נמצאו תוצאות.</p>
        ) : (
          filtered.map((o) => (
            <label key={o.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name={name}
                value={o.id}
                defaultChecked={selectedIds.includes(o.id)}
                className="h-5 w-5 accent-[#46b800]"
              />
              <span>
                {o.label}
                {o.hint && <span className="text-xs text-warn"> · {o.hint}</span>}
              </span>
            </label>
          ))
        )}
      </div>
    </fieldset>
  );
}
