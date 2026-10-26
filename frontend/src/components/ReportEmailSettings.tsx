import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Settings2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { apiGet, apiPut, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { MonthlyReportSettings, MonthlyReportSettingsOut } from "@/lib/types";
import { isManagerLike } from "@/lib/types";

/** Manager: who gets the 1st-of-month report email, plus extra addresses (owner, bookkeeper). */
export default function ReportEmailSettings() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" data-testid="report-email-settings" onClick={() => setOpen(true)}><Settings2 className="size-4" /> Email recipients</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid="report-email-settings-dialog" className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Monthly report email</DialogTitle>
            <DialogDescription>Sent on the 1st with last month's numbers. Managers and extra addresses get the whole-yard report; reps get only their own calls.</DialogDescription>
          </DialogHeader>
          {open && <SettingsForm onDone={() => setOpen(false)} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

function SettingsForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["settings", "monthly-report"], queryFn: () => apiGet<MonthlyReportSettingsOut>("/settings/monthly-report") });
  if (!data) return <div className="h-40 animate-pulse rounded-lg bg-surface" />;
  return <Form data={data} onSaved={(d) => (qc.setQueryData(["settings", "monthly-report"], d), onDone())} />;
}

function Form({ data, onSaved }: { data: MonthlyReportSettingsOut; onSaved: (d: MonthlyReportSettingsOut) => void }) {
  const [enabled, setEnabled] = useState(data.enabled);
  const [ids, setIds] = useState<Set<string>>(new Set(data.user_ids ?? data.people.map((p) => p.id)));
  const [extras, setExtras] = useState<string[]>(data.extra_emails);
  const [draft, setDraft] = useState("");
  const save = useMutation({
    mutationFn: () => {
      const all = data.people.every((p) => ids.has(p.id));
      return apiPut<MonthlyReportSettingsOut>("/settings/monthly-report", { enabled, user_ids: all ? null : [...ids], extra_emails: extras } satisfies MonthlyReportSettings);
    },
    onSuccess: (d) => (toast.success("Monthly email recipients saved"), onSaved(d)),
    onError: (e) => toast.error(errorMessage(e, "Check the email addresses")),
  });
  const toggle = (id: string) => setIds((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const addExtra = () => {
    const e = draft.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return toast.error("Enter a valid email address");
    if (extras.length >= 5) return toast.error("Up to 5 extra addresses");
    if (!extras.includes(e)) setExtras([...extras, e]);
    setDraft("");
  };
  return (
    <div className="space-y-5">
      <label className="flex items-center gap-2 text-sm text-white">
        <input type="checkbox" data-testid="report-email-enabled" className="size-4 accent-sky-500" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Send the monthly report email
      </label>
      <section className={cn(!enabled && "pointer-events-none opacity-50")}>
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-sm font-semibold text-white">Team</h4>
          <div className="flex gap-3 text-xs">
            <button type="button" data-testid="report-email-all" className="text-sky-400 hover:underline" onClick={() => setIds(new Set(data.people.map((p) => p.id)))}>Everyone</button>
            <button type="button" data-testid="report-email-none" className="text-slate-400 hover:underline" onClick={() => setIds(new Set())}>Nobody</button>
          </div>
        </div>
        <ul className="divide-y divide-border rounded-lg border border-border">
          {data.people.map((p) => (
            <li key={p.id}>
              <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                <input type="checkbox" data-testid={`report-email-person-${p.id}`} className="size-4 accent-sky-500" checked={ids.has(p.id)} onChange={() => toggle(p.id)} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-white">{p.name}</span>
                  <span className="block truncate font-mono text-[11px] text-slate-500">{p.email}</span>
                </span>
                <span className="font-mono text-[10px] uppercase text-slate-500">{isManagerLike(p.role) ? "yard report" : "own calls"}</span>
              </label>
            </li>
          ))}
        </ul>
      </section>
      <section className={cn(!enabled && "pointer-events-none opacity-50")}>
        <h4 className="mb-2 text-sm font-semibold text-white">Extra addresses</h4>
        <p className="mb-2 text-xs text-slate-500">Owner, bookkeeper or anyone else — they get the whole-yard report.</p>
        <form className="flex gap-2" onSubmit={(e) => (e.preventDefault(), addExtra())}>
          <Input data-testid="report-email-extra-input" type="email" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="owner@youryard.com" className="h-9" />
          <Button size="sm" variant="outline" type="submit" data-testid="report-email-extra-add">Add</Button>
        </form>
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {extras.map((e) => (
            <li key={e} data-testid={`report-email-extra-${e}`} className="flex items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-1 text-xs text-slate-200">
              {e}
              <button type="button" aria-label={`Remove ${e}`} data-testid={`report-email-extra-remove-${e}`} onClick={() => setExtras(extras.filter((x) => x !== e))} className="text-slate-500 hover:text-white"><X className="size-3" /></button>
            </li>
          ))}
        </ul>
      </section>
      <div className="flex items-center justify-between border-t border-border pt-4">
        <span className="text-xs text-slate-500" data-testid="report-email-count">{enabled ? `${ids.size + extras.length} recipient${ids.size + extras.length === 1 ? "" : "s"}` : "Paused"}</span>
        <Button data-testid="report-email-save" disabled={save.isPending} onClick={() => save.mutate()}>Save</Button>
      </div>
    </div>
  );
}
