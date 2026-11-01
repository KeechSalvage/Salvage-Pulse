import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { Overline, Panel } from "@/components/common";
import { monthLabel } from "@/components/MonthlyTrends";
import { MONTH_LONG, useDrill } from "@/components/CallsDrill";
import { apiGet } from "@/lib/api";
import { lotQS } from "@/lib/lot";
import { cn } from "@/lib/utils";
import type { PartsSeasonal } from "@/lib/types";

type Mode = "asked" | "sold";

const REASONS: Record<string, { label: string; color: string; fix: string }> = {
  price: { label: "Price", color: "var(--color-amber-500)", fix: "Check pricing vs aftermarket and practise value selling" },
  out_of_stock: { label: "Out of stock", color: "#F87171", fix: "Pull or buy more of these vehicles" },
  condition: { label: "Condition", color: "#A78BFA", fix: "Send photos and grade condition up front" },
  fitment: { label: "Fitment / VIN", color: "#38BDF8", fix: "Confirm VIN and part numbers before quoting" },
  insurance: { label: "Insurance", color: "#34D399", fix: "Help shops document OEM recycled for the adjuster" },
  shipping: { label: "Shipping / timing", color: "#FB923C", fix: "Offer firm delivery dates or local pickup" },
  other: { label: "Other", color: "#94A3B8", fix: "" },
  unknown: { label: "Not clear", color: "#475569", fix: "" },
};

