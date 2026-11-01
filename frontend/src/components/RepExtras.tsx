import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { MessageSquareText, Printer, Truck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Overline, Panel } from "@/components/common";
import { apiGet, apiPut, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { DeliveryStats, MobileNumber } from "@/lib/types";

/** Rep's own page: the mobile number overdue-list texts go to. */
export function MobileCard() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["me", "mobile"], queryFn: () => apiGet<MobileNumber>("/me/mobile") });
  if (!data) return null;
  return <MobileForm key={JSON.stringify(data)} data={data} onSaved={(m) => qc.setQueryData(["me", "mobile"], m)} />;
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function MobileForm({ data, onSaved }: { data: MobileNumber; onSaved: (m: MobileNumber) => void }) {
  const [f, setF] = useState<MobileNumber>(data);
  const dirty = JSON.stringify(f) !== JSON.stringify(data);
  const save = useMutation({
    mutationFn: () => apiPut<MobileNumber>("/me/mobile", { ...f, vacation_start: f.vacation_start || null, vacation_end: f.vacation_end || null } satisfies MobileNumber),
    onSuccess: (m) => (onSaved(m), toast.success(m.mobile ? `Texts will go to ${m.mobile}` : "Mobile number removed")),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const today = new Date().toISOString().slice(0, 10);
  const onVacation = !!(data.vacation_start && data.vacation_end && data.vacation_start <= today && today <= data.vacation_end);
  return (
    <Panel testId="mobile-card" className="mb-6">
      <form className="flex flex-wrap items-center gap-3" onSubmit={(e) => (e.preventDefault(), save.mutate())}>
        <MessageSquareText className="size-4 text-sky-300" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-white">Text me on the yard floor</p>
          <p className="text-xs text-slate-500">We text this number the morning one of your callback lists goes overdue.</p>
        </div>
        <Input data-testid="mobile-input" inputMode="tel" value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value.slice(0, 20) })} placeholder="(555) 123-4567" className="h-9 w-44" />
        <Button size="sm" type="submit" data-testid="mobile-save" disabled={!dirty || save.isPending}>Save</Button>
        <div className="flex w-full flex-wrap items-center gap-x-6 gap-y-3 border-t border-border pt-3 text-xs text-slate-400">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1">No texts on</span>
            {DAYS.map((d, i) => {
              const on = f.days_off.includes(i);
              return (
                <button key={d} type="button" data-testid={`mobile-day-off-${i}`} aria-pressed={on} onClick={() => setF({ ...f, days_off: on ? f.days_off.filter((x) => x !== i) : [...f.days_off, i].sort() })}
                  className={cn("rounded-full border px-2.5 py-1 transition-colors duration-150", on ? "border-amber-500 bg-amber-500/15 text-amber-200" : "border-border text-slate-400 hover:text-white")}>
                  {d}
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span>Vacation</span>
            <Input type="date" data-testid="mobile-vacation-start" value={f.vacation_start ?? ""} onChange={(e) => setF({ ...f, vacation_start: e.target.value || null })} className="h-8 w-40" />
            <span>to</span>
            <Input type="date" data-testid="mobile-vacation-end" value={f.vacation_end ?? ""} min={f.vacation_start ?? undefined} onChange={(e) => setF({ ...f, vacation_end: e.target.value || null })} className="h-8 w-40" />
            {(f.vacation_start || f.vacation_end) && (
              <button type="button" data-testid="mobile-vacation-clear" onClick={() => setF({ ...f, vacation_start: null, vacation_end: null })} className="text-slate-500 hover:text-white">clear</button>
            )}
          </div>
          {onVacation && <span data-testid="mobile-paused" className="rounded bg-amber-500/15 px-2 py-0.5 text-amber-200">Texts paused — you're on vacation</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
          <span>Quiet hours — only text me during my shift</span>
          <Input type="time" data-testid="mobile-shift-start" aria-label="Shift starts" value={f.shift_start} onChange={(e) => setF({ ...f, shift_start: e.target.value })} className="h-8 w-32" />
          <span>to</span>
          <Input type="time" data-testid="mobile-shift-end" aria-label="Shift ends" value={f.shift_end} onChange={(e) => setF({ ...f, shift_end: e.target.value })} className="h-8 w-32" />
          {(f.shift_start || f.shift_end) && (
            <button type="button" data-testid="mobile-shift-clear" onClick={() => setF({ ...f, shift_start: "", shift_end: "" })} className="text-slate-500 hover:text-white">clear</button>
          )}
          <span className="w-full text-[11px] text-slate-500">
            {f.shift_start && f.shift_end ? `Texts that come in outside ${f.shift_start}–${f.shift_end} wait and arrive when your next shift starts.` : "No quiet hours — texts can arrive any time (except days off and vacation)."}
          </span>
          {data.held > 0 && <span data-testid="mobile-held" className="rounded bg-sky-500/15 px-2 py-0.5 text-sky-200">{data.held} text{data.held === 1 ? "" : "s"} waiting for your shift</span>}
        </div>
      </form>
    </Panel>
  );
}

/** Performance page: average delivery checklist score and the step skipped most. */
export function DeliveryCoaching({ repId }: { repId?: string }) {
  const { data } = useQuery({
    queryKey: ["delivery-stats", repId ?? "me"],
    queryFn: () => apiGet<DeliveryStats>(`/delivery-stats${repId ? `?rep_id=${repId}` : ""}`),
  });
  if (!data || !data.calls) return null;
  const weak = (data.steps ?? []).find((s) => s.key === data.weakest);
  return (
    <Panel testId="delivery-coaching">
      <div className="flex items-center gap-2">
        <Truck className="size-4 text-sky-300" />
        <Overline>Delivery calls</Overline>
      </div>
      <div className="mt-2 flex flex-wrap items-end gap-6">
        <div>
          <p data-testid="delivery-avg-score" className="font-heading text-4xl font-bold text-white">{data.avg_score ?? "—"}</p>
          <p className="text-xs text-slate-500">avg checklist score · {data.checked} of {data.calls} delivery calls checked</p>
        </div>
        {weak && (
          <p data-testid="delivery-weakest" className="rounded-lg border border-amber-500/40 bg-amber-500/[0.06] px-3 py-2 text-sm text-amber-200">
            Skipped most: <strong>{weak.label}</strong> — done on {weak.pct}% of calls
          </p>
        )}
      </div>
      {data.checked > 0 && (
        <ul className="mt-4 space-y-2">
          {(data.steps ?? []).map((s) => (
            <li key={s.key} data-testid={`delivery-step-${s.key}`}>
              <div className="flex justify-between text-sm">
                <span className={cn(s.key === data.weakest ? "text-amber-200" : "text-slate-300")}>{s.label}</span>
                <span className="font-mono text-xs text-slate-400">{s.done}/{data.checked} · {s.pct}%</span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-slate-800">
                <div className={cn("h-full rounded-full transition-[width] duration-500", s.key === data.weakest ? "bg-amber-400" : "bg-emerald-500")} style={{ width: `${s.pct}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function PosterButton({ repId }: { repId: string }) {
  return (
    <Link to={`/poster/${repId}`} target="_blank" data-testid="trophy-poster-button"
      className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm text-slate-200 transition-colors duration-150 hover:border-amber-400 hover:text-white">
      <Printer className="size-4" /> Trophy poster
    </Link>
  );
}
