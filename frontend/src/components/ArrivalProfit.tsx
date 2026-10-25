import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Pencil } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Overline, Panel, fmtMoney } from "@/components/common";
import { CHART, axisTick } from "@/lib/chartColors";
import { apiPatch, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Arrival, ArrivalCostUpdate, ReportArrival } from "@/lib/types";

const signed = (v: number) => `${v >= 0 ? "+" : "−"}${fmtMoney(Math.abs(v))}`;

/** Paid cost, editable any time (blank clears it — missing cost counts as $0). */
function CostCell({ a }: { a: ReportArrival }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(a.cost != null ? String(a.cost) : "");
  const save = useMutation({
    mutationFn: () => apiPatch<Arrival>(`/arrivals/${a.id}/cost`, { cost: val.trim() ? Number(val) : null } satisfies ArrivalCostUpdate),
    onSuccess: () => {
      toast.success(val.trim() ? `Cost saved: ${fmtMoney(Number(val))}` : "Cost cleared");
      setEditing(false);
      qc.invalidateQueries({ queryKey: ["report"] });
      qc.invalidateQueries({ queryKey: ["arrivals"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!editing)
    return (
      <button type="button" data-testid={`report-arrival-cost-edit-${a.id}`} onClick={() => setEditing(true)} className={cn("group inline-flex items-center gap-1.5 font-mono", a.cost == null && "text-amber-300")}>
        {a.cost != null ? fmtMoney(a.cost) : "add cost"}
        <Pencil className="size-3 opacity-40 transition-opacity duration-150 group-hover:opacity-100" />
      </button>
    );
  const bad = !!val.trim() && (!Number.isFinite(Number(val)) || Number(val) < 0);
  return (
    <form className="flex items-center gap-1" onSubmit={(e) => (e.preventDefault(), !bad && save.mutate())}>
      <Input autoFocus data-testid={`report-arrival-cost-input-${a.id}`} inputMode="decimal" value={val} onChange={(e) => setVal(e.target.value.replace(/[^0-9.]/g, ""))} className={cn("h-7 w-24", bad && "border-red-500")} placeholder="$ paid" />
      <Button size="sm" type="submit" data-testid={`report-arrival-cost-save-${a.id}`} disabled={bad || save.isPending} className="h-7">Save</Button>
    </form>
  );
}

export default function ArrivalProfit({ arrivals }: { arrivals: ReportArrival[] }) {
  const ranked = [...arrivals].sort((x, y) => y.profit - x.profit);
  const missing = arrivals.filter((a) => a.cost == null).length;
  const chart = ranked.slice(0, 15).map((a) => ({ name: a.vehicle, profit: a.profit }));
  return (
    <Panel testId="report-arrivals-panel">
      <Overline>Vehicle arrivals</Overline>
      <h3 className="mb-1 mt-1 text-xl font-bold text-white">Which vehicles made or lost money</h3>
      <p className="mb-4 text-xs text-slate-500">
        Vehicles logged in this range, ranked by profit: sales from their callers minus what you paid. A missing cost counts as $0
        {missing ? ` (${missing} still need a cost — tap "add cost")` : ""}.
      </p>
      {!ranked.length ? (
        <p className="text-sm text-slate-500">No vehicles logged in this range.</p>
      ) : (
        <>
          <div className="mb-6" style={{ height: Math.max(140, chart.length * 30 + 30) }} data-testid="report-profit-chart">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chart} layout="vertical" margin={{ top: 4, right: 24, left: 8, bottom: 0 }}>
                <CartesianGrid stroke="var(--border)" horizontal={false} />
                <XAxis type="number" tick={axisTick} axisLine={false} tickLine={false} tickFormatter={(v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v))} />
                <YAxis type="category" dataKey="name" width={170} tick={axisTick} axisLine={false} tickLine={false} />
                <ReferenceLine x={0} stroke="var(--border)" />
                <Tooltip cursor={{ fill: CHART.cursor }} formatter={(v) => [signed(Number(v)), "Profit"]} contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} />
                <Bar dataKey="profit" radius={[0, 3, 3, 0]}>
                  {chart.map((d) => <Cell key={d.name} fill={d.profit >= 0 ? CHART.good : "#f87171"} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="font-mono text-[11px] uppercase tracking-wider text-slate-500">
                <tr>{["#", "Vehicle", "Logged", "Paid", "Brought in", "Profit", "Sold", "Orders"].map((h) => <th key={h} className="py-2 pr-3 text-left font-normal">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-border">
                {ranked.map((a, i) => (
                  <tr key={a.id} data-testid={`report-arrival-${a.id}`}>
                    <td className="py-2 pr-3 font-mono text-xs text-slate-500">{i + 1}</td>
                    <td className="pr-3 text-white">{a.vehicle}</td>
                    <td className="pr-3 font-mono text-xs text-slate-400">{new Date(a.logged).toLocaleDateString()}</td>
                    <td className="pr-3"><CostCell key={String(a.cost)} a={a} /></td>
                    <td className="pr-3 font-mono">{fmtMoney(a.revenue)}</td>
                    <td data-testid={`report-arrival-profit-${a.id}`} className={cn("pr-3 font-mono", a.profit >= 0 ? "text-emerald-300" : "text-red-300")}>{signed(a.profit)}</td>
                    <td className="pr-3 font-mono">{a.sold}</td>
                    <td className="pr-3 font-mono">{a.orders}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Panel>
  );
}
