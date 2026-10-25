import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { apiGet, apiPost, errorMessage } from "@/lib/api";
import { useReps } from "@/lib/hooks";
import { awayInfo, useAway } from "@/pages/ShiftCalendar";
import { cn } from "@/lib/utils";
import type { CallbackAssign, CallbackAssignResult, CallbackList, CallbackListCreate } from "@/lib/types";

const sel = "h-9 w-full rounded-md border border-border bg-surface px-2 text-sm text-white";

export const useCallbackLists = (enabled = true) =>
  useQuery({ queryKey: ["callback-lists"], queryFn: () => apiGet<CallbackList[]>("/callback-lists"), enabled });

/** Manager: new named callback list for a rep. */
export function NewListForm({ onCreated }: { onCreated: (l: CallbackList) => void }) {
  const qc = useQueryClient();
  const reps = useReps();
  const away = useAway();
  const [name, setName] = useState("");
  const [rep, setRep] = useState("");
  const [due, setDue] = useState("");
  const create = useMutation({
    mutationFn: () => apiPost<CallbackList>("/callback-lists", { name, rep_id: rep, due_date: due || null } satisfies CallbackListCreate),
    onSuccess: (l) => (toast.success(`List "${l.name}" created for ${l.rep_name}`), qc.invalidateQueries({ queryKey: ["callback-lists"] }), onCreated(l)),
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <form className="grid gap-2 sm:grid-cols-[1fr_10rem_9.5rem_auto]" onSubmit={(e) => (e.preventDefault(), create.mutate())}>
      <Input data-testid="callback-list-name" value={name} onChange={(e) => setName(e.target.value.slice(0, 60))} placeholder='List name, e.g. "Ford owners to call"' className="h-9" />
      <select data-testid="callback-list-rep" value={rep} onChange={(e) => setRep(e.target.value)} className={sel}>
        <option value="">Assign to rep…</option>
        {(reps.data ?? []).map((r) => <option key={r.id} value={r.id} disabled={!!awayInfo(away.data, r.id)}>{r.name}{awayInfo(away.data, r.id)}</option>)}
      </select>
      <Input type="date" data-testid="callback-list-due" aria-label="Call by" title="Call-by date (optional)" value={due} onChange={(e) => setDue(e.target.value)} className="h-9" />
      <Button size="sm" type="submit" data-testid="callback-list-create" disabled={name.trim().length < 2 || !rep || create.isPending} className="h-9">Create list</Button>
    </form>
  );
}

/** Manager: put calls on a rep's Callbacks — straight to a rep, or onto a named list. */
export default function AddToCallbacks({ callIds, onDone, size = "sm", variant = "outline" }: { callIds: string[]; onDone?: () => void; size?: "sm" | "default"; variant?: "outline" | "default" }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"rep" | "list">("rep");
  const [rep, setRep] = useState("");
  const [listId, setListId] = useState("");
  const [note, setNote] = useState("");
  const [creating, setCreating] = useState(false);
  const reps = useReps(open);
  const away = useAway(open);
  const lists = useCallbackLists(open);
  const assign = useMutation({
    mutationFn: () => apiPost<CallbackAssignResult>("/callbacks/assign", { call_ids: callIds, rep_id: mode === "rep" ? rep : "", list_id: mode === "list" ? listId : "", note } satisfies CallbackAssign),
    onSuccess: (r) => {
      const who = mode === "rep" ? reps.data?.find((x) => x.id === rep)?.name : lists.data?.find((l) => l.id === listId)?.name;
      toast.success(`Added ${r.assigned} call${r.assigned === 1 ? "" : "s"} to ${who ?? "callbacks"}`);
      qc.invalidateQueries({ queryKey: ["callbacks"] });
      qc.invalidateQueries({ queryKey: ["callback-lists"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
      setOpen(false);
      setNote("");
      onDone?.();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <>
      <Button size={size} variant={variant} data-testid="add-to-callbacks-button" onClick={() => setOpen(true)} disabled={!callIds.length}>
        <ListPlus className="size-4" /> Add to callbacks
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid="add-to-callbacks-dialog" className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add {callIds.length} call{callIds.length === 1 ? "" : "s"} to callbacks</DialogTitle>
            <DialogDescription>They show up in the rep's Callbacks page until they're marked called back.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-surface p-1 text-sm">
            {(["rep", "list"] as const).map((m) => (
              <button key={m} type="button" data-testid={`add-to-callbacks-mode-${m}`} onClick={() => setMode(m)}
                className={cn("rounded-md py-1.5 transition-colors duration-150", mode === m ? "bg-sky-500/20 text-white" : "text-slate-400 hover:text-white")}>
                {m === "rep" ? "A rep's callbacks" : "A named list"}
              </button>
            ))}
          </div>
          {mode === "rep" ? (
            <select data-testid="add-to-callbacks-rep" value={rep} onChange={(e) => setRep(e.target.value)} className={sel}>
              <option value="">Pick a rep…</option>
              {(reps.data ?? []).map((r) => <option key={r.id} value={r.id} disabled={!!awayInfo(away.data, r.id)}>{r.name}{awayInfo(away.data, r.id)}</option>)}
            </select>
          ) : (
            <div className="space-y-2">
              <select data-testid="add-to-callbacks-list" value={listId} onChange={(e) => setListId(e.target.value)} className={sel}>
                <option value="">Pick a list…</option>
                {(lists.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.name} — {l.rep_name} ({l.open} open)</option>)}
              </select>
              {creating ? (
                <NewListForm onCreated={(l) => (setListId(l.id), setCreating(false))} />
              ) : (
                <button type="button" data-testid="add-to-callbacks-new-list" onClick={() => setCreating(true)} className="text-xs text-sky-400 hover:underline">+ New list</button>
              )}
            </div>
          )}
          <Input data-testid="add-to-callbacks-note" value={note} onChange={(e) => setNote(e.target.value.slice(0, 300))} placeholder="Note for the rep (optional), e.g. we just got a 2015 F-150 in" />
          <div className="flex justify-end">
            <Button data-testid="add-to-callbacks-save" disabled={assign.isPending || (mode === "rep" ? !rep : !listId)} onClick={() => assign.mutate()}>Add to callbacks</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
