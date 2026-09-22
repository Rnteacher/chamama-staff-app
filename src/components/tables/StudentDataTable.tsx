"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

export interface StudentTableRow {
  student_id: string;
  student_name: string;
  group_name: string | null;
  has_project: boolean;
  project_major_name: string | null;
  intent_text: string | null;
  primary_master_name: string | null;
  master_names: string | null;
  status: string | null;
  status_source: string | null;
  last_report_at: string | null;
  intervention: boolean | null;
  mentor_last_meeting_at: string | null;
  mentor_last_status: string | null;
  master_last_meeting_at: string | null;
  master_last_status: string | null;
  mentor_next_meeting_at: string | null;
  mentor_next_meeting_weekday: number | null;
  mentor_next_meeting_time: string | null;
  master_next_meeting_at: string | null;
  master_next_meeting_weekday: number | null;
  master_next_meeting_time: string | null;
}

export type SortDir = "asc" | "desc";

export interface ColumnDef {
  key: string;
  label: string;
  sortable?: boolean;
  hidden?: boolean;
  sortValue?: (r: StudentTableRow) => string | number;
  render: (r: StudentTableRow) => React.ReactNode;
}

export interface FilterGroup {
  key: string;
  label: string;
  /** returns the value used for filtering */
  getValue: (r: StudentTableRow) => string | null;
  /** builds the select options from the current rows */
  buildOptions: (rows: StudentTableRow[]) => { value: string; label: string }[];
}

const STATUS_LABELS: Record<string, string> = { green: "ירוק", yellow: "צהוב", red: "אדום" };
const STATUS_STYLES: Record<string, string> = {
  green: "bg-emerald-100 text-emerald-800 border-emerald-300",
  yellow: "bg-amber-100 text-amber-800 border-amber-300",
  red: "bg-red-100 text-red-800 border-red-300",
};
const WD = ["א׳","ב׳","ג׳","ד׳","ה׳","ו׳","ש׳"];

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("he-IL", { day: "numeric", month: "short" });
}
function fmtNextMeeting(at: string | null, wd: number | null, time: string | null): string {
  if (!at || wd === null || wd === undefined || !time) return "—";
  return `${WD[wd]} · ${time.slice(0, 5)}`;
}

export interface StudentDataTableProps {
  title: string;
  rows: StudentTableRow[];
  columns: string[]; // which column keys to display
  readOnly?: boolean;
}

