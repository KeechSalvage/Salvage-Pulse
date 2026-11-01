import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Overline, Panel } from "@/components/common";
import { monthLabel } from "@/components/MonthlyTrends";
import { apiGet } from "@/lib/api";
import { lotQS } from "@/lib/lot";
import { cn } from "@/lib/utils";
import { CHART, axisTick, SERIES } from "@/lib/chartColors";
import type { RepMonthly } from "@/lib/types";
import { MONTH_LONG, chartIndex, useDrill } from "@/components/CallsDrill";

const COLORS = SERIES;

export function ChangeBadge({ change, testId }: { change: number | null; testId?: string }) {
  if (change === null) return <span data-testid={testId} className="font-mono text-[11px] text-slate-500">first month</span>;
  const Icon = change > 0 ? ArrowUpRight : change < 0 ? ArrowDownRight : Minus;
  return (
    <span
      data-testid={testId}
      className={cn(
        "inline-flex items-center gap-0.5 rounded border px-1.5 py-0.5 font-mono text-[11px]",
        change > 0 ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : change < 0 ? "border-red-500/40 bg-red-500/10 text-red-300" : "border-slate-700 text-slate-400",
      )}
    >
      <Icon className="size-3" />
      {change > 0 ? "+" : ""}
      {change.toFixed(1)} pts
    </span>
  );
}

export default function RepTrendsPanel({ testId = "rep-trends-panel", className = "xl:col-span-12", lot = "" }: { testId?: string; className?: string; lot?: string }) {
  const [focus, setFocus] = useState<string | null>(null);
  const drill = useDrill();
  const { data, isError } = useQuery({ queryKey: ["monthly", "reps", lot], queryFn: () => apiGet<RepMonthly>(`/analytics/monthly/reps${lotQS(lot)}`) });
  const months = data?.months ?? [];
  const rows = months.map((m, i) => {
    const row: Record<string, string | number | null> = { month: m };
    for (const r of data?.reps ?? []) {
      const pt = r.points?.[i];
      row[r.rep_id] = pt && pt.sales_calls ? pt.close_rate : null;
    }
    return row;
  });
  const color = (id: string) => COLORS[((data?.reps ?? []).findIndex((r) => r.rep_id === id) ?? 0) % COLORS.length];
  const name = (id: string) => (data?.reps ?? []).find((r) => r.rep_id === id)?.rep_name ?? id;

  return (
    <Panel className={className} testId={testId}>
      <Overline>Rep comparison</Overline>
      <h3 className="mt-1 text-xl font-bold text-white">Close rate by month, rep by rep</h3>
      <p className="mt-1 text-sm text-slate-400">Sorted by who improved most since their previous month. Hover a rep to highlight their line.</p>

      {isError && <p className="mt-4 text-sm text-slate-500">Rep comparison unavailable.</p>}
      {data && (data.reps ?? []).length === 0 && <p className="mt-4 text-sm text-slate-500">No sales calls yet.</p>}

      {data && (data.reps ?? []).length > 0 && (
        <div className="mt-5 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_minmax(0,1.1fr)]">
          <div className="h-[260px]" data-testid={`${testId}-chart`}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={rows}
                margin={{ top: 8, right: 12, left: -16, bottom: 0 }}
                className="cursor-pointer"
                onClick={(e) => {
                  const month = data.months[chartIndex(e) ?? -1];
                  if (month) drill({ title: `Sales calls: ${MONTH_LONG(month)}${focus ? ` · ${name(focus)}` : ""}`, query: { month, outcome: "sales", ...(focus ? { rep_id: focus } : {}) } });
                }}
              >
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="month" tickFormatter={monthLabel} tick={axisTick} axisLine={false} tickLine={false} />
                <YAxis domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} tick={axisTick} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: "var(--popover-foreground)" }}
                  labelFormatter={(l) => monthLabel(String(l))}
                  formatter={(v, n) => [`${v}%`, name(String(n))]}
                />
                <Legend formatter={(v) => <span className="text-xs text-slate-400">{name(String(v))}</span>} />
                {data.reps.map((r) => (
                  <Line
                    key={r.rep_id}
                    dataKey={r.rep_id}
                    stroke={color(r.rep_id)}
                    strokeWidth={focus === r.rep_id ? 3.5 : 2}
                    strokeOpacity={focus && focus !== r.rep_id ? 0.2 : 1}
                    dot={{ r: 3, fill: color(r.rep_id) }}
                    connectNulls
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid={`${testId}-table`}>
              <thead>
                <tr className="border-b border-border font-mono text-[11px] uppercase tracking-wider text-slate-500">
                  <th className="py-2 text-left font-normal">Rep</th>
                  {months.slice(-4).map((m) => (
                    <th key={m} className="py-2 text-right font-normal">
                      {monthLabel(m)}
                    </th>
                  ))}
                  <th className="py-2 text-right font-normal">Change</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.reps.map((r, i) => (
                  <tr
                    key={r.rep_id}
                    data-testid={`${testId}-row-${i}`}
                    onMouseEnter={() => setFocus(r.rep_id)}
                    onMouseLeave={() => setFocus(null)}
                    className={cn("transition-colors duration-150", focus === r.rep_id && "bg-slate-800/40")}
                  >
                    <td className="py-2.5">
                      <Link to={`/reps/${r.rep_id}`} className="flex items-center gap-2 font-medium text-white hover:underline">
                        <span className="size-2.5 rounded-full" style={{ background: color(r.rep_id) }} />
                        {r.rep_name}
                      </Link>
                    </td>
                    {r.points.slice(-4).map((p) => (
                      <td key={p.month} className="py-2.5 text-right font-mono text-slate-200" title={`${p.won} won of ${p.sales_calls} sales calls`}>
                        {p.sales_calls ? `${p.close_rate}%` : <span className="text-slate-600">—</span>}
                      </td>
                    ))}
                    <td className="py-2.5 text-right">
                      <ChangeBadge change={r.change} testId={`${testId}-change-${i}`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {months.length < 2 && (
              <p data-testid={`${testId}-needs-history`} className="mt-3 text-xs text-slate-500">
                Only one month loaded. <Link to="/upload" className="text-sky-400 hover:underline">Import older call history</Link> to see who is improving.
              </p>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}