export default function SeasonalPartsPanel({ lot = "" }: { lot?: string }) {
  const [mode, setMode] = useState<Mode>("asked");
  const [picked, setPicked] = useState<string | null>(null);
  const drill = useDrill();
  const { data, isError } = useQuery({ queryKey: ["parts-seasonal", lot], queryFn: () => apiGet<PartsSeasonal>(`/analytics/parts-seasonal${lotQS(lot)}`) });
  const lowClose = useMemo(() => (data?.parts ?? []).filter((p) => p.low_close), [data]);
  const months = (data?.months ?? []).slice(-6);
  const offset = ((data?.months ?? []).length) - months.length;
  const cells = (p: PartsSeasonal["parts"][number]) => (mode === "asked" ? p.asked_by_month : p.sold_by_month).slice(offset);
  const max = Math.max(1, ...((data?.parts ?? []).flatMap(cells) ?? [1]));
  const focus = (data?.parts ?? []).find((p) => p.part === picked) ?? (data?.parts ?? []).find((p) => p.low_close) ?? data?.parts?.[0];
  const unsold = focus?.reasons.reduce((s, r) => s + r.calls, 0) ?? 0;
  const known = focus?.reasons.filter((r) => r.reason !== "unknown") ?? [];
  const topFix = known[0] ? REASONS[known[0].reason]?.fix : "";

  return (
    <Panel className="xl:col-span-12" testId="seasonal-parts-panel">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Overline>Seasonal parts</Overline>
          <h3 className="mt-1 text-xl font-bold text-white">Which parts move each month</h3>
          <p className="mt-1 text-sm text-slate-400">Parts named in call topics, yard-wide. Darker cells are busier months — stock up ahead of them. Tap a cell to see those calls. Close rate = won of sales calls mentioning the part.</p>
        </div>
        <div className="flex gap-1 rounded-lg bg-surface p-1">
          {(["asked", "sold"] as Mode[]).map((m) => (
            <button
              key={m}
              data-testid={`parts-mode-${m}`}
              onClick={() => setMode(m)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors duration-150",
                mode === m ? "bg-amber-500 text-primary-foreground" : "text-slate-400 hover:text-white",
              )}
            >
              {m === "asked" ? "Asked about" : "Sold"}
            </button>
          ))}
        </div>
      </div>

      {isError && <p className="mt-4 text-sm text-slate-500">Parts data unavailable.</p>}
      {data && (data.parts ?? []).length === 0 && <p className="mt-4 text-sm text-slate-500">No parts found in call topics yet.</p>}
      {data && lowClose.length > 0 && (
        <div data-testid="parts-low-close-callout" className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/[0.06] px-4 py-3 text-sm">
          <AlertTriangle className="size-4 text-red-400" />
          <span className="text-slate-200">Asked about a lot, rarely bought:</span>
          {lowClose.map((p) => (
              <span key={p.part} className="rounded-full border border-red-500/40 px-2.5 py-0.5 text-xs capitalize text-red-200">
                {p.part} · {p.close_rate}%
              </span>
            ))}
          <span className="text-xs text-slate-400">vs {data.yard_close_rate}% yard close rate — check pricing, stock or how reps quote these.</span>
        </div>
      )}
      {data && (data.parts ?? []).length > 0 && (
        <div className="mt-5 overflow-x-auto">
          <table className="w-full text-sm" data-testid="parts-table">
            <thead>
              <tr className="font-mono text-[11px] uppercase tracking-wider text-slate-500">
                <th className="py-2 text-left font-normal">Part</th>
                {months.map((m) => (
                  <th key={m} className="px-1 py-2 text-center font-normal">
                    {monthLabel(m)}
                  </th>
                ))}
                <th className="py-2 text-right font-normal">Sold / asked</th>
                <th className="py-2 pl-4 text-right font-normal">Close rate</th>
                <th className="py-2 pl-4 text-right font-normal">Peak</th>
              </tr>
            </thead>
            <tbody>
              {(data.parts ?? []).map((p, i) => (
                <tr
                  key={p.part}
                  data-testid={`parts-row-${i}`}
                  onClick={() => setPicked(p.part)}
                  className={cn("cursor-pointer border-t border-border/60 transition-colors duration-150 hover:bg-slate-800/30", focus?.part === p.part && "bg-amber-500/[0.05]")}
                >
                  <td data-testid={`parts-name-${i}`} className="py-2 pr-3 font-medium capitalize text-white">
                    {p.part}
                  </td>
                  {cells(p).map((n, j) => (
                    <td key={months[j]} className="px-1 py-1.5">
                      <button
                        type="button"
                        data-testid={`parts-cell-${i}-${months[j]}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          drill({
                            title: `${p.part[0].toUpperCase()}${p.part.slice(1)} · ${MONTH_LONG(months[j])}`,
                            subtitle: mode === "asked" ? "calls asking about it" : "won orders",
                            query: { part: p.part, month: months[j], ...(mode === "asked" ? {} : { outcome: "won" }) },
                          });
                        }}
                        className="mx-auto flex h-8 w-full min-w-[52px] cursor-pointer items-center justify-center rounded font-mono text-xs transition-[background-color,box-shadow,transform] duration-150 hover:ring-2 hover:ring-sky-400/70 active:scale-95"
                        style={{ background: n ? `rgba(58, 106, 240, ${0.12 + 0.78 * (n / max)})` : "#0D1424", color: n / max > 0.55 ? "#FFFFFF" : "var(--muted-foreground)" }}
                        title={`${n} ${mode === "asked" ? "calls asked about" : "orders of"} ${p.part} in ${monthLabel(months[j])}`}
                      >
                        {n || "·"}
                      </button>
                    </td>
                  ))}
                  <td data-testid={`parts-totals-${i}`} className="py-2 text-right font-mono text-slate-300">
                    <span className="text-emerald-300">{p.sold}</span> / {p.asked}
                  </td>
                  <td className="py-2 pl-4 text-right" title={`${p.sales_calls} sales calls mention this part`}>
                    <span
                      data-testid={`parts-close-${i}`}
                      className={cn(
                        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-xs",
                        p.low_close ? "border-red-500/40 bg-red-500/10 text-red-300" : "border-transparent text-slate-200",
                      )}
                    >
                      {p.sales_calls ? `${p.close_rate}%` : "—"}
                      {p.low_close && <span className="text-[10px] uppercase">low</span>}
                    </span>
                  </td>
                  <td className="py-2 pl-4 text-right font-mono text-xs text-amber-300">{monthLabel(p.peak_month)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {focus && (
            <div data-testid="parts-reasons" className="mt-5 rounded-lg border border-border bg-surface p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h4 className="font-heading text-base font-bold text-white">
                  Why callers didn't buy: <span data-testid="parts-reasons-part" className="capitalize text-amber-300">{focus.part}</span>
                </h4>
                <span className="font-mono text-[11px] text-slate-500">
                  {unsold} unsold sales calls · click any part above
                </span>
              </div>
              {unsold === 0 ? (
                <p className="mt-2 text-sm text-slate-500">Every sales call about this part closed.</p>
              ) : (
                <>
                  <div className="mt-3 flex h-3 overflow-hidden rounded-full bg-slate-800">
                    {(focus.reasons ?? []).map((r) => (
                      <div key={r.reason} style={{ width: `${(100 * r.calls) / unsold}%`, background: REASONS[r.reason]?.color ?? "#64748B" }} title={`${REASONS[r.reason]?.label ?? r.reason}: ${r.calls}`} />
                    ))}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
                    {(focus.reasons ?? []).map((r) => (
                      <span key={r.reason} data-testid={`parts-reason-${r.reason}`} className="flex items-center gap-1.5 text-sm text-slate-300">
                        <span className="size-2.5 rounded-full" style={{ background: REASONS[r.reason]?.color ?? "#64748B" }} />
                        {REASONS[r.reason]?.label ?? r.reason}
                        <span className="font-mono text-xs text-slate-500">
                          {r.calls} ({Math.round((100 * r.calls) / unsold)}%)
                        </span>
                      </span>
                    ))}
                  </div>
                  {topFix && (
                    <p data-testid="parts-reasons-fix" className="mt-3 text-sm text-slate-300">
                      <span className="text-amber-300">Likely fix:</span> {topFix}.
                      {known[0]?.reason === "price" && (
                        <>
                          {" "}
                          <Link to="/roleplay" data-testid="parts-reasons-roleplay-link" className="text-sky-400 hover:underline">
                            Practise price objections in the Role-Play Trainer
                          </Link>
                        </>
                      )}
                    </p>
                  )}
                  <p className="mt-2 text-[11px] text-slate-500">
                    Likely reasons, inferred from RingCentral call topics
                    {focus.reasons.some((r) => r.from_ai) ? "; calls with a transcript use the AI-read reason" : ". Attach a transcript or recording to a call for an exact AI-read reason"}.
                  </p>
                </>
              )}
            </div>
          )}
          {(data.months ?? []).length < 2 && (
            <p data-testid="parts-needs-history" className="mt-3 text-xs text-slate-500">
              Only one month loaded, so seasonal peaks aren't visible yet. <Link to="/upload" className="text-sky-400 hover:underline">Import older call history</Link> — a full year shows the busy seasons.
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}
