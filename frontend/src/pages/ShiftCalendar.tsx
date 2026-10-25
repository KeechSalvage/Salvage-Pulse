import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ChevronLeft, ChevronRight, Mail, Plane, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Overline, PageHeader, Panel } from "@/components/common";
import { MONTH_LONG } from "@/components/CallsDrill";
import { apiDelete, apiGet, apiPost, apiPut, errorMessage } from "@/lib/api";
import { useReps } from "@/lib/hooks";
import { CoverRequestsOverview } from "@/components/CoverRequests";
import { cn } from "@/lib/utils";
import type { AwayRep, CoverageGap, CoverageSettings, OkResponse, TimeOff, TimeOffCreate } from "@/lib/types";

export const useAway = (enabled = true) =>
  useQuery({ queryKey: ["time-off", "away"], queryFn: () => apiGet<AwayRep[]>("/time-off/away"), enabled, staleTime: 60_000 });

/** Rep picker <option> label: "Tyler Grant (away until Oct 28)" and disabled while away. */
export function awayInfo(away: AwayRep[] | undefined, id: string) {
  const a = away?.find((x) => x.rep_id === id);
  return a ? ` (away until ${new Date(`${a.until}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })})` : "";
}

const COLORS = ["bg-sky-500/70", "bg-amber-500/70", "bg-emerald-500/70", "bg-violet-500/70", "bg-rose-500/70", "bg-teal-500/70"];
const sel = "h-9 rounded-md border border-border bg-surface px-2 text-sm text-white";
const fmt = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

export default function ShiftCalendar() {
  const qc = useQueryClient();
  const reps = useReps();
  const now = new Date();
  const [ym, setYm] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const month = `${ym.y}-${String(ym.m + 1).padStart(2, "0")}`;
  const { data } = useQuery({ queryKey: ["time-off", month], queryFn: () => apiGet<TimeOff[]>(`/time-off?month=${month}`) });
  const gaps = useQuery({ queryKey: ["time-off", "gaps", month], queryFn: () => apiGet<CoverageGap[]>(`/time-off/gaps?month=${month}`) });
  const cov = useQuery({ queryKey: ["settings", "coverage"], queryFn: () => apiGet<CoverageSettings>("/settings/coverage") });
  const saveCov = useMutation({
    mutationFn: (c: CoverageSettings) => apiPut<CoverageSettings>("/settings/coverage", c),
    onSuccess: (c) => (qc.setQueryData(["settings", "coverage"], c), qc.invalidateQueries({ queryKey: ["time-off", "gaps"] }), toast.success(`Warning at ${c.max_away}+ reps away, emailed ${c.warn_days_ahead} days ahead`)),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const brief = useMutation({
    mutationFn: (id: string) => apiPost<OkResponse>(`/time-off/${id}/briefing-preview`),
    onSuccess: () => toast.success("Welcome-back briefing sent"),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const gapDay = new Map((gaps.data ?? []).map((g) => [g.day, g.away]));
  const [f, setF] = useState<TimeOffCreate>({ rep_id: "", start: "", end: "", cover_rep_id: "", note: "" });
  const refresh = () => (qc.invalidateQueries({ queryKey: ["time-off"] }), qc.invalidateQueries({ queryKey: ["callback-lists"] }), qc.invalidateQueries({ queryKey: ["callbacks"] }));
  const add = useMutation({
    mutationFn: () => apiPost<TimeOff>("/time-off", f),
    onSuccess: (t) => {
      if (t.gap_days.length) toast.warning(`Short-staffed: ${t.gap_days.length} day${t.gap_days.length === 1 ? "" : "s"} now have ${cov.data?.max_away ?? 2}+ reps away (${t.gap_days.slice(0, 4).map(fmt).join(", ")}${t.gap_days.length > 4 ? "…" : ""})`, { duration: 8000 });
      toast.success(`${t.rep_name} is off ${fmt(t.start)}–${fmt(t.end)}${t.moved ? ` · ${t.moved} callbacks handed to ${t.cover_rep_name}` : t.cover_rep_name ? ` · ${t.cover_rep_name} covers from day one` : ""}`);
      setF({ rep_id: "", start: "", end: "", cover_rep_id: "", note: "" });
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const del = useMutation({ mutationFn: (id: string) => apiDelete(`/time-off/${id}`), onSuccess: () => (toast.success("Time off removed"), refresh()), onError: (e) => toast.error(errorMessage(e)) });
  const days = new Date(ym.y, ym.m + 1, 0).getDate();
  const first = (new Date(ym.y, ym.m, 1).getDay() + 6) % 7; // Monday-first
  const iso = (d: number) => `${month}-${String(d).padStart(2, "0")}`;
  const todayIso = now.toISOString().slice(0, 10);
  const color = (repId: string) => COLORS[Math.max(0, (reps.data ?? []).findIndex((r) => r.id === repId)) % COLORS.length];
  const shift = (n: number) => setYm(({ y, m }) => ({ y: m + n < 0 ? y - 1 : m + n > 11 ? y + 1 : y, m: (m + n + 12) % 12 }));
  return (
    <>
      <PageHeader overline="Team" title="Shift calendar" />
      <p className="-mt-4 mb-6 max-w-2xl text-sm text-slate-400">Mark who's away. Away reps can't be given callbacks, their overdue alerts pause, and if you pick a cover rep their open callbacks move over the morning the time off starts.</p>
      <Panel testId="timeoff-form-panel" className="mb-6">
        <Overline>Add time off</Overline>
        <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(e) => (e.preventDefault(), add.mutate())}>
          <select data-testid="timeoff-rep" value={f.rep_id} onChange={(e) => setF({ ...f, rep_id: e.target.value })} className={sel}>
            <option value="">Who's away…</option>
            {(reps.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <Input type="date" data-testid="timeoff-start" aria-label="First day off" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} className="h-9 w-40" />
          <span className="pb-2 text-sm text-slate-500">to</span>
          <Input type="date" data-testid="timeoff-end" aria-label="Last day off" value={f.end} min={f.start || undefined} onChange={(e) => setF({ ...f, end: e.target.value })} className="h-9 w-40" />
          <select data-testid="timeoff-cover" value={f.cover_rep_id} onChange={(e) => setF({ ...f, cover_rep_id: e.target.value })} className={sel}>
            <option value="">No cover — keep their callbacks</option>
            {(reps.data ?? []).filter((r) => r.id !== f.rep_id).map((r) => <option key={r.id} value={r.id}>Hand callbacks to {r.name}</option>)}
          </select>
          <Input data-testid="timeoff-note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value.slice(0, 120) })} placeholder="Note (vacation, training…)" className="h-9 w-48" />
          <Button type="submit" data-testid="timeoff-save" disabled={!f.rep_id || !f.start || !f.end || add.isPending}><Plane className="size-4" /> Add</Button>
        </form>
      </Panel>
      <Panel testId="coverage-settings" className="mb-6">
        <div className="flex flex-wrap items-center gap-3 text-sm text-slate-300">
          <AlertTriangle className="size-4 text-amber-300" />
          <span>Warn when</span>
          <Input key={`m${cov.data?.max_away}`} type="number" min={1} max={50} data-testid="coverage-max-away" defaultValue={cov.data?.max_away ?? 2} className="h-8 w-16"
            onBlur={(e) => cov.data && Number(e.target.value) !== cov.data.max_away && saveCov.mutate({ ...cov.data, max_away: Math.max(1, Number(e.target.value) || 1) })} />
          <span>or more reps are away the same day, and email managers</span>
          <Input key={`d${cov.data?.warn_days_ahead}`} type="number" min={1} max={14} data-testid="coverage-days-ahead" defaultValue={cov.data?.warn_days_ahead ?? 3} className="h-8 w-16"
            onBlur={(e) => cov.data && Number(e.target.value) !== cov.data.warn_days_ahead && saveCov.mutate({ ...cov.data, warn_days_ahead: Math.min(14, Math.max(1, Number(e.target.value) || 1)) })} />
          <span>days ahead.</span>
          {!!gaps.data?.length && <span data-testid="coverage-gap-count" className="ml-auto rounded bg-red-500/15 px-2 py-0.5 text-xs text-red-300">{gaps.data.length} short-staffed day{gaps.data.length === 1 ? "" : "s"} this month</span>}
        </div>
      </Panel>
      <CoverRequestsOverview />
      <Panel testId="shift-calendar">
        <div className="mb-4 flex items-center gap-3">
          <Button size="sm" variant="ghost" data-testid="calendar-prev" onClick={() => shift(-1)} aria-label="Previous month"><ChevronLeft className="size-4" /></Button>
          <h3 data-testid="calendar-month" className="text-lg font-bold text-white">{MONTH_LONG(month)}</h3>
          <Button size="sm" variant="ghost" data-testid="calendar-next" onClick={() => shift(1)} aria-label="Next month"><ChevronRight className="size-4" /></Button>
        </div>
        <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-border bg-border text-xs">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="bg-card px-2 py-1.5 font-mono uppercase text-slate-500">{d}</div>)}
          {Array.from({ length: first }, (_, i) => <div key={`b${i}`} className="min-h-20 bg-card/40" />)}
          {Array.from({ length: days }, (_, i) => {
            const d = iso(i + 1);
            const off = (data ?? []).filter((t) => t.start <= d && d <= t.end);
            return (
              <div key={d} data-testid={`calendar-day-${d}`} title={gapDay.has(d) ? `Short-staffed: ${gapDay.get(d)!.join(", ")} away` : undefined}
                className={cn("min-h-20 bg-card p-1.5", gapDay.has(d) && "bg-red-500/[0.08]", d === todayIso && "ring-1 ring-inset ring-amber-400")}>
                <p className="mb-1 flex items-center gap-1 font-mono text-slate-500">{i + 1}{gapDay.has(d) && <AlertTriangle data-testid={`calendar-gap-${d}`} className="size-3 text-red-400" />}</p>
                {off.map((t) => <p key={t.id} title={t.note} className={cn("mb-0.5 truncate rounded px-1.5 py-0.5 text-[11px] text-white", color(t.rep_id))}>{t.rep_name.split(" ")[0]}</p>)}
              </div>
            );
          })}
        </div>
        <ul className="mt-5 divide-y divide-border" data-testid="timeoff-list">
          {(data ?? []).map((t) => (
            <li key={t.id} data-testid={`timeoff-${t.id}`} className="flex flex-wrap items-center gap-3 py-2 text-sm">
              <span className={cn("size-2.5 rounded-full", color(t.rep_id))} />
              <span className="text-white">{t.rep_name}</span>
              <span className="font-mono text-xs text-slate-400">{fmt(t.start)} – {fmt(t.end)}</span>
              {t.note && <span className="text-xs text-slate-500">{t.note}</span>}
              {t.note.startsWith("Cover swap") && <span data-testid={`timeoff-swap-${t.id}`} className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] text-emerald-300">rep swap</span>}
              {t.cover_rep_name && <span className="text-xs text-sky-300">cover: {t.cover_rep_name}{t.handed_off ? ` · ${t.moved} handed off` : ""}</span>}
              <Button size="sm" variant="ghost" className="ml-auto" data-testid={`timeoff-briefing-${t.id}`} disabled={brief.isPending} onClick={() => brief.mutate(t.id)} title="Send the welcome-back email now (it goes out automatically the morning after the last day)">
                <Mail className="size-3.5" /> Briefing
              </Button>
              <Button size="sm" variant="ghost" data-testid={`timeoff-delete-${t.id}`} onClick={() => del.mutate(t.id)} aria-label="Remove"><Trash2 className="size-3.5" /></Button>
            </li>
          ))}
          {!data?.length && <li className="py-2 text-sm text-slate-500">Nobody is marked away this month.</li>}
        </ul>
      </Panel>
    </>
  );
}
