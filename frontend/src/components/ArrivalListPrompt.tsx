import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ListPlus, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { apiPost, errorMessage } from "@/lib/api";
import { useReps } from "@/lib/hooks";
import { awayInfo, useAway } from "@/pages/ShiftCalendar";
import type { Arrival, ArrivalListCreate, CallbackList } from "@/lib/types";

/** Right after logging a vehicle: offer to turn its waiting callers into a callback list for one or more reps/managers. */
export default function ArrivalListPrompt({ arrival, onClose }: { arrival: Arrival | null; onClose: () => void }) {
  const qc = useQueryClient();
  const reps = useReps(!!arrival, true); // includes sales managers
  const away = useAway(!!arrival);
  const [selectedReps, setSelectedReps] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [due, setDue] = useState("");
  const waitingCallers = arrival?.callers.filter((c) => c.status === "to_call" && c.last_call_id) ?? [];
  const waiting = waitingCallers.length;
  const vehicle = arrival ? `${arrival.vehicle_year} ${arrival.vehicle_make} ${arrival.vehicle_model}` : "";

  // Count how many of these waiting callers originally spoke with each rep
  const repCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const c of waitingCallers) {
      if (c.rep_id) {
        counts[c.rep_id] = (counts[c.rep_id] || 0) + 1;
      }
    }
    return counts;
  }, [waitingCallers]);

  const toggleRep = (id: string) => {
    setSelectedReps((prev) =>
      prev.includes(id) ? prev.filter((r) => r !== id) : [...prev, id]
    );
  };

  const make = useMutation({
    mutationFn: () =>
      apiPost<CallbackList>(`/arrivals/${arrival!.id}/callback-list`, {
        rep_ids: selectedReps,
        rep_id: selectedReps[0],
        name,
        due_date: due || null,
      } satisfies ArrivalListCreate),
    onSuccess: (l) => {
      const repCount = selectedReps.length;
      toast.success(
        repCount > 1
          ? `${l.total} callers assigned across ${repCount} reps as "${l.name}"`
          : `${l.total} callers added to ${l.rep_name}'s callbacks as "${l.name}"`
      );
      qc.invalidateQueries({ queryKey: ["callback-lists"] });
      qc.invalidateQueries({ queryKey: ["callbacks"] });
      qc.invalidateQueries({ queryKey: ["arrivals"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
      setSelectedReps([]);
      setName("");
      setDue("");
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Dialog open={!!arrival && waiting > 0} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="arrival-list-prompt" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Make a callback list?</DialogTitle>
          <DialogDescription>
            <span data-testid="arrival-list-waiting">{waiting} caller{waiting === 1 ? "" : "s"}</span> asked about a {vehicle}. Assign them to reps so they get called today.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span className="flex items-center gap-1.5 font-medium text-slate-300">
              <Users className="size-3.5 text-amber-300" /> Assign to reps & sales managers:
            </span>
            <span>{selectedReps.length} selected</span>
          </div>

          <div className="max-h-48 overflow-y-auto rounded-lg border border-border bg-surface/50 p-2 space-y-1 divide-y divide-border/40">
            {(reps.data ?? []).map((r) => {
              const count = repCounts[r.id] || 0;
              const countLabel = count === 1 ? "1 matching call" : `${count} matching calls`;
              const awayStatus = awayInfo(away.data, r.id);
              const checked = selectedReps.includes(r.id);
              const isSalesMgr = r.role === "sales_manager";

              return (
                <label
                  key={r.id}
                  className={`flex items-center justify-between gap-2.5 px-2 py-1.5 rounded cursor-pointer transition-colors pt-2 first:pt-1.5 ${
                    checked ? "bg-amber-500/10 text-white" : "hover:bg-slate-800/40 text-slate-300"
                  } ${awayStatus ? "opacity-60" : ""}`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() => toggleRep(r.id)}
                      disabled={!!awayStatus}
                      data-testid={`arrival-list-rep-check-${r.id}`}
                    />
                    <div className="truncate">
                      <span className="text-sm font-medium">{r.name}</span>
                      {isSalesMgr && (
                        <span className="ml-1.5 rounded bg-blue-500/20 text-blue-300 px-1.5 py-0.2 font-mono text-[10px]">
                          Sales Mgr
                        </span>
                      )}
                      {awayStatus && (
                        <span className="ml-1.5 text-xs text-amber-400/80">{awayStatus}</span>
                      )}
                    </div>
                  </div>
                  <span
                    className={`font-mono text-xs shrink-0 ${
                      count > 0 ? "text-emerald-400 font-semibold" : "text-slate-500"
                    }`}
                  >
                    {countLabel}
                  </span>
                </label>
              );
            })}
          </div>
        </div>

        <Input
          data-testid="arrival-list-name"
          value={name}
          onChange={(e) => setName(e.target.value.slice(0, 60))}
          placeholder={`${vehicle} callers`}
        />
        <label className="flex items-center gap-2 text-sm text-slate-300">
          Call by
          <Input
            type="date"
            data-testid="arrival-list-due"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            className="h-9 w-44"
          />
          <span className="text-xs text-slate-500">optional</span>
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" data-testid="arrival-list-skip" onClick={onClose}>
            Not now
          </Button>
          <Button
            data-testid="arrival-list-create"
            disabled={selectedReps.length === 0 || make.isPending}
            onClick={() => make.mutate()}
          >
            <ListPlus className="size-4" /> Make list ({selectedReps.length || 0})
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
