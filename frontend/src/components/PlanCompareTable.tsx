import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Minus } from "lucide-react";
import { apiGet } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { BillingInterval, PlanComparison, PlanId } from "@/lib/types";

/** Side-by-side table of every plan; highlights the yard's plan and lets a manager pick one to switch to. */
export default function PlanCompareTable({ current, selected, onPick, interval = "month" }: { current?: PlanId; selected?: PlanId; onPick?: (p: PlanId) => void; interval?: BillingInterval }) {
  const { data } = useQuery({ queryKey: ["plans", "compare"], queryFn: () => apiGet<PlanComparison>("/billing/compare"), staleTime: Infinity });
  const [open, setOpen] = useState(true);
  // Rows bucketed by group once per data load, not re-filtered for every group on every render.
  const grouped = useMemo(() => {
    const m = new Map<string, PlanComparison["rows"]>();
    for (const r of data?.rows ?? []) m.set(r.group, [...(m.get(r.group) ?? []), r]);
    return m;
  }, [data]);
  if (!data) return null;
  const groups = [...grouped.keys()];
  const curIdx = data.plans.findIndex((p) => p.id === current);
  const col = (id: PlanId) => cn(id === selected && "bg-sky-500/10", id === current && "bg-amber-500/[0.07]");
  return (
    <div className="mt-8" data-testid="plan-compare">
      <button
        type="button"
        data-testid="plan-compare-toggle"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-lg font-bold text-white transition-colors duration-150 hover:text-amber-300"
      >
        Compare all plans <ChevronDown className={cn("size-5 transition-transform duration-200", !open && "-rotate-90")} />
      </button>
      {open && (
        <div className="mt-3 overflow-x-auto rounded-xl border border-border bg-card animate-in fade-in duration-300">
          <table className="w-full min-w-[760px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="sticky left-0 z-10 w-[32%] bg-card p-4 text-left font-mono text-[11px] font-normal uppercase tracking-wider text-slate-500">What you get</th>
                {(data?.plans ?? []).map((p, i) => (
                  <th key={p.id} data-testid={`plan-compare-col-${p.id}`} className={cn("p-4 text-left align-bottom font-normal", col(p.id))}>
                    {p.id === current && <span className="mb-1 inline-block rounded-full bg-amber-500 px-2 py-0.5 font-mono text-[10px] font-semibold text-primary-foreground">Your plan</span>}
                    <p className="font-mono text-[11px] uppercase tracking-wider text-sky-300">{p.name}</p>
                    <p className="font-heading text-2xl font-bold text-white">
                      ${interval === "year" ? p.price_yearly.toLocaleString() : p.price}
                      <span className="text-xs font-normal text-slate-500">{interval === "year" ? "/yr" : "/mo"}</span>
                    </p>
                    {onPick && p.id !== current && (
                      <button
                        type="button"
                        data-testid={`plan-compare-pick-${p.id}`}
                        onClick={() => onPick(p.id)}
                        className={cn(
                          "mt-2 rounded-md border px-2.5 py-1 text-xs font-medium transition-[background-color,border-color,color] duration-150",
                          selected === p.id ? "border-sky-400 bg-sky-400 text-black" : "border-slate-600 text-slate-300 hover:border-sky-400 hover:text-sky-300",
                        )}
                      >
                        {selected === p.id ? "Selected" : curIdx >= 0 && i > curIdx ? "Upgrade" : curIdx >= 0 ? "Switch" : "Choose"}
                      </button>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <Fragment key={g}>
                  <tr>
                    <td colSpan={data.plans.length + 1} className="bg-surface px-4 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-amber-400/90">
                      {g}
                    </td>
                  </tr>
                  {(grouped.get(g) ?? []).map((r) => (
                      <tr key={r.label} data-testid={`plan-compare-row-${r.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`} className="border-t border-border/60 transition-colors duration-150 hover:bg-surface/60">
                        <td className="sticky left-0 z-10 bg-card px-4 py-2.5 text-slate-300">{r.label}</td>
                        {(data?.plans ?? []).map((p) => {
                          const v = r.values[p.id];
                          return (
                            <td key={p.id} className={cn("px-4 py-2.5", col(p.id))}>
                              {v === true ? (
                                <Check className="size-4 text-emerald-400" aria-label="Included" />
                              ) : v === false || v === undefined ? (
                                <Minus className="size-4 text-slate-600" aria-label="Not included" />
                              ) : (
                                <span className="text-slate-200">{v}</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
