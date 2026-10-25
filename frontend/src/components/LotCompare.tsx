import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { GitCompareArrows } from "lucide-react";
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Overline, Panel, fmtMoney } from "@/components/common";
import { useSites } from "@/components/Sites";
import { apiGet } from "@/lib/api";
import { lotQS } from "@/lib/lot";
import { CHART, SERIES, axisTick } from "@/lib/chartColors";
import { MONTH_LONG } from "@/components/CallsDrill";
import type { MonthlyTrends } from "@/lib/types";

const sel = "h-8 rounded-md border border-border bg-card px-2 text-sm text-white transition-colors duration-150 hover:border-sky-500/60";
const short = (m: string) => MONTH_LONG(m).split(" ")[0].slice(0, 3) + " " + m.slice(2, 4);

/** Team Dashboard (whole-yard managers, 2+ lots): two lots' monthly sales (bars) and close rate (lines) on one chart. */
export default function LotCompare() {
  const { data: sl } = useSites();
  const sites = sl?.sites ?? [];
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const left = a || sites[0]?.id || "";
  const right = b || sites.find((s) => s.id !== left)?.id || "";
  const on = sites.length >= 2 && !sl?.my_site_id;
  const qa = useQuery({ queryKey: ["monthly", "default", left], queryFn: () => apiGet<MonthlyTrends>(`/analytics/monthly${lotQS(left)}`), enabled: on && !!left });
  const qb = useQuery({ queryKey: ["monthly", "default", right], queryFn: () => apiGet<MonthlyTrends>(`/analytics/monthly${lotQS(right)}`), enabled: on && !!right });
  if (!on) return null;
  const nameOf = (id: string) => sites.find((s) => s.id === id)?.name ?? "";
  const months = [...new Set([...(qa.data?.months ?? []), ...(qb.data?.months ?? [])].map((p) => p.month))].sort().slice(-6);
  const pick = (d: MonthlyTrends | undefined, m: string) => d?.months.find((p) => p.month === m);
  const rows = months.map((m) => ({
    month: short(m),
    salesA: pick(qa.data, m)?.est_value ?? 0,
    salesB: pick(qb.data, m)?.est_value ?? 0,
    closeA: pick(qa.data, m)?.close_rate ?? 0,
    closeB: pick(qb.data, m)?.close_rate ?? 0,
  }));
  const last = rows.at(-1);
  const lead = last && last.salesA !== last.salesB ? (last.salesA > last.salesB ? nameOf(left) : nameOf(right)) : "";
  const labels: Record<string, string> = { salesA: `${nameOf(left)} sales`, salesB: `${nameOf(right)} sales`, closeA: `${nameOf(left)} close %`, closeB: `${nameOf(right)} close %` };
  return (
    <Panel testId="lot-compare-panel" className="mb-6">
      <div className="flex flex-wrap items-center gap-3">
        <GitCompareArrows className="size-4 text-sky-300" />
        <div className="mr-auto">
          <Overline>Lot vs lot</Overline>
          <h3 className="mt-1 text-xl font-bold text-white">Which lot is pulling ahead</h3>
        </div>
        <select aria-label="First lot" data-testid="lot-compare-a" value={left} onChange={(e) => setA(e.target.value)} className={sel}>
          {sites.map((s) => <option key={s.id} value={s.id} disabled={s.id === right}>{s.name}</option>)}
        </select>
        <span className="font-mono text-xs text-slate-500">vs</span>
        <select aria-label="Second lot" data-testid="lot-compare-b" value={right} onChange={(e) => setB(e.target.value)} className={sel}>
          {sites.map((s) => <option key={s.id} value={s.id} disabled={s.id === left}>{s.name}</option>)}
        </select>
      </div>
      {last && (
        <p data-testid="lot-compare-summary" className="mt-3 text-sm text-slate-300">
          This month: <span className="font-semibold text-white">{nameOf(left)}</span> {fmtMoney(last.salesA)} · {last.closeA}% close, vs{" "}
          <span className="font-semibold text-white">{nameOf(right)}</span> {fmtMoney(last.salesB)} · {last.closeB}% close
          {lead && <span className="ml-2 rounded-full bg-amber-500/15 px-2 py-0.5 font-mono text-[11px] text-amber-200">{lead} leads on sales</span>}
        </p>
      )}
      <div className="mt-4 h-72" data-testid="lot-compare-chart">
        {qa.isLoading || qb.isLoading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : !rows.length ? (
          <p data-testid="lot-compare-empty" className="text-sm text-slate-500">No calls at these lots yet.</p>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="month" tick={axisTick} tickLine={false} axisLine={false} />
              <YAxis yAxisId="usd" tick={axisTick} tickLine={false} axisLine={false} tickFormatter={(v: number) => `$${Math.round(v / 1000)}k`} width={44} />
              <YAxis yAxisId="pct" orientation="right" tick={axisTick} tickLine={false} axisLine={false} domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} width={40} />
              <Tooltip cursor={{ fill: CHART.cursor }} contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8 }}
                formatter={(v, k) => [String(k).startsWith("sales") ? fmtMoney(Number(v)) : `${v}%`, labels[String(k)] ?? String(k)]} />
              <Legend formatter={(v) => <span className="text-xs text-slate-400">{labels[String(v)] ?? String(v)}</span>} />
              <Bar yAxisId="usd" dataKey="salesA" fill={SERIES[0]} radius={[4, 4, 0, 0]} maxBarSize={28} />
              <Bar yAxisId="usd" dataKey="salesB" fill={SERIES[1]} radius={[4, 4, 0, 0]} maxBarSize={28} />
              <Line yAxisId="pct" dataKey="closeA" stroke={SERIES[2]} strokeWidth={2.5} dot={{ r: 3 }} />
              <Line yAxisId="pct" dataKey="closeB" stroke={SERIES[3]} strokeWidth={2.5} strokeDasharray="5 3" dot={{ r: 3 }} />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
      <p className="mt-2 text-xs text-slate-500">Bars: estimated sales per month. Lines: close rate. A call counts for the lot its rep worked at when it happened.</p>
    </Panel>
  );
}
