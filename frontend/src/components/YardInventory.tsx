import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckSquare, Flame, Search, Warehouse, RotateCcw, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Overline, Panel, fmtMoney } from "@/components/common";
import { apiGet, apiPost, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useMe } from "@/lib/hooks";
import type { Arrival } from "@/lib/types";
import { canManageInventory } from "@/lib/types";

/**
 * Yard Inventory: Displays checked-in vehicles currently in the yard lot.
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

  const yardVehicles = (data ?? []).filter((a) => a.inventory_status === "yard_inventory");

  const q = searchQ.trim().toLowerCase();
  const filteredVehicles = yardVehicles.filter(
    (a) =>
      !q ||
      a.stock_number.toLowerCase().includes(q) ||
      `${a.vehicle_year} ${a.vehicle_make} ${a.vehicle_model}`.toLowerCase().includes(q) ||
      (a.note && a.note.toLowerCase().includes(q)),
  );

  const allFilteredSelected =
    filteredVehicles.length > 0 && filteredVehicles.every((v) => selectedIds.includes(v.id));

  const toggleSelectAll = () => {
    if (allFilteredSelected) {
      setSelectedIds([]);
    } else {
      setSelectedIds(filteredVehicles.map((v) => v.id));
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
        Active vehicles checked into the yard lot. Select vehicles to send to the "To be crushed" queue.
      </p>

      {/* Controls & Search */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-y border-border/60 py-3">
        <div className="flex items-center gap-2">
          {canManage && filteredVehicles.length > 0 && (
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
            placeholder="Search stock #, make, model…"
            className="h-8 pl-8 text-xs"
          />
        </div>
      </div>

      {/* Vehicle List */}
      {filteredVehicles.length === 0 ? (
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
            <p className="text-sm">No vehicles match "{searchQ}"</p>
          )}
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm" data-testid="yard-inventory-table">
            <thead className="border-b border-border bg-surface/50 font-mono text-[11px] uppercase tracking-wider text-slate-500">
              <tr>
                {canManage && <th className="w-10 px-3 py-2.5"></th>}
                <th className="px-3 py-2.5 font-normal">Stock #</th>
                <th className="px-3 py-2.5 font-normal">Vehicle</th>
                <th className="px-3 py-2.5 font-normal">Checked In</th>
                <th className="px-3 py-2.5 font-normal">Paid / Cost</th>
                <th className="px-3 py-2.5 font-normal">Notes & Callers</th>
                {canManage && <th className="px-3 py-2.5 text-right font-normal">Action</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredVehicles.map((a) => {
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
