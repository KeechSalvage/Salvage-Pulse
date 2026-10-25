import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardList, PhoneCall, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Overline, Panel } from "@/components/common";
import { apiDelete, apiGet, apiPost, errorMessage } from "@/lib/api";
import { useReps } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import type { Assignment, AssignmentCreate, Scenario } from "@/lib/types";

const STATUS: Record<Assignment["status"], string> = {
  done: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  open: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  overdue: "border-red-500/40 bg-red-500/10 text-red-300",
};
const due = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function AssignDialog({ open, onClose, scenarios }: { open: boolean; onClose: () => void; scenarios: Scenario[] }) {
  const qc = useQueryClient();
  const reps = useReps(open);
  const [f, setF] = useState<AssignmentCreate>({ scenario_id: "", rep_ids: [], due_date: "", pass_score: 70 });
  const title = (id: string) => scenarios.find((s) => s.id === id)?.title ?? "Pick a role-play";
  const save = useMutation({
    mutationFn: () => apiPost<Assignment[]>("/roleplay/assignments", f),
    onSuccess: (a) => {
      toast.success(`Assigned to ${a.length} rep${a.length === 1 ? "" : "s"}`);
      qc.invalidateQueries({ queryKey: ["roleplay-assignments"] });
      setF({ scenario_id: "", rep_ids: [], due_date: "", pass_score: 70 });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const toggle = (id: string) => setF((p) => ({ ...p, rep_ids: p.rep_ids.includes(id) ? p.rep_ids.filter((x) => x !== id) : [...p.rep_ids, id] }));
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg" data-testid="assign-dialog">
        <DialogHeader>
          <DialogTitle>Assign a role-play</DialogTitle>
          <DialogDescription>Reps see it on their Role-Play page. It counts as done once they score at or above the passing score.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label>Role-play</Label>
            <Select value={f.scenario_id} onValueChange={(v) => setF({ ...f, scenario_id: v })}>
              <SelectTrigger data-testid="assign-scenario-select" className="w-full">
                <SelectValue>{(v) => title(v as string)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {scenarios.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.title}
                    {s.custom ? " (yours)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>Reps</Label>
            <div className="grid max-h-44 grid-cols-2 gap-2 overflow-y-auto rounded-lg border border-border p-3">
              {(reps.data ?? []).map((r) => (
                <label key={r.id} className="flex items-center gap-2 text-sm text-slate-200">
                  <Checkbox data-testid={`assign-rep-${r.id}`} checked={f.rep_ids.includes(r.id)} onCheckedChange={() => toggle(r.id)} />
                  {r.name}
                </label>
              ))}
              {reps.data?.length === 0 && <p className="col-span-2 text-sm text-slate-500">Add reps on the Reps page first.</p>}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="as-due">Due date</Label>
              <Input id="as-due" type="date" data-testid="assign-due-input" value={f.due_date} onChange={(e) => setF({ ...f, due_date: e.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="as-pass">Passing score (0–100)</Label>
              <Input
                id="as-pass"
                inputMode="numeric"
                data-testid="assign-pass-input"
                value={String(f.pass_score)}
                onChange={(e) => setF({ ...f, pass_score: Math.min(100, Number(e.target.value.replace(/\D/g, "") || 0)) })}
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button data-testid="assign-save-button" disabled={!f.scenario_id || !f.rep_ids.length || !f.due_date || save.isPending} onClick={() => save.mutate()}>
            Assign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const REP_HEADERS = ["Role-play", "Due", "Pass", "Best", "Status", ""];
const MANAGER_HEADERS = ["Rep", ...REP_HEADERS];

export default function RoleplayAssignments({ isManager, scenarios, onStart }: { isManager: boolean; scenarios: Scenario[]; onStart: (scenarioId: string) => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data } = useQuery({ queryKey: ["roleplay-assignments"], queryFn: () => apiGet<Assignment[]>("/roleplay/assignments") });
  const remove = useMutation({
    mutationFn: (id: string) => apiDelete(`/roleplay/assignments/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["roleplay-assignments"] }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const rows = data ?? [];
  if (!isManager && rows.length === 0) return null;
  const done = rows.filter((r) => r.status === "done").length;
  return (
    <Panel className="mb-6" testId="roleplay-assignments-panel">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ClipboardList className="size-4 text-amber-300" />
          <Overline>{isManager ? "Assigned role-plays" : "Assigned to you"}</Overline>
          {rows.length > 0 && (
            <span data-testid="assignments-progress" className="font-mono text-xs text-slate-500">
              {done}/{rows.length} done
            </span>
          )}
        </div>
        {isManager && (
          <Button size="sm" data-testid="assign-roleplay-button" onClick={() => setOpen(true)}>
            <Plus className="size-4" /> Assign role-play
          </Button>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">Assign a role-play to a rep with a due date and passing score to track who has practised.</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="font-mono text-[11px] uppercase tracking-wider text-slate-500">
              <tr>
                {(isManager ? MANAGER_HEADERS : REP_HEADERS).map((h, i) => (
                  <th key={`${h}-${i}`} className="py-2 pr-3 text-left font-normal">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((a) => (
                <tr key={a.id} data-testid={`assignment-row-${a.id}`}>
                  {isManager && <td className="py-2 pr-3 text-white">{a.rep_name}</td>}
                  <td className="py-2 pr-3 text-slate-200">{a.scenario_title}</td>
                  <td className="pr-3 font-mono text-xs text-slate-400">{due(a.due_date)}</td>
                  <td className="pr-3 font-mono text-xs text-slate-400">{a.pass_score}+</td>
                  <td className="pr-3 font-mono text-xs" data-testid={`assignment-best-${a.id}`}>
                    {a.best_score ?? "—"}
                    {a.attempts > 0 && <span className="text-slate-500"> ({a.attempts} tries)</span>}
                  </td>
                  <td className="pr-3">
                    <span data-testid={`assignment-status-${a.id}`} className={cn("rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider", STATUS[a.status])}>
                      {a.status}
                    </span>
                  </td>
                  <td className="text-right">
                    {isManager ? (
                      <button data-testid={`assignment-delete-${a.id}`} title="Remove" onClick={() => remove.mutate(a.id)} className="text-slate-500 transition-colors duration-150 hover:text-red-400">
                        <Trash2 className="size-4" />
                      </button>
                    ) : (
                      a.status !== "done" && (
                        <Button size="sm" variant="outline" data-testid={`assignment-start-${a.id}`} onClick={() => onStart(a.scenario_id)}>
                          <PhoneCall className="size-3.5" /> Start
                        </Button>
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {isManager && <AssignDialog open={open} onClose={() => setOpen(false)} scenarios={scenarios} />}
    </Panel>
  );
}
