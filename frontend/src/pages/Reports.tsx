import { useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Download, Mail, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Overline, PageHeader, Panel, StatCard, fmtDuration, fmtMoney } from "@/components/common";
import TileGrid from "@/components/TileGrid";
import ArrivalProfit from "@/components/ArrivalProfit";
import PartsSoldRanking from "@/components/PartsSoldRanking";
import ReportEmailSettings from "@/components/ReportEmailSettings";
import { CircleDollarSign } from "lucide-react";
import { chartIndex, useDrill } from "@/components/CallsDrill";
import { CHART, axisTick } from "@/lib/chartColors";
import { apiGet, apiPost, errorMessage } from "@/lib/api";
import { useMe } from "@/lib/hooks";
import { SiteFilter } from "@/components/Sites";
import { cn } from "@/lib/utils";
import type { DrillQuery, MonthlyReportResult, Report, ReportCount } from "@/lib/types";
import { isManagerLike } from "@/lib/types";

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

const PRESETS: { id: string; label: string; range: () => [string, string] }[] = [
  { id: "this-month", label: "This month", range: () => { const n = new Date(); return [iso(new Date(n.getFullYear(), n.getMonth(), 1)), iso(n)]; } },
  { id: "last-month", label: "Last month", range: () => { const n = new Date(); return [iso(new Date(n.getFullYear(), n.getMonth() - 1, 1)), iso(new Date(n.getFullYear(), n.getMonth(), 0))]; } },
  { id: "30d", label: "Last 30 days", range: () => [iso(daysAgo(29)), iso(new Date())] },
  { id: "90d", label: "Last 90 days", range: () => [iso(daysAgo(89)), iso(new Date())] },
  { id: "ytd", label: "This year", range: () => [iso(new Date(new Date().getFullYear(), 0, 1)), iso(new Date())] },
];

