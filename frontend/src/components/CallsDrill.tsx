import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CategoryBadge, ScoreBadge } from "@/components/common";
import { apiGet } from "@/lib/api";
import type { DrillCalls, DrillQuery } from "@/lib/types";

export interface DrillPick {
  title: string;
  subtitle?: string; // e.g. "Lowest Needs Discovery scores first"
  query: DrillQuery;
}

const DrillCtx = createContext<(p: DrillPick) => void>(() => {});

/** Open the "calls behind this chart point" dialog from any chart. */
export const useDrill = () => useContext(DrillCtx);

const qs = (q: DrillQuery) =>
  new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)])).toString();

export function DrillProvider({ children }: { children: ReactNode }) {
  const [pick, setPick] = useState<DrillPick | null>(null);
  const open = useCallback((p: DrillPick) => setPick(p), []);
  const value = useMemo(() => open, [open]);
  return (
    <DrillCtx.Provider value={value}>
      {children}
      <DrillDialog pick={pick} onClose={() => setPick(null)} />
    </DrillCtx.Provider>
  );
}

function DrillDialog({ pick, onClose }: { pick: DrillPick | null; onClose: () => void }) {
  const q = pick ? qs(pick.query) : "";
  const res = useQuery({ queryKey: ["drill", q], queryFn: () => apiGet<DrillCalls>(`/drill/calls?${q}`), enabled: !!pick });
  const shown = res.data?.calls.length ?? 0;
  return (
    <Dialog open={!!pick} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[80vh] overflow-y-auto overflow-x-hidden sm:max-w-2xl [&>*]:min-w-0" data-testid="drill-dialog">
        <DialogHeader>
          <DialogTitle data-testid="drill-title" className="text-white">{pick?.title}</DialogTitle>
          <DialogDescription data-testid="drill-count">
            {res.data ? `${res.data.total} call${res.data.total === 1 ? "" : "s"}${res.data.total > shown ? ` · showing ${shown}` : ""}` : "Loading calls…"}
            {pick?.subtitle ? ` · ${pick.subtitle}` : ""}
          </DialogDescription>
        </DialogHeader>
        {res.isError && <p className="text-sm text-red-300">Couldn't load these calls.</p>}
        {res.data?.total === 0 && <p className="text-sm text-slate-500" data-testid="drill-empty">No calls match this point.</p>}
        <ul className="min-w-0 divide-y divide-border">
          {(res.data?.calls ?? []).map((c) => (
            <li key={c.id}>
              <Link
                to={`/calls/${c.id}`}
                onClick={onClose}
                data-testid={`drill-call-${c.id}`}
                className="flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors duration-150 hover:bg-slate-800/60"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-white">{c.customer_name || "Unknown caller"}</p>
                  <p className="truncate text-xs text-slate-500">
                    {new Date(c.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · {c.rep_name}
                    {c.vehicle ? ` · ${c.vehicle}` : ""}
                    {c.topics.length ? ` · ${c.topics.slice(0, 2).join(", ")}` : ""}
                  </p>
                </div>
                <span className="hidden shrink-0 sm:inline-flex"><CategoryBadge category={c.category} /></span>
                <span className="shrink-0"><ScoreBadge score={c.overall_score} /></span>
              </Link>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

/** Data index of the clicked point from a recharts chart-level onClick (null when the click missed the data). */
export function chartIndex(e: unknown): number | null {
  const i = (e as { activeTooltipIndex?: number | string | null } | null)?.activeTooltipIndex;
  const n = i === null || i === undefined || i === "" ? NaN : Number(i);
  return Number.isFinite(n) ? n : null;
}

export const MONTH_LONG = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString(undefined, { month: "long", year: "numeric" });
