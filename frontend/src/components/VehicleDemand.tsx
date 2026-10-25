import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Overline, Panel } from "@/components/common";
import { apiGet } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { BodyType, LostVehicle, VehicleDemand, VehicleRank } from "@/lib/types";
import { useDrill } from "@/components/CallsDrill";

/** Dashboard: which years / makes / models callers need parts for — for stocking the yard. */
const PAGE = 15;
const BODIES: { id: BodyType | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "car", label: "Cars" },
  { id: "suv", label: "SUVs" },
  { id: "van", label: "Vans" },
  { id: "pickup", label: "Pickups" },
];

export default function VehicleDemandPanel({ rank = "calls" }: { rank?: VehicleRank }) {
  const drill = useDrill();
  const open = (make: string, model: string, part = "") =>
    drill({ title: `${[make, model].filter(Boolean).join(" ")}${part ? ` · ${part}` : ""} calls`, query: { vehicle_make: make, ...(model ? { vehicle_model: model } : {}), ...(part ? { part: part.toLowerCase() } : {}) } });
  const [body, setBody] = useState<BodyType | "all">("all");
  const bq = body === "all" ? "" : `&body=${body}`;
  const { data } = useQuery({ queryKey: ["vehicles", rank, body], queryFn: () => apiGet<VehicleDemand>(`/analytics/vehicles?rank=${rank}${bq}`), placeholderData: (p) => p });
  const [view, setView] = useState<"models" | "makes" | "lost">("models");
  const [all, setAll] = useState(false);
  const lost = useQuery({ queryKey: ["vehicles", "lost", rank, body], queryFn: () => apiGet<LostVehicle[]>(`/analytics/lost-vehicles?rank=${rank}${bq}`), enabled: view === "lost", placeholderData: (p) => p });
  const bodyTotal = Object.values(data?.body_counts ?? {}).reduce((a, b) => a + b, 0);
  if (!data) return null;
  const full = view === "models" ? data.models : view === "makes" ? data.makes : [];
  const lostAll = lost.data ?? [];
  const total = view === "lost" ? lostAll.length : full.length;
  const rows = all ? full : full.slice(0, PAGE);
  const lostRows = all ? lostAll : lostAll.slice(0, PAGE);
  const max = Math.max(1, ...rows.map((r) => r.calls));
  return (
    <Panel className="xl:col-span-12" testId="vehicle-demand-panel">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Overline>Yard inventory</Overline>
          <h3 className="mt-1 font-heading text-xl font-bold text-white">Vehicles callers need parts for</h3>
          <p className="mt-1 text-xs text-slate-500" data-testid="vehicle-demand-coverage">
            Year, make and model captured on {data.tracked_calls} of {data.total_calls} calls. AI reads it from transcripts; fix or add it on any call.
          </p>
        </div>
        <div className="flex rounded-lg border border-border p-0.5 text-sm">
          {(["models", "makes", "lost"] as const).map((v) => (
            <button
              key={v}
              data-testid={`vehicle-demand-view-${v}`}
              onClick={() => (setView(v), setAll(false))}
              className={cn("rounded-md px-3 py-1 capitalize transition-colors duration-150", view === v ? "bg-amber-500 text-black" : "text-slate-400 hover:text-white")}
            >
              {v === "models" ? "Make & model" : v === "makes" ? "Make" : "Didn't buy"}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2" data-testid="vehicle-body-filter">
        <span className="font-mono text-[11px] uppercase tracking-wider text-slate-500">Body style</span>
        {BODIES.map((b) => {
          const n = b.id === "all" ? bodyTotal : (data.body_counts[b.id] ?? 0);
          const pct = bodyTotal ? Math.round((100 * n) / bodyTotal) : 0;
          return (
            <button
              key={b.id}
              type="button"
              data-testid={`vehicle-body-${b.id}`}
              onClick={() => (setBody(b.id), setAll(false))}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-[background-color,border-color,color] duration-150",
                body === b.id ? "border-amber-400 bg-amber-500/20 text-amber-100" : "border-border text-slate-400 hover:border-slate-500 hover:text-white",
              )}
            >
              {b.label}
              <span className="font-mono text-[11px] text-slate-500">{b.id === "all" ? n : `${n} · ${pct}%`}</span>
            </button>
          );
        })}
      </div>
      {view === "lost" ? (
        <div className="mt-5 overflow-x-auto" data-testid="lost-vehicles-table">
          <p className="mb-3 text-xs text-slate-500">Vehicles and parts callers asked for but didn't order (lost or never closed) — what to source next.</p>
          <table className="w-full text-sm">
            <thead className="font-mono text-[11px] uppercase tracking-wider text-slate-500">
              <tr>
                {["Vehicle", "Part", "Years", "Asked", "Last 30 days", "Didn't buy", "Close rate", "Last asked"].map((h) => (
                  <th key={h} className="py-2 pr-4 text-left font-normal">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {lostRows.map((r, i) => (
                <tr key={`${r.make}-${r.model}-${r.part}`} data-testid={`lost-vehicle-row-${i}`} onClick={() => open(r.make, r.model, r.part)} className="cursor-pointer transition-colors duration-150 hover:bg-slate-800/40">
                  <td className="py-2.5 pr-4 font-medium text-white">{r.make} {r.model}</td>
                  <td className="pr-4 text-slate-300">{r.part || "Any / not captured"}</td>
                  <td className="pr-4 font-mono text-xs text-slate-400">{r.years || "—"}</td>
                  <td className="pr-4 font-mono">{r.asked}</td>
                  <td className="pr-4 font-mono">{r.calls_30d}</td>
                  <td className="pr-4 font-mono text-orange-300">{r.lost}</td>
                  <td className="pr-4 font-mono">{r.close_rate}%</td>
                  <td className="pr-4 font-mono text-xs text-slate-400">{new Date(r.last_asked).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {lost.data?.length === 0 && <p className="mt-3 text-sm text-slate-500">No missed vehicle sales yet.</p>}
        </div>
      ) : rows.length === 0 ? (
        <p className="mt-6 text-sm text-slate-500" data-testid="vehicle-demand-empty">No vehicles captured yet — they appear as calls are analyzed or tagged.</p>
      ) : (
        <div className="mt-5 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="font-mono text-[11px] uppercase tracking-wider text-slate-500">
              <tr>
                {["Vehicle", "Years", "Calls", "Last 30 days", "Didn't buy", "Orders", "Close rate", "Top parts asked for"].map((h) => (
                  <th key={h} className="py-2 pr-4 text-left font-normal">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r, i) => (
                <tr key={r.make + r.model} data-testid={`vehicle-row-${i}`} onClick={() => open(r.make, r.model)} className="cursor-pointer transition-colors duration-150 hover:bg-slate-800/40">
                  <td className="py-2.5 pr-4">
                    <p className="font-medium text-white">{r.model ? `${r.make} ${r.model}` : r.make}</p>
                    <div className="mt-1 h-1 w-40 rounded-full bg-slate-800">
                      <div className="h-full rounded-full bg-amber-500/70" style={{ width: `${(r.calls / max) * 100}%` }} />
                    </div>
                  </td>
                  <td className="pr-4 font-mono text-xs text-slate-400">
                    {r.year_min ? `${r.year_min}–${r.year_max}` : "—"}
                    {r.top_years.length > 0 && <span className="block text-slate-500">most: {r.top_years.join(", ")}</span>}
                  </td>
                  <td className="pr-4 font-mono">{r.calls}</td>
                  <td className="pr-4 font-mono">{r.calls_30d}</td>
                  <td className="pr-4 font-mono text-orange-300">{r.lost}</td>
                  <td className="pr-4 font-mono">{r.orders}</td>
                  <td className="pr-4 font-mono">{r.close_rate}%</td>
                  <td className="pr-4 text-xs text-slate-300">{r.top_parts.join(", ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {total > PAGE && (
        <button
          type="button"
          data-testid="vehicle-demand-show-all"
          onClick={() => setAll(!all)}
          className="mt-4 text-sm font-medium text-amber-300 transition-colors duration-150 hover:text-amber-200"
        >
          {all ? `Show top ${PAGE}` : `Show all ${total} ${view === "makes" ? "makes" : "vehicles"}`}
        </button>
      )}
    </Panel>
  );
}