const csvCell = (v: unknown) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function downloadCsv(r: Report) {
  const rows: unknown[][] = [
    ["Salvage Pulse report", `${r.date_from} to ${r.date_to}`],
    [],
    ["Totals"], ["Calls", "Inbound", "Outbound", "Voicemails", "Avg score", "Avg length (s)", "Sales calls", "Won", "Close rate %", "Sales $"],
    [r.totals.calls, r.totals.inbound, r.totals.outbound, r.totals.voicemails, r.totals.avg_score, r.totals.avg_duration_sec, r.totals.sales_calls, r.totals.won, r.totals.close_rate, r.totals.revenue],
    [],
    ["Reps"], ["Rep", "Calls", "Avg score", "Sales calls", "Won", "Close rate %", "Sales $"],
    ...r.by_rep.map((x) => [x.name, x.calls, x.avg_score, x.sales_calls, x.won, x.close_rate, x.revenue]),
    [],
    ["Call categories"], ["Category", "Calls"], ...r.by_category.map((x) => [x.label, x.calls]),
    [],
    ["Top parts"], ["Part", "Calls", "Won"], ...r.top_parts.map((x) => [x.label, x.calls, x.won]),
    [],
    ["Top vehicles"], ["Vehicle", "Calls", "Won"], ...r.top_vehicles.map((x) => [x.label, x.calls, x.won]),
    [],
    ["Daily"], ["Date", "Calls", "Won"], ...r.daily.map((x) => [x.date, x.calls, x.won]),
    ...(r.arrivals.length
      ? [[], ["Vehicle arrivals"], ["Vehicle", "Logged", "Paid", "Brought in", "Profit", "Sold", "Orders"], ...r.arrivals.map((a) => [a.vehicle, a.logged.slice(0, 10), a.cost ?? "", a.revenue, a.profit, a.sold, a.orders])]
      : []),
  ];
  const blob = new Blob([rows.map((row) => row.map(csvCell).join(",")).join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `salvage-pulse-report-${r.date_from}-to-${r.date_to}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function CountList({ rows, testId, onPick, showWon = true }: { rows: ReportCount[]; testId: string; onPick: (r: ReportCount) => void; showWon?: boolean }) {
  const max = Math.max(1, ...rows.map((r) => r.calls));
  if (!rows.length) return <p className="text-sm text-slate-500">Nothing in this range.</p>;
  return (
    <div className="space-y-2" data-testid={testId}>
      {rows.map((r) => (
        <button key={r.key || r.label} type="button" data-testid={`${testId}-${(r.key || r.label).replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`} onClick={() => onPick(r)} className="block w-full rounded px-1 py-0.5 text-left transition-colors duration-150 hover:bg-slate-800/50">
          <div className="flex justify-between text-sm">
            <span className="text-slate-200">{r.label}</span>
            <span className="font-mono text-xs text-slate-400">{r.calls}{showWon ? ` · ${r.won} won` : ""}</span>
          </div>
          <div className="mt-1 h-1 rounded-full bg-slate-800">
            <div className="h-full rounded-full bg-sky-500/80 transition-[width] duration-500" style={{ width: `${(r.calls / max) * 100}%` }} />
          </div>
        </button>
      ))}
    </div>
  );
}

export default function Reports() {
  const { data: me } = useMe();

  if (me?.role === "inventory_manager") {
    return <Navigate to="/vehicles" replace />;
  }

  const isManager = isManagerLike(me?.role);
  const drill = useDrill();
  const [preset, setPreset] = useState("this-month");
  const [siteId, setSiteId] = useState("");
  const [custom, setCustom] = useState<[string, string]>(PRESETS[0].range());
  const [from, to] = useMemo(() => (preset === "custom" ? custom : PRESETS.find((p) => p.id === preset)!.range()), [preset, custom]);
  const { data: r, isError, isFetching } = useQuery({
    queryKey: ["report", from, to, siteId],
    queryFn: () => apiGet<Report>(`/reports/summary?date_from=${from}&date_to=${to}${siteId ? `&site_id=${siteId}` : ""}`),
    enabled: !!from && !!to && from <= to,
  });
  const range: DrillQuery = { from_day: from, to_day: to };
  const emailMe = useMutation({
    mutationFn: () => apiPost<MonthlyReportResult>("/reports/email-me"),
    onSuccess: (x) => toast.success(`Sent your ${x.month} report to ${me?.email}`),
    onError: (e) => toast.error(errorMessage(e, "Couldn't send the email")),
  });
  const t = r?.totals;

  const tiles = [
    {
      id: "daily", label: "Calls by day", span: "xl:col-span-12", node: (
        <Panel testId="report-daily-panel">
          <Overline>Volume</Overline>
          <h3 className="mb-4 mt-1 text-xl font-bold text-white">Calls by day</h3>
          <div className="h-[240px] cursor-pointer" data-testid="report-daily-chart">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={r?.daily ?? []}
                margin={{ top: 8, right: 8, left: -20, bottom: 0 }}
                onClick={(e) => {
                  const d = r?.daily[chartIndex(e) ?? -1];
                  if (d) drill({ title: `Calls on ${new Date(`${d.date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}`, subtitle: `${d.won} won`, query: { local_date: d.date } });
                }}
              >
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(5)} tick={axisTick} axisLine={false} tickLine={false} />
                <YAxis allowDecimals={false} tick={axisTick} axisLine={false} tickLine={false} />
                <Tooltip cursor={{ fill: CHART.cursor }} contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} />
                <Bar dataKey="calls" name="Calls" fill={CHART.brand} radius={[3, 3, 0, 0]} />
                <Bar dataKey="won" name="Won" fill={CHART.good} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      ),
    },
    ...(isManager
      ? [{
          id: "reps", label: "Reps", span: "xl:col-span-12", node: (
            <Panel testId="report-reps-panel">
              <Overline>Team</Overline>
              <h3 className="mb-4 mt-1 text-xl font-bold text-white">Rep results</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="font-mono text-[11px] uppercase tracking-wider text-slate-500">
                    <tr>{["Rep", "Calls", "Avg score", "Sales calls", "Won", "Close rate", "Sales"].map((h) => <th key={h} className="py-2 pr-3 text-left font-normal">{h}</th>)}</tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {(r?.by_rep ?? []).map((x) => (
                      <tr key={x.rep_id} data-testid={`report-rep-${x.rep_id}`} className="cursor-pointer transition-colors duration-150 hover:bg-slate-800/40" onClick={() => drill({ title: `${x.name}: calls`, query: { ...range, rep_id: x.rep_id } })}>
                        <td className="py-2 pr-3 text-white">{x.name}</td>
                        <td className="pr-3 font-mono">{x.calls}</td>
                        <td className="pr-3 font-mono">{x.avg_score}</td>
                        <td className="pr-3 font-mono">{x.sales_calls}</td>
                        <td className="pr-3 font-mono text-emerald-300">{x.won}</td>
                        <td className="pr-3 font-mono">{x.close_rate}%</td>
                        <td className="pr-3 font-mono">{fmtMoney(x.revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          ),
        }]
      : []),
    {
      id: "categories", label: "Call categories", span: "xl:col-span-4", node: (
        <Panel testId="report-categories-panel">
          <Overline>Call mix</Overline>
          <h3 className="mb-4 mt-1 text-xl font-bold text-white">Categories</h3>
          <CountList rows={r?.by_category ?? []} testId="report-category" showWon={false} onPick={(x) => drill({ title: `${x.label} calls`, query: { ...range, category: x.label } })} />
        </Panel>
      ),
    },
    {
      id: "parts", label: "Top parts", span: "xl:col-span-4", node: (
        <Panel testId="report-parts-panel">
          <Overline>Parts</Overline>
          <h3 className="mb-4 mt-1 text-xl font-bold text-white">Most asked-for parts</h3>
          <CountList rows={r?.top_parts ?? []} testId="report-part" onPick={(x) => drill({ title: `Calls about ${x.label.toLowerCase()}s`, query: { ...range, part: x.key } })} />
        </Panel>
      ),
    },
    {
      id: "vehicles", label: "Top vehicles", span: "xl:col-span-4", node: (
        <Panel testId="report-vehicles-panel">
          <Overline>Vehicles</Overline>
          <h3 className="mb-4 mt-1 text-xl font-bold text-white">Most asked-about vehicles</h3>
          <CountList
            rows={r?.top_vehicles ?? []}
            testId="report-vehicle"
            onPick={(x) => {
              const [make, model] = x.key.split("|");
              drill({ title: `${x.label} calls`, query: { ...range, vehicle_make: make, ...(model ? { vehicle_model: model } : {}) } });
            }}
          />
        </Panel>
      ),
    },
    { id: "parts-sold", label: "Parts sold", span: "xl:col-span-12", node: <PartsSoldRanking months={r?.parts_sold ?? []} /> },
    ...(isManager
      ? [{
          id: "arrivals", label: "Vehicle profit", span: "xl:col-span-12", node: <ArrivalProfit arrivals={r?.arrivals ?? []} />,
        }]
      : []),
  ];

  return (
    <>
      <PageHeader overline="Reports" title={isManager ? "Yard report" : "My report"}>
        <div className="flex gap-2 print:hidden">
          {isManager && <ReportEmailSettings />}
          <Button variant="outline" data-testid="report-email-me" disabled={emailMe.isPending} onClick={() => emailMe.mutate()} title="The same report everyone gets by email on the 1st of each month">
            <Mail className="size-4" /> Email me last month
          </Button>
          <Button variant="outline" data-testid="report-print" onClick={() => window.print()}><Printer className="size-4" /> Print</Button>
          <Button data-testid="report-download-csv" disabled={!r} onClick={() => r && downloadCsv(r)}><Download className="size-4" /> Download CSV</Button>
        </div>
      </PageHeader>
      <div className="mb-6 flex flex-wrap items-center gap-2 print:hidden" data-testid="report-range">
        {PRESETS.map((p) => (
          <button key={p.id} type="button" data-testid={`report-preset-${p.id}`} onClick={() => setPreset(p.id)} className={cn("rounded-full border px-3 py-1 text-xs transition-colors duration-150", preset === p.id ? "border-sky-500 bg-sky-500/15 text-white" : "border-border text-slate-400 hover:text-white")}>
            {p.label}
          </button>
        ))}
        <button type="button" data-testid="report-preset-custom" onClick={() => (setCustom([from, to]), setPreset("custom"))} className={cn("rounded-full border px-3 py-1 text-xs transition-colors duration-150", preset === "custom" ? "border-sky-500 bg-sky-500/15 text-white" : "border-border text-slate-400 hover:text-white")}>
          Custom
        </button>
        {isManager && <SiteFilter value={siteId} onChange={setSiteId} testId="report-site-filter" />}
        {preset === "custom" && (
          <span className="flex items-center gap-2">
            <Input type="date" data-testid="report-from" value={custom[0]} onChange={(e) => setCustom([e.target.value, custom[1]])} className="h-8 w-40" />
            <span className="text-slate-500">to</span>
            <Input type="date" data-testid="report-to" value={custom[1]} onChange={(e) => setCustom([custom[0], e.target.value])} className="h-8 w-40" />
          </span>
        )}
        <span className="ml-auto font-mono text-xs text-slate-500" data-testid="report-range-label">{from} → {to}{isFetching ? " · loading…" : ""}</span>
      </div>
      {isError && <p className="mb-4 text-sm text-red-300">Couldn't build this report — check the dates.</p>}
      <div id="report-summary-stats" className="grid grid-cols-2 gap-4 lg:grid-cols-5 scroll-mt-6">
        <StatCard label="Calls" value={t?.calls ?? "—"} sub={t ? `${t.inbound} in · ${t.outbound} out · ${t.voicemails} vm` : ""} testId="report-stat-calls" />
        <StatCard label="Avg QA score" value={t?.avg_score ?? "—"} sub={t ? `avg ${fmtDuration(t.avg_duration_sec)} per call` : ""} testId="report-stat-score" accent />
        <StatCard label="Sales calls" value={t?.sales_calls ?? "—"} sub={t ? `${t.won} won` : ""} testId="report-stat-sales" />
        <StatCard label="Close rate" value={t ? `${t.close_rate}%` : "—"} testId="report-stat-close" />
        <StatCard label="Sales" value={t ? fmtMoney(t.revenue) : "—"} sub={r ? `avg order ${fmtMoney(r.avg_order_value)}` : ""} testId="report-stat-revenue" />
      </div>
      {!!r?.price_missing && (
        <button type="button" data-testid="report-price-missing" onClick={() => drill({ title: "Sales missing a price", subtitle: "Open each call and add what the parts sold for", query: { ...range, price_missing: true } })}
          className="mb-6 flex w-full items-center gap-3 rounded-xl border border-amber-500/40 bg-amber-500/[0.05] px-4 py-3 text-left transition-colors duration-150 hover:border-amber-500/70 print:hidden">
          <CircleDollarSign className="size-5 text-amber-300" />
          <span className="text-sm text-white"><strong data-testid="report-price-missing-count">{r.price_missing}</strong> sale{r.price_missing === 1 ? "" : "s"} in this range {r.price_missing === 1 ? "has" : "have"} no price — sales totals use the average order (${Math.round(r.avg_order_value)}) for {r.price_missing === 1 ? "it" : "them"}.</span>
          <span className="ml-auto text-xs text-amber-300">Fix them →</span>
        </button>
      )}
      <TileGrid page="reports" label="report sections" className="mt-2 grid grid-cols-1 gap-6 xl:grid-cols-12" tiles={tiles} />
    </>
  );
}
