import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ListPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { apiPost, errorMessage } from "@/lib/api";
import { useReps } from "@/lib/hooks";
import { awayInfo, useAway } from "@/pages/ShiftCalendar";
import type { Arrival, ArrivalListCreate, CallbackList } from "@/lib/types";

/** Right after logging a vehicle: offer to turn its waiting callers into a callback list for one rep. */
export default function ArrivalListPrompt({ arrival, onClose }: { arrival: Arrival | null; onClose: () => void }) {
  const qc = useQueryClient();
  const reps = useReps(!!arrival);
  const away = useAway(!!arrival);
  const [rep, setRep] = useState("");
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
  const make = useMutation({
    mutationFn: () => apiPost<CallbackList>(`/arrivals/${arrival!.id}/callback-list`, { rep_id: rep, name, due_date: due || null } satisfies ArrivalListCreate),
    onSuccess: (l) => {
      toast.success(`${l.total} callers added to ${l.rep_name}'s callbacks as "${l.name}"`);
      qc.invalidateQueries({ queryKey: ["callback-lists"] });
      qc.invalidateQueries({ queryKey: ["callbacks"] });
      qc.invalidateQueries({ queryKey: ["arrivals"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
      setRep("");
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
            <span data-testid="arrival-list-waiting">{waiting} caller{waiting === 1 ? "" : "s"}</span> asked about a {vehicle}. Put them on one rep's Callbacks so they get called today.
          </DialogDescription>
        </DialogHeader>
        <select data-testid="arrival-list-rep" value={rep} onChange={(e) => setRep(e.target.value)} className="h-9 w-full rounded-md border border-border bg-surface px-2 text-sm text-white">
          <option value="">Pick a rep…</option>
          {(reps.data ?? []).map((r) => {
            const count = repCounts[r.id] || 0;
            const countLabel = count === 1 ? "1 matching call" : `${count} matching calls`;
            const awayStatus = awayInfo(away.data, r.id);
            return (
              <option key={r.id} value={r.id} disabled={!!awayStatus}>
                {r.name} — {countLabel}{awayStatus ? ` ${awayStatus}` : ""}
              </option>
            );
          })}
        </select>
        <Input data-testid="arrival-list-name" value={name} onChange={(e) => setName(e.target.value.slice(0, 60))} placeholder={`${vehicle} callers`} />
        <label className="flex items-center gap-2 text-sm text-slate-300">
          Call by
          <Input type="date" data-testid="arrival-list-due" value={due} onChange={(e) => setDue(e.target.value)} className="h-9 w-44" />
          <span className="text-xs text-slate-500">optional</span>
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" data-testid="arrival-list-skip" onClick={onClose}>Not now</Button>
          <Button data-testid="arrival-list-create" disabled={!rep || make.isPending} onClick={() => make.mutate()}>
            <ListPlus className="size-4" /> Make list
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
