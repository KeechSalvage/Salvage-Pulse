import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Overline, Panel, fmtDate, fmtMoney } from "@/components/common";
import { monthLabel } from "@/components/MonthlyTrends";
import { apiGet } from "@/lib/api";
import { cn } from "@/lib/utils";
import { CHART, axisTick } from "@/lib/chartColors";
import type { WinBackResult, WinBackResults } from "@/lib/types";
import { MONTH_LONG, chartIndex, useDrill } from "@/components/CallsDrill";

export const OUTCOMES: { id: WinBackResult; label: string; color: string; cls: string }[] = [
  { id: "reached", label: "Reached", color: CHART.brand, cls: "border-sky-500/40 text-sky-300 hover:bg-sky-500/10" },
  { id: "ordered", label: "Ordered", color: "#34D399", cls: "border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10" },
  { id: "no_interest", label: "No interest", color: "#64748B", cls: "border-slate-600 text-slate-300 hover:bg-slate-500/10" },
];
const LABEL = Object.fromEntries(OUTCOMES.map((o) => [o.id, o.label])) as Record<WinBackResult, string>;

export default function WinBackResultsPanel({ repId, testId = "winback-results-panel" }: { repId?: string; testId?: string }) {
  const drill = useDrill();
  const { data, isError } = useQuery({
    queryKey: ["winback-results", repId ?? "default"],
    queryFn: () => apiGet<WinBackResults>(`/analytics/winback${repId ? `?rep_id=${repId}` : ""}`),
  });
  const ordered = (data?.months ?? []).reduce((s, m) => s + m.ordered, 0);
  const value = (data?.months ?? []).reduce((s, m) => s + m.confirmed_value, 0);
  const stats = [
    { k: "marked", label: "Win-back calls", v: String(data?.total ?? 0) },
    { k: "ordered", label: "Marked ordered", v: String(ordered) },
    { k: "confirmed", label: "Confirmed by calls", v: String(data?.confirmed ?? 0) },
    { k: "value", label: "Confirmed value", v: fmtMoney(value) },
  ];

  return (
    <Panel className="xl:col-span-12" testId={testId}>
      <Overline>Win-back results</Overline>
      <h3 className="mt-1 text-xl font-bold text-white">Did the follow-ups pay off?</h3>
      <p className="mt-1 text-sm text-slate-400">
        Reps mark each win-back call. An order counts as confirmed when that customer's next won order call shows up within 30 days.
      </p>
      {isError && <p className="mt-4 text-sm text-slate-500">Win-back results unavailable.</p>}
      {data && (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            {stats.map((s) => (
              <div key={s.k} className="rounded-lg border border-border bg-surface p-3">
                <p className="font-mono text-[11px] uppercase tracking-wider text-slate-500">{s.label}</p>
                <p data-testid={`winback-stat-${s.k}`} className="mt-1 font-heading text-2xl font-bold text-white">
                  {s.v}
                </p>
              </div>
            ))}
          </div>
          {data.total === 0 ? (
            <p data-testid="winback-results-empty" className="mt-4 text-sm text-slate-500">
              No win-back calls marked yet. Use the Reached / Ordered / No interest buttons on the Win-back list.
            </p>
          ) : (
            <div className="mt-5 grid grid-cols-1 gap-6 lg:grid-cols-2">
              <div className="h-[220px]" data-testid="winback-results-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={data.months ?? []}
                    margin={{ top: 8, right: 8, left: -20, bottom: 0 }}
                    className="cursor-pointer"
                    onClick={(e) => {
                      const p = (data.months ?? [])[chartIndex(e) ?? -1];
                      if (p) drill({ title: `Win-back calls: ${MONTH_LONG(p.month)}`, subtitle: `${p.reached} reached · ${p.ordered} ordered · ${p.no_interest} no interest`, query: { ...(repId ? { rep_id: repId } : {}), winback_month: p.month } });
                    }}
                  >
                    <CartesianGrid stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="month" tickFormatter={monthLabel} tick={axisTick} axisLine={false} tickLine={false} />
                    <YAxis allowDecimals={false} tick={axisTick} axisLine={false} tickLine={false} />
                    <Tooltip
                      cursor={{ fill: CHART.cursor }}
                      contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
                      labelStyle={{ color: "var(--popover-foreground)" }}
                      labelFormatter={(l) => monthLabel(String(l))}
                    />
                    <Legend formatter={(v) => <span className="text-xs text-slate-400">{v}</span>} />
                    {OUTCOMES.map((o) => (
                      <Bar key={o.id} dataKey={o.id} name={o.label} stackId="a" fill={o.color} maxBarSize={56} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="max-h-[220px] divide-y divide-border overflow-y-auto pr-1" data-testid="winback-results-recent">
                {(data.recent ?? []).map((m, i) => (
                  <div key={m.id} data-testid={`winback-recent-${i}`} className="flex items-center gap-3 py-2 text-sm">
                    <span className={cn("w-24 shrink-0 rounded border px-1.5 py-0.5 text-center font-mono text-[10px] uppercase", OUTCOMES.find((o) => o.id === m.outcome)?.cls)}>
                      {LABEL[m.outcome]}
                    </span>
                    <Link to={`/customers/${encodeURIComponent(m.customer_key)}`} className="min-w-0 flex-1 truncate text-white hover:underline">
                      {m.customer_name}
                    </Link>
                    {m.confirmed && (
                      <Link
                        to={`/calls/${m.confirmed_call_id}`}
                        data-testid={`winback-confirmed-${i}`}
                        className="flex items-center gap-1 font-mono text-[11px] text-emerald-300 hover:underline"
                      >
                        <CheckCircle2 className="size-3.5" /> {fmtMoney(m.confirmed_value)}
                      </Link>
                    )}
                    <span className="hidden w-28 text-right font-mono text-[11px] text-slate-500 sm:block">
                      {m.rep_name.split(" ")[0]} · {fmtDate(m.created_at)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
