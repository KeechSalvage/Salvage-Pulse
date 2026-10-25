import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Power } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiGet, apiPatch, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Overline, Panel } from "@/components/common";
import type { RepLoginEvent, RepLoginResult, RepLoginUpdate, RepOpenWork, User } from "@/lib/types";

export const useLoginLog = () => useQuery({ queryKey: ["reps", "login-log"], queryFn: () => apiGet<RepLoginEvent[]>("/users/reps/login-log") });
export const whenShort = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const whenLong = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

/** Reps page: every login off/on, newest first — who did it, when, and any hand-over. */
export function RepLoginLog() {
  const { data } = useLoginLog();
  const [all, setAll] = useState(false);
  const rows = all ? data ?? [] : (data ?? []).slice(0, 8);
  return (
    <Panel testId="rep-login-log">
      <div className="flex items-center gap-2"><Power className="size-4 text-slate-400" /><Overline>Login changes</Overline></div>
      {!data?.length ? (
        <p className="mt-3 text-sm text-slate-500" data-testid="rep-login-log-empty">No rep logins have been turned off or on yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-border">
          {rows.map((e) => (
            <li key={e.id} data-testid={`rep-login-log-${e.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
              <span className={cn("rounded px-2 py-0.5 font-mono text-[11px]", e.action === "off" ? "bg-red-500/15 text-red-300" : "bg-emerald-500/15 text-emerald-300")}>{e.action === "off" ? "Turned off" : "Turned on"}</span>
              <span className="text-white">{e.rep_name}</span>
              <span className="text-slate-400">by {e.by}{e.source === "platform" ? " (Platform console)" : ""}</span>
              {e.moved > 0 && <span className="text-xs text-sky-300">{e.moved} callback{e.moved === 1 ? "" : "s"} → {e.moved_to}</span>}
              <span className="ml-auto font-mono text-xs text-slate-500">{whenLong(e.at)}</span>
            </li>
          ))}
        </ul>
      )}
      {(data?.length ?? 0) > 8 && (
        <Button size="sm" variant="ghost" className="mt-2" data-testid="rep-login-log-toggle" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${data!.length}`}</Button>
      )}
    </Panel>
  );
}

const sel = "h-9 w-full rounded-md border border-border bg-surface px-2 text-sm text-white";

/** Reps page: turn a rep's login off (with an optional hand-over of their open callbacks) or back on. */
export default function RepLoginToggle({ rep, reps }: { rep: User; reps: User[] }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [moveTo, setMoveTo] = useState("");
  const work = useQuery({ queryKey: ["reps", "open-work", rep.id], queryFn: () => apiGet<RepOpenWork>(`/users/reps/${rep.id}/open-work`), enabled: open });
  const save = useMutation({
    mutationFn: (b: RepLoginUpdate) => apiPatch<RepLoginResult>(`/users/reps/${rep.id}/login`, b),
    onSuccess: (r) => {
      const to = reps.find((x) => x.id === moveTo)?.name;
      toast.success(r.user.disabled ? `${rep.name}'s login is off — signed out everywhere${r.moved ? ` · ${r.moved} callbacks moved to ${to}` : ""}` : `${rep.name} can sign in again`);
      ["reps", "callbacks", "callback-lists", "cover-requests", "org"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      setOpen(false);
      setMoveTo("");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const stop = (e: React.MouseEvent) => (e.preventDefault(), e.stopPropagation());
  const others = reps.filter((r) => r.id !== rep.id && !r.disabled);
  const hasWork = (work.data?.callbacks ?? 0) + (work.data?.lists ?? 0) > 0;
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        data-testid={`rep-login-toggle-${rep.id}`}
        disabled={save.isPending}
        onClick={(e) => (stop(e), rep.disabled ? save.mutate({ disabled: false, move_to_rep_id: "" }) : setOpen(true))}
        className={cn("h-7 gap-1 px-2 text-xs", rep.disabled ? "text-emerald-300 hover:text-emerald-200" : "text-slate-400 hover:text-red-300")}
      >
        <Power className="size-3.5" /> {rep.disabled ? "Turn login on" : "Turn login off"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid={`rep-login-dialog-${rep.id}`} onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Turn off {rep.name}'s login?</DialogTitle>
            <DialogDescription>They're signed out everywhere and can't sign in. They also drop out of every rep picker, so nobody can hand them callbacks, lists, cover swaps or role-plays. Their calls and stats stay, and you can turn the login back on any time.</DialogDescription>
          </DialogHeader>
          {work.isLoading ? (
            <Loader2 className="size-4 animate-spin text-slate-400" />
          ) : hasWork ? (
            <div className="space-y-2 text-sm">
              <p data-testid="rep-login-open-work" className="text-amber-200">
                {rep.name.split(" ")[0]} has {work.data!.callbacks} open callback{work.data!.callbacks === 1 ? "" : "s"}{work.data!.lists ? ` in ${work.data!.lists} list${work.data!.lists === 1 ? "" : "s"}` : ""}.
              </p>
              <select data-testid="rep-login-move-to" value={moveTo} onChange={(e) => setMoveTo(e.target.value)} className={sel}>
                <option value="">Leave them where they are</option>
                {others.map((r) => <option key={r.id} value={r.id}>Hand them to {r.name}</option>)}
              </select>
            </div>
          ) : (
            <p className="text-sm text-slate-400">No open callbacks to hand over.</p>
          )}
          <DialogFooter>
            <Button variant="ghost" data-testid="rep-login-cancel" onClick={() => setOpen(false)}>Keep it on</Button>
            <Button variant="destructive" data-testid="rep-login-confirm" disabled={save.isPending} onClick={() => save.mutate({ disabled: true, move_to_rep_id: moveTo })}>
              {save.isPending && <Loader2 className="size-4 animate-spin" />} Turn login off
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
