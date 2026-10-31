import { useState, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Flame, Search, Warehouse, ArrowUpDown, ArrowUp, ArrowDown, Filter } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Overline, Panel, fmtMoney } from "@/components/common";
import { apiGet, apiPost, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useMe } from "@/lib/hooks";
import type { Arrival, BodyType } from "@/lib/types";
import { canManageInventory } from "@/lib/types";
import { inferBodyType, formatBodyType } from "@/lib/vehicleUtils";

type SortField = "body_type" | "vehicle" | "stock" | "checked_in" | "cost";
type SortOrder = "asc" | "desc";

const BODY_FILTERS: { id: BodyType | "all"; label: string }[] = [
  { id: "all", label: "All Bodies" },
  { id: "pickup", label: "Trucks / Pickups" },
  { id: "suv", label: "SUVs" },
  { id: "car", label: "Sedans / Cars" },
  { id: "van", label: "Vans" },
  { id: "other", label: "Other" },
];

/**
 * Yard Inventory: Displays checked-in vehicles currently in the yard lot.
 * Supports sorting (especially by Body Type) and quick filtering by body category.
 * Owners and Inventory Managers can select vehicles via checkboxes and push them
 * into the "To be crushed" crushing queue.
 */
export default function YardInventory({ isManager }: { isManager?: boolean }) {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const canManage = canManageInventory(me?.role);

  const { data, isLoading } = useQuery({
    queryKey: ["arrivals"],
    queryFn: () => apiGet<Arrival[]>("/arrivals"),
  });

  const [searchQ, setSearchQ] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [defaultCrushDays, setDefaultCrushDays] = useState(30);

  // Sorting state
  const [sortField, setSortField] = useState<SortField>("checked_in");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");

  // Body type filter
  const [selectedBody, setSelectedBody] = useState<BodyType | "all">("all");

  const yardVehicles = useMemo(
    () => (data ?? []).filter((a) => a.inventory_status === "yard_inventory"),
    [data]
  );

  // Vehicles with resolved body type
  const yardWithBody = useMemo(() => {
    return yardVehicles.map((a) => {
      const resolvedBody = inferBodyType(a.vehicle_model, a.vehicle_make, a.body_type);
      return {
        ...a,
        resolved_body_type: resolvedBody,
        body_label: formatBodyType(resolvedBody),
      };
    });
  }, [yardVehicles]);

  // Filter by search query and body filter tab
  const filteredVehicles = useMemo(() => {
    const q = searchQ.trim().toLowerCase();
    return yardWithBody.filter((a) => {
      if (selectedBody !== "all" && a.resolved_body_type !== selectedBody) {
        return false;
      }
      if (!q) return true;
      return (
        a.stock_number.toLowerCase().includes(q) ||
        `${a.vehicle_year} ${a.vehicle_make} ${a.vehicle_model}`.toLowerCase().includes(q) ||
        a.body_label.toLowerCase().includes(q) ||
        a.resolved_body_type.toLowerCase().includes(q) ||
        (a.note && a.note.toLowerCase().includes(q))
      );
    });
  }, [yardWithBody, searchQ, selectedBody]);

  // Sort vehicles
  const sortedVehicles = useMemo(() => {
    return [...filteredVehicles].sort((a, b) => {
      let cmp = 0;
      if (sortField === "body_type") {
        cmp = a.body_label.localeCompare(b.body_label);
        if (cmp === 0) {
          // secondary sort by vehicle name
          cmp = `${a.vehicle_make} ${a.vehicle_model}`.localeCompare(`${b.vehicle_make} ${b.vehicle_model}`);
        }
      } else if (sortField === "vehicle") {
        const vA = `${a.vehicle_year} ${a.vehicle_make} ${a.vehicle_model}`;
        const vB = `${b.vehicle_year} ${b.vehicle_make} ${b.vehicle_model}`;
        cmp = vA.localeCompare(vB);
      } else if (sortField === "stock") {
        cmp = (a.stock_number || "").localeCompare(b.stock_number || "");
      } else if (sortField === "cost") {
        const cA = a.cost ?? 0;
        const cB = b.cost ?? 0;
        cmp = cA - cB;
      } else {
        // checked_in
        const tA = a.checked_in_at ? new Date(a.checked_in_at).getTime() : 0;
        const tB = b.checked_in_at ? new Date(b.checked_in_at).getTime() : 0;
        cmp = tA - tB;
      }
      return sortOrder === "asc" ? cmp : -cmp;
    });
  }, [filteredVehicles, sortField, sortOrder]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortOrder(field === "body_type" || field === "vehicle" || field === "stock" ? "asc" : "desc");
    }
  };

  const renderSortIcon = (field: SortField) => {
    if (sortField !== field) {
      return <ArrowUpDown className="ml-1 inline size-3 text-slate-500 opacity-60 group-hover:opacity-100" />;
    }
    return sortOrder === "asc" ? (
      <ArrowUp className="ml-1 inline size-3 text-amber-400" />
    ) : (
      <ArrowDown className="ml-1 inline size-3 text-amber-400" />
    );
  };

  const allFilteredSelected =
    sortedVehicles.length > 0 && sortedVehicles.every((v) => selectedIds.includes(v.id));

  const toggleSelectAll = () => {
    if (allFilteredSelected) {
      setSelectedIds([]);
    } else {
      setSelectedIds(sortedVehicles.map((v) => v.id));
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  };

  const queueCrushMutation = useMutation({
    mutationFn: (ids: string[]) =>
      apiPost<{ ok: boolean; count: number }>("/arrivals/queue-crush", {
        ids,
        days: defaultCrushDays,
      }),
    onSuccess: (res) => {
      toast.success(
        `${res.count} vehicle${res.count === 1 ? "" : "s"} moved to Crushing Queue (${defaultCrushDays} days until crush)`,
      );
      setSelectedIds([]);
      qc.invalidateQueries({ queryKey: ["arrivals"] });
    },
    onError: (e) => toast.error(errorMessage(e, "Failed to move vehicles to crush queue")),
  });

  const handlePushSelectedToCrush = () => {
    if (selectedIds.length === 0) return;
    queueCrushMutation.mutate(selectedIds);
  };

  const handlePushSingleToCrush = (id: string) => {
    queueCrushMutation.mutate([id]);
  };

  // Body badge colors
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

  return (
    <Panel testId="yard-inventory-panel">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Warehouse className="size-4 text-emerald-400" />
          <Overline>Yard Inventory</Overline>
          <span
            data-testid="yard-inventory-count"
            className="rounded bg-emerald-500/15 px-2 py-0.5 font-mono text-[11px] font-semibold text-emerald-300 ring-1 ring-emerald-500/30"
          >
            {yardVehicles.length} on lot
          </span>
        </div>

        {canManage && selectedIds.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-slate-400">
              {selectedIds.length} selected
            </span>
            <Button
              size="sm"
              variant="destructive"
              data-testid="push-to-crush-btn"
              disabled={queueCrushMutation.isPending}
              onClick={handlePushSelectedToCrush}
              className="gap-1.5"
            >
              <Flame className="size-4" />
              Push to Crush Queue ({selectedIds.length})
            </Button>
          </div>
        )}
      </div>

      <p className="mt-1 text-xs text-slate-500">
        Active vehicles checked into the yard lot. Sort by body type, filter, or select vehicles to send to the "To be crushed" queue.
      </p>

      {/* Body Type quick-filter tabs */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border/50 pt-3">
        <span className="flex items-center gap-1 font-mono text-[11px] uppercase tracking-wider text-slate-500 mr-1">
          <Filter className="size-3" /> Body:
        </span>
        {BODY_FILTERS.map((bf) => {
          const count =
            bf.id === "all"
              ? yardWithBody.length
              : yardWithBody.filter((v) => v.resolved_body_type === bf.id).length;
          const isActive = selectedBody === bf.id;
          return (
            <button
              key={bf.id}
              type="button"
              data-testid={`yard-filter-body-${bf.id}`}
              onClick={() => setSelectedBody(bf.id)}
              className={cn(
                "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
                isActive
                  ? "bg-amber-500/20 text-amber-300 ring-1 ring-amber-500/50"
                  : "bg-surface text-slate-400 hover:bg-surface/80 hover:text-slate-200 border border-border"
              )}
            >
              <span>{bf.label}</span>
              <span
                className={cn(
                  "font-mono text-[10px] rounded-full px-1.5 py-0.2",
                  isActive ? "bg-amber-500/30 text-amber-200" : "bg-black/30 text-slate-500"
                )}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Controls & Search */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-y border-border/60 py-3">
        <div className="flex items-center gap-2">
          {canManage && sortedVehicles.length > 0 && (
            <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs text-slate-300 transition-colors hover:bg-surface">
              <input
                type="checkbox"
                data-testid="yard-select-all"
                checked={allFilteredSelected}
                onChange={toggleSelectAll}
                className="size-4 rounded border-border text-amber-500 focus:ring-amber-500"
              />
              <span className="select-none font-mono text-xs">Select all</span>
            </label>
          )}
        </div>

        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-slate-500" />
          <Input
            data-testid="yard-search-input"
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            placeholder="Search stock, body, make, model…"
            className="h-8 pl-8 text-xs"
          />
        </div>
      </div>

      {/* Vehicle List */}
      {sortedVehicles.length === 0 ? (
        <div className="py-8 text-center text-slate-500" data-testid="yard-inventory-empty">
          {yardVehicles.length === 0 ? (
            <>
              <Warehouse className="mx-auto size-8 text-slate-600 mb-2" />
              <p className="text-sm font-medium text-slate-400">No vehicles in yard inventory</p>
              <p className="mt-1 text-xs text-slate-500">
                Check in vehicles from the Newly Arrived category above to add them to the yard lot.
              </p>
            </>
          ) : (
            <p className="text-sm">No vehicles match current search and body filter</p>
          )}
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm" data-testid="yard-inventory-table">
            <thead className="border-b border-border bg-surface/50 font-mono text-[11px] uppercase tracking-wider text-slate-500">
              <tr>
                {canManage && <th className="w-10 px-3 py-2.5"></th>}
                <th
                  className="cursor-pointer px-3 py-2.5 font-normal hover:text-slate-300 group"
                  data-testid="yard-sort-stock"
                  onClick={() => handleSort("stock")}
                >
                  Stock # {renderSortIcon("stock")}
                </th>
                <th
                  className="cursor-pointer px-3 py-2.5 font-normal hover:text-slate-300 group"
                  data-testid="yard-sort-vehicle"
                  onClick={() => handleSort("vehicle")}
                >
                  Vehicle {renderSortIcon("vehicle")}
                </th>
                <th
                  className="cursor-pointer px-3 py-2.5 font-normal hover:text-slate-300 group"
                  data-testid="yard-sort-body-type"
                  onClick={() => handleSort("body_type")}
                >
                  Body Type {renderSortIcon("body_type")}
                </th>
                <th
                  className="cursor-pointer px-3 py-2.5 font-normal hover:text-slate-300 group"
                  data-testid="yard-sort-checked-in"
                  onClick={() => handleSort("checked_in")}
                >
                  Checked In {renderSortIcon("checked_in")}
                </th>
                <th
                  className="cursor-pointer px-3 py-2.5 font-normal hover:text-slate-300 group"
                  data-testid="yard-sort-cost"
                  onClick={() => handleSort("cost")}
                >
                  Paid / Cost {renderSortIcon("cost")}
                </th>
                <th className="px-3 py-2.5 font-normal">Notes & Callers</th>
                {canManage && <th className="px-3 py-2.5 text-right font-normal">Action</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sortedVehicles.map((a) => {
                const isSelected = selectedIds.includes(a.id);
                return (
                  <tr
                    key={a.id}
                    data-testid={`yard-row-${a.id}`}
                    className={cn(
                      "transition-colors duration-150 hover:bg-surface/60",
                      isSelected && "bg-amber-500/10",
                    )}
                  >
                    {canManage && (
                      <td className="px-3 py-3">
                        <input
                          type="checkbox"
                          data-testid={`yard-checkbox-${a.id}`}
                          checked={isSelected}
                          onChange={() => toggleSelect(a.id)}
                          className="size-4 rounded border-border text-amber-500 focus:ring-amber-500"
                        />
                      </td>
                    )}
                    <td className="px-3 py-3">
                      <span className="font-mono text-xs font-semibold text-amber-300">
                        {a.stock_number || "—"}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <p className="font-medium text-white">
                        {a.vehicle_year} {a.vehicle_make} {a.vehicle_model}
                      </p>
                    </td>
                    <td className="px-3 py-3" data-testid={`yard-body-type-${a.id}`}>
                      <span
                        className={cn(
                          "inline-flex items-center rounded-md border px-2 py-0.5 font-mono text-[11px] font-medium",
                          getBadgeStyle(a.resolved_body_type)
                        )}
                      >
                        {a.body_label}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <p className="font-mono text-xs text-slate-300">
                        {a.checked_in_at ? new Date(a.checked_in_at).toLocaleDateString() : "Checked In"}
                      </p>
                      {a.checked_in_by && (
                        <p className="text-[10px] text-slate-500">by {a.checked_in_by}</p>
                      )}
                    </td>
                    <td className="px-3 py-3 font-mono text-xs text-slate-200">
                      {a.cost != null ? fmtMoney(a.cost) : "—"}
                    </td>
                    <td className="px-3 py-3 text-xs text-slate-400">
                      {a.note && <span className="text-slate-300">{a.note} · </span>}
                      <span className="font-mono">{a.callers.length} callers</span>
                      {a.results && a.results.sold > 0 && (
                        <span className="ml-1 text-emerald-400 font-mono">
                          · {a.results.sold} sold
                        </span>
                      )}
                    </td>
                    {canManage && (
                      <td className="px-3 py-3 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          data-testid={`push-single-crush-${a.id}`}
                          onClick={() => handlePushSingleToCrush(a.id)}
                          disabled={queueCrushMutation.isPending}
                          className="h-7 text-xs text-rose-400 hover:bg-rose-500/15 hover:text-rose-200"
                        >
                          <Flame className="mr-1 size-3" />
                          Push to Crush
                        </Button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
