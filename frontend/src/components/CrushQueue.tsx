import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertOctagon, Calendar, Flame, RotateCcw, Search, Trash2, Clock } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Overline, Panel, fmtMoney } from "@/components/common";
import { apiGet, apiPatch, apiPost, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useMe } from "@/lib/hooks";
import type { Arrival } from "@/lib/types";
import { canManageInventory } from "@/lib/types";

/**
 * "To be crushed" Crushing Queue:
 * Dedicated box on the Vehicles & Stock tab.
 * Allows Owners and Inventory Managers to manage vehicles queued for crushing,
 * with a strictly number-formatted text box for days until crushed.
 * Once a vehicle hits its crush deadline (or days reach 0), it goes away entirely.
 */
export default function CrushQueue({ isManager }: { isManager?: boolean }) {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const canManage = canManageInventory(me?.role);

  const { data, isLoading } = useQuery({
    queryKey: ["arrivals"],
    queryFn: () => apiGet<Arrival[]>("/arrivals"),
  });

  const [searchQ, setSearchQ] = useState("");
  // Local state for the number-only text boxes per arrival id
  const [daysState, setDaysState] = useState<Record<string, string>>({});

  const crushVehicles = (data ?? []).filter((a) => a.inventory_status === "to_be_crushed");

  const q = searchQ.trim().toLowerCase();
  const filteredVehicles = crushVehicles.filter(
    (a) =>
      !q ||
      a.stock_number.toLowerCase().includes(q) ||
      `${a.vehicle_year} ${a.vehicle_make} ${a.vehicle_model}`.toLowerCase().includes(q) ||
      (a.note && a.note.toLowerCase().includes(q)),
  );

  const updateDaysMutation = useMutation({
    mutationFn: ({ aid, days }: { aid: string; days: number }) =>
      apiPatch<any>(`/arrivals/${aid}/crush-days`, { days }),
    onSuccess: (res, vars) => {
      if (res?.crushed || vars.days <= 0) {
        toast.success("Vehicle reached crush deadline and was removed entirely from inventory.");
      } else {
        toast.success(`Crush deadline updated to ${vars.days} days.`);
      }
      qc.invalidateQueries({ queryKey: ["arrivals"] });
    },
    onError: (e) => toast.error(errorMessage(e, "Failed to update crush days")),
  });

  const crushNowMutation = useMutation({
    mutationFn: (aid: string) => apiPost<{ ok: boolean; crushed: boolean }>(`/arrivals/${aid}/crush`, {}),
    onSuccess: () => {
      toast.success("Vehicle crushed and removed entirely from inventory.");
      qc.invalidateQueries({ queryKey: ["arrivals"] });
    },
    onError: (e) => toast.error(errorMessage(e, "Failed to crush vehicle")),
  });

  const restoreMutation = useMutation({
    mutationFn: (aid: string) => apiPost<Arrival>(`/arrivals/${aid}/restore`, {}),
    onSuccess: (a) => {
      toast.success(`${a.vehicle_year} ${a.vehicle_make} ${a.vehicle_model} restored to Yard Inventory.`);
      qc.invalidateQueries({ queryKey: ["arrivals"] });
    },
    onError: (e) => toast.error(errorMessage(e, "Failed to restore vehicle")),
  });

  const handleSaveDays = (arrival: Arrival) => {
    const rawVal = daysState[arrival.id] ?? String(arrival.days_remaining ?? arrival.days_until_crushed ?? 30);
    const parsed = Number(rawVal.replace(/\D/g, ""));

    if (parsed <= 0) {
      if (
        window.confirm(
          `Setting days to 0 means this ${arrival.vehicle_year} ${arrival.vehicle_make} ${arrival.vehicle_model} hits its crush deadline immediately and will be removed entirely from inventory. Proceed?`,
        )
      ) {
        updateDaysMutation.mutate({ aid: arrival.id, days: 0 });
      }
    } else {
      updateDaysMutation.mutate({ aid: arrival.id, days: parsed });
    }
  };

  const handleCrushNow = (arrival: Arrival) => {
    if (
      window.confirm(
        `Are you sure you want to crush the ${arrival.vehicle_year} ${arrival.vehicle_make} ${arrival.vehicle_model} (#${arrival.stock_number || "no stock"}) now? It will go away entirely.`,
      )
    ) {
      crushNowMutation.mutate(arrival.id);
    }
  };

  const handleRestore = (aid: string) => {
    restoreMutation.mutate(aid);
  };

  return (
    <Panel testId="to-be-crushed-panel">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Flame className="size-4 text-rose-400" />
          <Overline>To be crushed</Overline>
          <span
            data-testid="crush-queue-count"
            className="rounded bg-rose-500/15 px-2 py-0.5 font-mono text-[11px] font-semibold text-rose-300 ring-1 ring-rose-500/30"
          >
            {crushVehicles.length} in queue
          </span>
        </div>

        {crushVehicles.length > 0 && (
          <div className="relative w-full sm:w-60">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-slate-500" />
            <Input
              data-testid="crush-search-input"
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              placeholder="Search crush queue…"
              className="h-8 pl-8 text-xs"
            />
          </div>
        )}
      </div>

      <p className="mt-1 text-xs text-slate-500">
        Crushing queue — vehicles scheduled for scrap disposal. Change the days until crushed as needed.
        Once a car hits the crush deadline, it goes away entirely.
      </p>

      {/* Queue Table */}
      {filteredVehicles.length === 0 ? (
        <div className="py-8 text-center text-slate-500" data-testid="crush-queue-empty">
          {crushVehicles.length === 0 ? (
            <>
              <Flame className="mx-auto size-8 text-slate-600 mb-2" />
              <p className="text-sm font-medium text-slate-400">Crushing queue is empty</p>
              <p className="mt-1 text-xs text-slate-500">
                To schedule cars for crushing, select them in Yard Inventory and click "Push to Crush Queue".
              </p>
            </>
          ) : (
            <p className="text-sm">No vehicles match "{searchQ}"</p>
          )}
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm" data-testid="crush-queue-table">
            <thead className="border-b border-border bg-surface/50 font-mono text-[11px] uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-3 py-2.5 font-normal">Stock #</th>
                <th className="px-3 py-2.5 font-normal">Vehicle</th>
                <th className="px-3 py-2.5 font-normal">Queued</th>
                <th className="px-3 py-2.5 font-normal">Days Until Crushed</th>
                <th className="px-3 py-2.5 font-normal">Deadline & Status</th>
                <th className="px-3 py-2.5 font-normal">Cost</th>
                {canManage && <th className="px-3 py-2.5 text-right font-normal">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredVehicles.map((a) => {
                const daysRemaining = a.days_remaining ?? a.days_until_crushed ?? 30;
                const isUrgent = daysRemaining <= 7;
                const isCritical = daysRemaining <= 1;

                const currentInputVal =
                  daysState[a.id] ?? String(daysRemaining);

                return (
                  <tr
                    key={a.id}
                    data-testid={`crush-row-${a.id}`}
                    className={cn(
                      "transition-colors duration-150 hover:bg-surface/60",
                      isCritical && "bg-rose-500/5",
                    )}
                  >
                    <td className="px-3 py-3">
                      <span className="font-mono text-xs font-semibold text-amber-300">
                        {a.stock_number || "—"}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <p className="font-medium text-white">
                        {a.vehicle_year} {a.vehicle_make} {a.vehicle_model}
                      </p>
                      {a.note && <p className="text-xs text-slate-400">{a.note}</p>}
                    </td>
                    <td className="px-3 py-3 font-mono text-xs text-slate-400">
                      {a.queued_for_crush_at
                        ? new Date(a.queued_for_crush_at).toLocaleDateString()
                        : "Queued"}
                    </td>

                    {/* Number-only text box for Days until crushed */}
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-1.5">
                        <Input
                          type="text"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          data-testid={`crush-days-input-${a.id}`}
                          aria-label={`Days until crushed for ${a.vehicle_year} ${a.vehicle_make} ${a.vehicle_model}`}
                          disabled={!canManage || updateDaysMutation.isPending}
                          value={currentInputVal}
                          onChange={(e) => {
                            // Strictly numbers only: remove all non-digits
                            const numbersOnly = e.target.value.replace(/\D/g, "");
                            setDaysState((prev) => ({ ...prev, [a.id]: numbersOnly }));
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              handleSaveDays(a);
                            }
                          }}
                          className="h-8 w-16 text-center font-mono font-bold text-white bg-slate-900 border-border"
                          placeholder="Days"
                        />
                        <span className="text-xs text-slate-400 font-mono">days</span>

                        {canManage && (
                          <Button
                            size="sm"
                            variant="secondary"
                            data-testid={`crush-days-save-${a.id}`}
                            onClick={() => handleSaveDays(a)}
                            disabled={updateDaysMutation.isPending}
                            className="h-8 px-2 text-xs font-mono"
                          >
                            Set
                          </Button>
                        )}
                      </div>
                    </td>

                    {/* Deadline & Status Badge */}
                    <td className="px-3 py-3">
                      <div className="space-y-1">
                        <span
                          data-testid={`crush-status-badge-${a.id}`}
                          className={cn(
                            "inline-flex items-center gap-1 rounded px-2 py-0.5 font-mono text-xs font-semibold ring-1",
                            isCritical
                              ? "bg-rose-500/20 text-rose-300 ring-rose-500/40"
                              : isUrgent
                              ? "bg-amber-500/20 text-amber-300 ring-amber-500/40"
                              : "bg-slate-800 text-slate-300 ring-border",
                          )}
                        >
                          <Clock className="size-3" />
                          {isCritical
                            ? "Crushing soon (today)"
                            : `${daysRemaining} day${daysRemaining === 1 ? "" : "s"} left`}
                        </span>
                        {a.crush_deadline && (
                          <p className="font-mono text-[11px] text-slate-500">
                            Deadline: {new Date(a.crush_deadline).toLocaleDateString()}
                          </p>
                        )}
                      </div>
                    </td>

                    <td className="px-3 py-3 font-mono text-xs text-slate-300">
                      {a.cost != null ? fmtMoney(a.cost) : "—"}
                    </td>

                    {canManage && (
                      <td className="px-3 py-3 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <Button
                            size="sm"
                            variant="ghost"
                            data-testid={`restore-yard-btn-${a.id}`}
                            onClick={() => handleRestore(a.id)}
                            disabled={restoreMutation.isPending}
                            title="Restore back to Yard Inventory"
                            className="h-7 px-2 text-xs text-slate-400 hover:text-white"
                          >
                            <RotateCcw className="mr-1 size-3" />
                            Restore
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            data-testid={`crush-now-btn-${a.id}`}
                            onClick={() => handleCrushNow(a)}
                            disabled={crushNowMutation.isPending}
                            className="h-7 px-2 text-xs font-medium"
                          >
                            <Flame className="mr-1 size-3" />
                            Crush Now
                          </Button>
                        </div>
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