const ALL_COLUMNS: Record<string, ColumnDef> = {
  student_name: {
    key: "student_name", label: "חניך/ה", sortable: true,
    sortValue: (r) => r.student_name,
    render: (r) => <Link href={`/students/${r.student_id}`} prefetch={false} className="font-bold hover:underline">{r.student_name}</Link>,
  },
  group_name: {
    key: "group_name", label: "קבוצה", sortable: true,
    sortValue: (r) => r.group_name ?? "",
    render: (r) => <span className="text-muted">{r.group_name ?? "—"}</span>,
  },
  project_major_name: {
    key: "project_major_name", label: "מגמה", sortable: true,
    sortValue: (r) => r.project_major_name ?? "",
    render: (r) => (
      <span className="text-muted">
        {r.project_major_name ?? (r.has_project ? "לא במגמה" : "—")}
      </span>
    ),
  },
  primary_master_name: {
    key: "primary_master_name", label: "מאסטר/ית", sortable: true,
    sortValue: (r) => r.primary_master_name ?? "",
    render: (r) => <span className="text-muted">{r.primary_master_name ?? "—"}</span>,
  },
  status: {
    key: "status", label: "מצב", sortable: true,
    sortValue: (r) => r.status ? { green: 2, yellow: 1, red: 0 }[r.status] ?? 3 : 3,
    render: (r) => r.status ? (
      <span className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-extrabold ${STATUS_STYLES[r.status]}`}>
        {STATUS_LABELS[r.status]}
      </span>
    ) : (
      <span className="text-xs font-semibold text-muted">טרם דווח</span>
    ),
  },
  last_report_at: {
    key: "last_report_at", label: "דיווח אחרון", sortable: true,
    sortValue: (r) => r.last_report_at ?? "",
    render: (r) => <span className="text-muted text-xs">{fmtDate(r.last_report_at)}</span>,
  },
  intervention: {
    key: "intervention", label: "התערבות", sortable: true,
    sortValue: (r) => (r.intervention ? 0 : 1),
    render: (r) => r.intervention ? (
      <span className="rounded-full border border-warn bg-amber-50 px-2 py-0.5 text-xs font-bold text-warn">נדרשת</span>
    ) : <span className="text-muted">—</span>,
  },
  mentor_last_meeting_at: {
    key: "mentor_last_meeting_at", label: "פגישת מנטור אחרונה", sortable: true, hidden: true,
    sortValue: (r) => r.mentor_last_meeting_at ?? "",
    render: (r) => <span className="text-muted text-xs">{fmtDate(r.mentor_last_meeting_at)}{r.mentor_last_status && <span className="mr-1 font-bold">{STATUS_LABELS[r.mentor_last_status]}</span>}</span>,
  },
  master_last_meeting_at: {
    key: "master_last_meeting_at", label: "פגישת מאסטר אחרונה", sortable: true, hidden: true,
    sortValue: (r) => r.master_last_meeting_at ?? "",
    render: (r) => <span className="text-muted text-xs">{fmtDate(r.master_last_meeting_at)}{r.master_last_status && <span className="mr-1 font-bold">{STATUS_LABELS[r.master_last_status]}</span>}</span>,
  },
  mentor_next_meeting_at: {
    key: "mentor_next_meeting_at", label: "פגישת מנטור הבאה", sortable: true, hidden: true,
    sortValue: (r) => r.mentor_next_meeting_at ?? "",
    render: (r) => <span className="text-muted text-xs">{fmtNextMeeting(r.mentor_next_meeting_at, r.mentor_next_meeting_weekday, r.mentor_next_meeting_time)}</span>,
  },
  master_next_meeting_at: {
    key: "master_next_meeting_at", label: "פגישת מאסטר הבאה", sortable: true, hidden: true,
    sortValue: (r) => r.master_next_meeting_at ?? "",
    render: (r) => <span className="text-muted text-xs">{fmtNextMeeting(r.master_next_meeting_at, r.master_next_meeting_weekday, r.master_next_meeting_time)}</span>,
  },
};

export default function StudentDataTable({ title, rows, columns, readOnly }: StudentDataTableProps) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Record<string, string>>({});

  const cols = columns.map((k) => ALL_COLUMNS[k]).filter(Boolean);

  const uniqueValues = useMemo(() => {
    const map: Record<string, Set<string>> = {};
    for (const c of cols) {
      if (!c.sortable) continue;
      const s = new Set<string>();
      for (const r of rows) {
        const v = c.sortValue?.(r);
        if (v !== null && v !== undefined && v !== "" && typeof v === "string") s.add(v);
      }
      if (s.size > 1 && s.size <= 30) map[c.key] = s;
    }
    return map;
  }, [rows, cols]);

  const filterDefs: FilterGroup[] = useMemo(() => {
    const defs: FilterGroup[] = [];
    if (uniqueValues["group_name"]) {
      defs.push({ key: "group_name", label: "קבוצה", getValue: (r) => r.group_name, buildOptions: (rs) => { const s = new Set(rs.map((r) => r.group_name).filter(Boolean) as string[]); return [...s].sort().map((v) => ({ value: v, label: v })); } });
    }
    if (uniqueValues["project_major_name"]) {
      defs.push({ key: "project_major_name", label: "מגמה", getValue: (r) => (r.has_project ? (r.project_major_name ?? "__none__") : null), buildOptions: (rs) => { const s = new Set(rs.filter((r) => r.has_project).map((r) => r.project_major_name ?? "__none__").filter(Boolean)); return [...s].map((v) => ({ value: v, label: v === "__none__" ? "לא במגמה" : v })); } });
    }
    if (uniqueValues["primary_master_name"]) {
      defs.push({ key: "primary_master_name", label: "מאסטר/ית", getValue: (r) => r.primary_master_name, buildOptions: (rs) => { const s = new Set(rs.map((r) => r.primary_master_name).filter(Boolean) as string[]); return [...s].sort().map((v) => ({ value: v, label: v })); } });
    }
    if (uniqueValues["status"]) {
      defs.push({ key: "status", label: "מצב", getValue: (r) => r.status, buildOptions: (rs) => { const s = new Set(rs.map((r) => r.status).filter(Boolean) as string[]); return [...s].map((v) => ({ value: v, label: STATUS_LABELS[v] ?? v })); } });
    }
    if (rows.some((r) => r.intervention)) {
      defs.push({ key: "intervention", label: "התערבות", getValue: (r) => (r.intervention ? "1" : null), buildOptions: () => [{ value: "1", label: "נדרשת התערבות" }] });
    }
    return defs;
  }, [rows, uniqueValues]);

  const filtered = useMemo(() => {
    let out = rows;
    const q = search.trim().replace(/\s+/g, " ").toLowerCase();
    if (q) {
      out = out.filter((r) => {
        const n = r.student_name.toLowerCase();
        return n.includes(q) || n.split(" ").some((p) => p.startsWith(q));
      });
    }
    for (const [key, val] of Object.entries(filters)) {
      if (!val) continue;
      const def = filterDefs.find((f) => f.key === key);
      if (!def) continue;
      out = out.filter((r) => def.getValue(r) === val);
    }
    return out;
  }, [rows, search, filters, filterDefs]);

  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    const col = cols.find((c) => c.key === sortKey);
    if (!col?.sortValue) return filtered;
    const sv = col.sortValue;
    return [...filtered].sort((a, b) => {
      const va = sv(a), vb = sv(b);
      const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb), "he");
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [filtered, sortKey, sortDir, cols]);

  function toggleSort(key: string) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function resetFilters() {
    setSearch("");
    setFilters({});
    setSortKey(null);
    setSortDir("asc");
  }

  const hasActiveFilters = search.trim() !== "" || Object.values(filters).some(Boolean) || sortKey !== null;

  return (
    <section aria-label={title} className="rounded-2xl border border-line bg-surface p-4 lg:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-extrabold">{title}</h2>
        <span className="text-xs text-muted">{sorted.length} חניכים</span>
      </div>

      {/* filter toolbar — a proper desktop toolbar row, single student search */}
      <div className="mt-2 flex flex-wrap items-center gap-2 lg:mt-3 lg:gap-3">
        <label htmlFor={`search-${title}`} className="sr-only">חיפוש חניך</label>
        <input
          id={`search-${title}`}
          type="search"
          placeholder="חיפוש חניך…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-xl border border-line bg-white px-3 py-1.5 text-sm sm:w-56 lg:w-72"
        />
        {filterDefs.map((f) => (
          <label key={f.key} className="text-xs font-semibold text-muted">
            <span className="sr-only">{f.label}</span>
            <select
              value={filters[f.key] ?? ""}
              onChange={(e) => setFilters((p) => ({ ...p, [f.key]: e.target.value }))}
              className="mr-1 rounded-lg border border-line bg-white px-2 py-1.5 text-xs"
            >
              <option value="">{f.label}: הכל</option>
              {f.buildOptions(rows).map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
        ))}
        {hasActiveFilters && (
          <button type="button" onClick={resetFilters} className="rounded-full border border-line px-3 py-1 text-xs font-bold text-muted hover:bg-bg">
            נקה סינון
          </button>
        )}
      </div>

      {sorted.length === 0 ? (
        <p className="mt-3 py-4 text-center text-sm text-muted">לא נמצאו חניכים מתאימים.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[760px] whitespace-nowrap text-right text-sm">
            <thead>
              <tr className="border-b border-line text-xs text-muted">
                {cols.map((c) => (
                  <th key={c.key} scope="col" className="px-2 py-2 font-semibold first:pr-0 last:pl-0">
                    {c.sortable ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(c.key)}
                        className={`inline-flex items-center gap-0.5 hover:text-ink ${sortKey === c.key ? "text-ink font-extrabold" : ""}`}
                        aria-label={`מיון לפי ${c.label}`}
                      >
                        {c.label}
                        {sortKey === c.key && (
                          <span aria-hidden="true">{sortDir === "asc" ? "▲" : "▼"}</span>
                        )}
                      </button>
                    ) : c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.student_id} className="border-b border-line/60 last:border-0">
                  {cols.map((c) => (
                    <td key={c.key} className="px-2 py-2.5 first:pr-0 last:pl-0">{c.render(r)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
