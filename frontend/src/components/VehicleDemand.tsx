import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import { Overline, Panel } from "@/components/common";
import { apiGet } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { BodyType, LostVehicle, VehicleDemand, VehicleRank, VehicleRow } from "@/lib/types";
import { useDrill } from "@/components/CallsDrill";
import { inferBodyType, formatBodyType } from "@/lib/vehicleUtils";

/** Dashboard: which years / makes / models callers need parts for — for stocking the yard. */
const PAGE = 15;
const BODIES: { id: BodyType | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "car", label: "Cars" },
  { id: "suv", label: "SUVs" },
  { id: "van", label: "Vans" },
  { id: "pickup", label: "Pickups" },
];

type DemandSortField =
  | "vehicle"
  | "body_type"
  | "calls"
  | "calls_30d"
  | "lost"
  | "orders"
  | "close_rate";

type LostSortField =
  | "vehicle"
  | "body_type"
  | "part"
  | "asked"
  | "calls_30d"
  | "lost"
  | "close_rate"
  | "last_asked";

export default function VehicleDemandPanel({ rank = "calls" }: { rank?: VehicleRank }) {
  const drill = useDrill();
  const open = (make: string, model: string, part = "") =>
    drill({
      title: `${[make, model].filter(Boolean).join(" ")}${part ? ` · ${part}` : ""} calls`,
      query: {
        vehicle_make: make,
        ...(model ? { vehicle_model: model } : {}),
        ...(part ? { part: part.toLowerCase() } : {}),
      },
    });

  const [body, setBody] = useState<BodyType | "all">("all");
  const bq = body === "all" ? "" : `&body=${body}`;

  const { data } = useQuery({
    queryKey: ["vehicles", rank, body],
    queryFn: () => apiGet<VehicleDemand>(`/analytics/vehicles?rank=${rank}${bq}`),
    placeholderData: (p) => p,
  });

  const [view, setView] = useState<"models" | "makes" | "lost">("models");
  const [all, setAll] = useState(false);

  const lost = useQuery({
    queryKey: ["vehicles", "lost", rank, body],
    queryFn: () => apiGet<LostVehicle[]>(`/analytics/lost-vehicles?rank=${rank}${bq}`),
    enabled: view === "lost",
    placeholderData: (p) => p,
  });

  // Sorting state for models / makes table
  const [demandSortField, setDemandSortField] = useState<DemandSortField>("calls");
  const [demandSortOrder, setDemandSortOrder] = useState<"asc" | "desc">("desc");

  // Sorting state for "Didn't buy" (lost) table
  const [lostSortField, setLostSortField] = useState<LostSortField>("asked");
  const [lostSortOrder, setLostSortOrder] = useState<"asc" | "desc">("desc");

  const bodyTotal = Object.values(data?.body_counts ?? {}).reduce((a, b) => a + b, 0);

  const handleDemandSort = (field: DemandSortField) => {
    if (demandSortField === field) {
      setDemandSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setDemandSortField(field);
      setDemandSortOrder(field === "vehicle" || field === "body_type" ? "asc" : "desc");
    }
  };

  const handleLostSort = (field: LostSortField) => {
    if (lostSortField === field) {
      setLostSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setLostSortField(field);
      setLostSortOrder(field === "vehicle" || field === "body_type" || field === "part" ? "asc" : "desc");
    }
  };

  const renderSortIcon = (active: boolean, order: "asc" | "desc") => {
    if (!active) {
      return <ArrowUpDown className="ml-1 inline size-3 text-slate-500 opacity-60 group-hover:opacity-100" />;
    }
    return order === "asc" ? (
      <ArrowUp className="ml-1 inline size-3 text-amber-400" />
    ) : (
      <ArrowDown className="ml-1 inline size-3 text-amber-400" />
    );
  };

  // Helper to get normalized body style badge info
  const getBodyInfo = (m: Pick<VehicleRow, "model" | "make" | "body_type">) => {
    const b = inferBodyType(m.model, m.make, m.body_type);
    return {
      type: b,
      label: formatBodyType(b),
    };
  };

  const getBadgeStyle = (b: BodyType) => {
    switch (b) {
      case "pickup":
        return "bg-amber-500/15 text-amber-300 border-amber-500/30";
      case "suv":
        return "bg-sky-500/15 text-sky-300 border-sky-500/30";
      case "car":
        return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
      case "van":
        return "bg-purple-500/15 text-purple-300 border-purple-500/30";
      default:
        return "bg-slate-500/15 text-slate-300 border-slate-500/30";
    }
  };

  if (!data) return null;

  // Filter raw rows by selected body style (both client-side fallback & backend)
  const rawRows: VehicleRow[] = view === "models" ? data.models : view === "makes" ? data.makes : [];
  const filteredRawRows = rawRows.filter((r) => {
    if (body === "all") return true;
    if (view === "makes") {
      // If filtering by body style in make view, show makes that have models matching this body style
      return (
        r.body_type === body ||
        inferBodyType(r.model, r.make, r.body_type) === body ||
        data.models.some(
          (m) => m.make === r.make && inferBodyType(m.model, m.make, m.body_type) === body
        )
      );
    }
    const bt = inferBodyType(r.model, r.make, r.body_type);
    return bt === body;
  });

  // Sort demand rows
  const sortedDemandRows = [...filteredRawRows].sort((a, b) => {
    let cmp = 0;
    if (demandSortField === "body_type") {
      const bA = getBodyInfo(a).label;
      const bB = getBodyInfo(b).label;
      cmp = bA.localeCompare(bB);
      if (cmp === 0) {
        cmp = `${a.make} ${a.model}`.localeCompare(`${b.make} ${b.model}`);
      }
    } else if (demandSortField === "vehicle") {
      const vA = a.model ? `${a.make} ${a.model}` : a.make;
      const vB = b.model ? `${b.make} ${b.model}` : b.make;
      cmp = vA.localeCompare(vB);
    } else if (demandSortField === "calls") {
      cmp = a.calls - b.calls;
    } else if (demandSortField === "calls_30d") {
      cmp = a.calls_30d - b.calls_30d;
    } else if (demandSortField === "lost") {
      cmp = a.lost - b.lost;
    } else if (demandSortField === "orders") {
      cmp = a.orders - b.orders;
    } else if (demandSortField === "close_rate") {
      cmp = a.close_rate - b.close_rate;
    }
    return demandSortOrder === "asc" ? cmp : -cmp;
  });

  // Lost vehicles
  const rawLostAll: LostVehicle[] = lost.data ?? [];
  const filteredLostAll = rawLostAll.filter((r) => {
    if (body === "all") return true;
    return inferBodyType(r.model, r.make, r.body_type) === body;
  });

  const sortedLostRows = [...filteredLostAll].sort((a, b) => {
    let cmp = 0;
    if (lostSortField === "body_type") {
      const bA = getBodyInfo(a).label;
      const bB = getBodyInfo(b).label;
      cmp = bA.localeCompare(bB);
      if (cmp === 0) {
        cmp = `${a.make} ${a.model}`.localeCompare(`${b.make} ${b.model}`);
      }
    } else if (lostSortField === "vehicle") {
      cmp = `${a.make} ${a.model}`.localeCompare(`${b.make} ${b.model}`);
    } else if (lostSortField === "part") {
      cmp = (a.part || "").localeCompare(b.part || "");
    } else if (lostSortField === "asked") {
      cmp = a.asked - b.asked;
    } else if (lostSortField === "calls_30d") {
      cmp = a.calls_30d - b.calls_30d;
    } else if (lostSortField === "lost") {
      cmp = a.lost - b.lost;
    } else if (lostSortField === "close_rate") {
      cmp = a.close_rate - b.close_rate;
    } else if (lostSortField === "last_asked") {
      cmp = new Date(a.last_asked).getTime() - new Date(b.last_asked).getTime();
    }
    return lostSortOrder === "asc" ? cmp : -cmp;
  });

  const total = view === "lost" ? sortedLostRows.length : sortedDemandRows.length;
  const rows = all ? sortedDemandRows : sortedDemandRows.slice(0, PAGE);
  const lostRows = all ? sortedLostRows : sortedLostRows.slice(0, PAGE);
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
              onClick={() => {
                setView(v);
                setAll(false);
              }}
              className={cn(
                "rounded-md px-3 py-1 capitalize transition-colors duration-150",
                view === v ? "bg-amber-500 text-black font-medium" : "text-slate-400 hover:text-white"
              )}
            >
              {v === "models" ? "Make & model" : v === "makes" ? "Make" : "Didn't buy"}
            </button>
          ))}
        </div>
      </div>

      {/* Body Style Filter Buttons */}
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
              onClick={() => {
                setBody(b.id);
                setAll(false);
              }}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-[background-color,border-color,color] duration-150",
                body === b.id
                  ? "border-amber-400 bg-amber-500/20 text-amber-100 ring-1 ring-amber-500/40"
                  : "border-border text-slate-400 hover:border-slate-500 hover:text-white"
              )}
            >
              {b.label}
              <span className="font-mono text-[11px] text-slate-500">
                {b.id === "all" ? n : `${n} · ${pct}%`}
              </span>
            </button>
          );
        })}
      </div>

      {view === "lost" ? (
        <div className="mt-5 overflow-x-auto" data-testid="lost-vehicles-table">
          <p className="mb-3 text-xs text-slate-500">
            Vehicles and parts callers asked for but didn't order (lost or never closed) — what to source next.
          </p>
          <table className="w-full text-sm">
            <thead className="font-mono text-[11px] uppercase tracking-wider text-slate-500">
              <tr>
                <th
                  onClick={() => handleLostSort("vehicle")}
                  className="cursor-pointer py-2 pr-4 text-left font-normal hover:text-slate-300 group"
                  data-testid="lost-sort-vehicle"
                >
                  Vehicle {renderSortIcon(lostSortField === "vehicle", lostSortOrder)}
                </th>
                <th
                  onClick={() => handleLostSort("body_type")}
                  className="cursor-pointer py-2 pr-4 text-left font-normal hover:text-slate-300 group"
                  data-testid="lost-sort-body-type"
                >
                  Body Type {renderSortIcon(lostSortField === "body_type", lostSortOrder)}
                </th>
                <th
                  onClick={() => handleLostSort("part")}
                  className="cursor-pointer py-2 pr-4 text-left font-normal hover:text-slate-300 group"
                  data-testid="lost-sort-part"
                >
                  Part {renderSortIcon(lostSortField === "part", lostSortOrder)}
                </th>
                <th className="py-2 pr-4 text-left font-normal">Years</th>
                <th
                  onClick={() => handleLostSort("asked")}
                  className="cursor-pointer py-2 pr-4 text-left font-normal hover:text-slate-300 group"
                  data-testid="lost-sort-asked"
                >
                  Asked {renderSortIcon(lostSortField === "asked", lostSortOrder)}
                </th>
                <th
                  onClick={() => handleLostSort("calls_30d")}
                  className="cursor-pointer py-2 pr-4 text-left font-normal hover:text-slate-300 group"
                  data-testid="lost-sort-calls-30d"
                >
                  Last 30 days {renderSortIcon(lostSortField === "calls_30d", lostSortOrder)}
                </th>
                <th
                  onClick={() => handleLostSort("lost")}
                  className="cursor-pointer py-2 pr-4 text-left font-normal hover:text-slate-300 group"
                  data-testid="lost-sort-lost"
                >
                  Didn't buy {renderSortIcon(lostSortField === "lost", lostSortOrder)}
                </th>
                <th
                  onClick={() => handleLostSort("close_rate")}
                  className="cursor-pointer py-2 pr-4 text-left font-normal hover:text-slate-300 group"
                  data-testid="lost-sort-close-rate"
                >
                  Close rate {renderSortIcon(lostSortField === "close_rate", lostSortOrder)}
                </th>
                <th
                  onClick={() => handleLostSort("last_asked")}
                  className="cursor-pointer py-2 pr-4 text-left font-normal hover:text-slate-300 group"
                  data-testid="lost-sort-last-asked"
                >
                  Last asked {renderSortIcon(lostSortField === "last_asked", lostSortOrder)}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {lostRows.map((r, i) => {
                const bodyInfo = getBodyInfo(r);
                return (
                  <tr
                    key={`${r.make}-${r.model}-${r.part}-${i}`}
                    data-testid={`lost-vehicle-row-${i}`}
                    onClick={() => open(r.make, r.model, r.part)}
                    className="cursor-pointer transition-colors duration-150 hover:bg-slate-800/40"
                  >
                    <td className="py-2.5 pr-4 font-medium text-white">
                      {r.make} {r.model}
                    </td>
                    <td className="pr-4">
                      <span
                        className={cn(
                          "inline-flex items-center rounded border px-2 py-0.5 font-mono text-[10px] font-medium",
                          getBadgeStyle(bodyInfo.type)
                        )}
                      >
                        {bodyInfo.label}
                      </span>
                    </td>
                    <td className="pr-4 text-slate-300">{r.part || "Any / not captured"}</td>
                    <td className="pr-4 font-mono text-xs text-slate-400">{r.years || "—"}</td>
                    <td className="pr-4 font-mono">{r.asked}</td>
                    <td className="pr-4 font-mono">{r.calls_30d}</td>
                    <td className="pr-4 font-mono text-orange-300">{r.lost}</td>
                    <td className="pr-4 font-mono">{r.close_rate}%</td>
                    <td className="pr-4 font-mono text-xs text-slate-400">
                      {new Date(r.last_asked).toLocaleDateString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {lostRows.length === 0 && <p className="mt-3 text-sm text-slate-500">No missed vehicle sales matching this filter.</p>}
        </div>
      ) : rows.length === 0 ? (
        <p className="mt-6 text-sm text-slate-500" data-testid="vehicle-demand-empty">
          No vehicles captured yet — they appear as calls are analyzed or tagged.
        </p>
      ) : (
        <div className="mt-5 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="font-mono text-[11px] uppercase tracking-wider text-slate-500">
              <tr>
                <th
                  onClick={() => handleDemandSort("vehicle")}
                  className="cursor-pointer py-2 pr-4 text-left font-normal hover:text-slate-300 group"
                  data-testid="demand-sort-vehicle"
                >
                  Vehicle {renderSortIcon(demandSortField === "vehicle", demandSortOrder)}
                </th>
                {view === "models" && (
                  <th
                    onClick={() => handleDemandSort("body_type")}
                    className="cursor-pointer py-2 pr-4 text-left font-normal hover:text-slate-300 group"
                    data-testid="demand-sort-body-type"
                  >
                    Body Type {renderSortIcon(demandSortField === "body_type", demandSortOrder)}
                  </th>
                )}
                <th className="py-2 pr-4 text-left font-normal">Years</th>
                <th
                  onClick={() => handleDemandSort("calls")}
                  className="cursor-pointer py-2 pr-4 text-left font-normal hover:text-slate-300 group"
                  data-testid="demand-sort-calls"
                >
                  Calls {renderSortIcon(demandSortField === "calls", demandSortOrder)}
                </th>
                <th
                  onClick={() => handleDemandSort("calls_30d")}
                  className="cursor-pointer py-2 pr-4 text-left font-normal hover:text-slate-300 group"
                  data-testid="demand-sort-calls-30d"
                >
                  Last 30 days {renderSortIcon(demandSortField === "calls_30d", demandSortOrder)}
                </th>
                <th
                  onClick={() => handleDemandSort("lost")}
                  className="cursor-pointer py-2 pr-4 text-left font-normal hover:text-slate-300 group"
                  data-testid="demand-sort-lost"
                >
                  Didn't buy {renderSortIcon(demandSortField === "lost", demandSortOrder)}
                </th>
                <th
                  onClick={() => handleDemandSort("orders")}
                  className="cursor-pointer py-2 pr-4 text-left font-normal hover:text-slate-300 group"
                  data-testid="demand-sort-orders"
                >
                  Orders {renderSortIcon(demandSortField === "orders", demandSortOrder)}
                </th>
                <th
                  onClick={() => handleDemandSort("close_rate")}
                  className="cursor-pointer py-2 pr-4 text-left font-normal hover:text-slate-300 group"
                  data-testid="demand-sort-close-rate"
                >
                  Close rate {renderSortIcon(demandSortField === "close_rate", demandSortOrder)}
                </th>
                <th className="py-2 pr-4 text-left font-normal">Top parts asked for</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r, i) => {
                const bodyInfo = getBodyInfo(r);
                return (
                  <tr
                    key={r.make + r.model + i}
                    data-testid={`vehicle-row-${i}`}
                    onClick={() => open(r.make, r.model)}
                    className="cursor-pointer transition-colors duration-150 hover:bg-slate-800/40"
                  >
                    <td className="py-2.5 pr-4">
                      <p className="font-medium text-white">{r.model ? `${r.make} ${r.model}` : r.make}</p>
                      <div className="mt-1 h-1 w-40 rounded-full bg-slate-800">
                        <div
                          className="h-full rounded-full bg-amber-500/70"
                          style={{ width: `${(r.calls / max) * 100}%` }}
                        />
                      </div>
                    </td>
                    {view === "models" && (
                      <td className="pr-4">
                        <span
                          className={cn(
                            "inline-flex items-center rounded border px-2 py-0.5 font-mono text-[10px] font-medium",
                            getBadgeStyle(bodyInfo.type)
                          )}
                        >
                          {bodyInfo.label}
                        </span>
                      </td>
                    )}
                    <td className="pr-4 font-mono text-xs text-slate-400">
                      {r.year_min ? `${r.year_min}–${r.year_max}` : "—"}
                      {r.top_years.length > 0 && (
                        <span className="block text-slate-500">most: {r.top_years.join(", ")}</span>
                      )}
                    </td>
                    <td className="pr-4 font-mono">{r.calls}</td>
                    <td className="pr-4 font-mono">{r.calls_30d}</td>
                    <td className="pr-4 font-mono text-orange-300">{r.lost}</td>
                    <td className="pr-4 font-mono">{r.orders}</td>
                    <td className="pr-4 font-mono">{r.close_rate}%</td>
                    <td className="pr-4 text-xs text-slate-300">{r.top_parts.join(", ") || "—"}</td>
                  </tr>
                );
              })}
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
