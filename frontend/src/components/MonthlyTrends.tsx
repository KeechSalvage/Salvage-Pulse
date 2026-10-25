import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Overline, Panel, fmtMoney } from "@/components/common";
import { apiGet } from "@/lib/api";
import { lotQS } from "@/lib/lot";
import { cn } from "@/lib/utils";
import { CHART, axisTick } from "@/lib/chartColors";
import type { MonthPoint, MonthlyTrends } from "@/lib/types";
import { MONTH_LONG, chartIndex, useDrill } from "@/components/CallsDrill";

type Metric = "calls" | "close_rate" | "est_value";

const METRICS: { id: Metric; label: string; color: string; fmt: (v: number) => string }[] = [
  { id: "calls", label: "Calls", color: CHART.brand, fmt: (v) => v.toLocaleString() },
  { id: "close_rate", label: "Close rate", color: CHART.silver, fmt: (v) => `${v}%` },
  { id: "est_value", label: "Account value", color: "#34D399", fmt: (v) => fmtMoney(v) },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`;

function Change({ cur, prev, metric }: { cur: MonthPoint; prev?: MonthPoint; metric: Metric }) {
  if (!prev) return <span className="font-mono text-[11px] text-slate-500">no prior month</span>;
  const diff = cur[metric] - prev[metric];
  const pct = metric === "close_rate" ? `${diff > 0 ? "+" : ""}${diff.toFixed(1)} pts` : prev[metric] ? `${diff > 0 ? "+" : ""}${Math.round((100 * diff) / prev[metric])}%` : "new";
  const Icon = diff > 0 ? ArrowUpRight : diff < 0 ? ArrowDownRight : Minus;
  return (
    <span className={cn("inline-flex items-center gap-0.5 font-mono text-[11px]", diff > 0 ? "text-emerald-300" : diff < 0 ? "text-red-300" : "text-slate-400")}>
      <Icon className="size-3" />
      {pct} vs {monthLabel(prev.month)}
    </span>
  );
}

export default function MonthlyTrendsPanel({ repId, testId = "monthly-trends-panel", lot = "" }: { repId?: string; testId?: string; lot?: string }) {
  const drill = useDrill();
  const [metric, setMetric] = useState<Metric>("calls");
  const { data, isError } = useQuery({
    queryKey: ["monthly", repId ?? "default", lot],
    queryFn: () => apiGet<MonthlyTrends>(`/analytics/monthly${repId ? `?rep_id=${repId}` : lotQS(lot)}`),
  });
  const months = isError ? [] : (data?.months ?? []);
  const cur = months[months.length - 1];
  const prev = months.slice(0, -1).findLast((p) => p.calls > 0); // compare with the last month that has data
  const m = METRICS.find((x) => x.id === metric)!;

  return (
    <Panel className="xl:col-span-12" testId={testId}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Overline>Month over month</Overline>
          <h3 className="mt-1 text-xl font-bold text-white">Monthly trends</h3>
        </div>
        <div className="flex gap-1 rounded-lg bg-surface p-1">
          {METRICS.map((x) => (
            <button
              key={x.id}
              data-testid={`monthly-metric-${x.id}`}
              onClick={() => setMetric(x.id)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors duration-150",
                metric === x.id ? "bg-amber-500 text-primary-foreground" : "text-slate-400 hover:text-white",
              )}
            >
              {x.label}
            </button>
          ))}
        </div>
      </div>

      {cur && (
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid="monthly-summary">
          {METRICS.map((x) => (
            <button
              key={x.id}
              onClick={() => setMetric(x.id)}
              data-testid={`monthly-card-${x.id}`}
              className={cn(
                "rounded-lg border bg-surface p-3 text-left transition-colors duration-150",
                metric === x.id ? "border-amber-500/50" : "border-border hover:border-slate-600",
              )}
            >
              <p className="font-mono text-[11px] uppercase tracking-wider text-slate-500">
                {x.label} · {monthLabel(cur.month)}
              </p>
              <p data-testid={`monthly-value-${x.id}`} className="mt-1 font-heading text-2xl font-bold text-white">
                {x.fmt(cur[x.id])}
              </p>
              <Change cur={cur} prev={prev} metric={x.id} />
            </button>
          ))}
        </div>
      )}

      {months.length > 0 && (
        <div className="mt-5 h-[240px]" data-testid="monthly-chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={months}
              margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
              className="cursor-pointer"
              onClick={(e) => {
                const p = months[chartIndex(e) ?? -1];
                if (!p) return;
                const all = metric === "calls";
                drill({
                  title: `${MONTH_LONG(p.month)}: ${all ? "all calls" : metric === "est_value" ? "won orders" : "sales calls"}`,
                  subtitle: all ? undefined : `${p.won} won of ${p.sales_calls}`,
                  query: { ...(repId ? { rep_id: repId } : {}), month: p.month, ...(all ? {} : { outcome: metric === "est_value" ? "won" : "sales" }) },
                });
              }}
            >
              <CartesianGrid stroke="var(--border)" vertical={false} />
              <XAxis dataKey="month" tickFormatter={monthLabel} tick={axisTick} axisLine={false} tickLine={false} />
              <YAxis
                width={56}
                domain={metric === "close_rate" ? [0, 100] : [0, "auto"]}
                tickFormatter={(v: number) => (metric === "est_value" ? `$${v >= 1000 ? `${Math.round(v / 1000)}k` : v}` : metric === "close_rate" ? `${v}%` : String(v))}
                tick={axisTick}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                cursor={{ fill: CHART.cursor }}
                contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: "var(--popover-foreground)" }}
                itemStyle={{ color: "var(--muted-foreground)" }}
                labelFormatter={(l) => monthLabel(String(l))}
                formatter={(v, _n, item) => {
                  const p = item.payload as MonthPoint;
                  const extra = metric === "close_rate" ? ` (${p.won} of ${p.sales_calls})` : metric === "est_value" ? ` · ${p.won} orders` : "";
                  return [`${m.fmt(Number(v))}${extra}`, m.label];
                }}
              />
              <Bar dataKey={metric} radius={[4, 4, 0, 0]} maxBarSize={64}>
                {months.map((p) => (
                  <Cell key={p.month} fill={m.color} fillOpacity={p === cur ? 1 : 0.5} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {data && months.length < 2 && (
        <p data-testid="monthly-needs-history" className="mt-3 text-sm text-slate-500">
          Only {months.length ? "one month" : "no months"} of calls loaded so far.{" "}
          <Link to="/upload" className="text-sky-400 hover:underline">
            Import an older RingCentral export
          </Link>{" "}
          to compare month over month.
        </p>
      )}
      {data && (
        <p className="mt-2 text-xs text-slate-500">
          Account value = orders won that month, valued from AI-scored calls or the {fmtMoney(data.avg_order_value)} average order.
        </p>
      )}
      {isError && <p className="mt-4 text-sm text-slate-500">Monthly trends unavailable.</p>}
    </Panel>
  );
}
