import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, MapPin, Minus, Pencil, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Overline, Panel } from "@/components/common";
import { apiDelete, apiGet, apiPatch, apiPost, errorMessage } from "@/lib/api";
import { lotQS } from "@/lib/lot";
import { cn } from "@/lib/utils";
import { useReps } from "@/lib/hooks";
import type { ExtraSitesResult, ExtraSitesUpdate, OrgInfo, RepSiteUpdate, SiteBoard, SiteCreate, SiteGoalUpdate, SiteList, SiteManagerUpdate, User } from "@/lib/types";

export const useSites = (enabled = true) => useQuery({ queryKey: ["sites"], queryFn: () => apiGet<SiteList>("/sites"), enabled, staleTime: 60_000 });

const sel = "h-10 rounded-md border border-border bg-surface px-2 text-sm text-white";

/** Location filter for the call library / reports — hidden until the yard has 2+ locations. */
export function SiteFilter({ value, onChange, testId }: { value: string; onChange: (v: string) => void; testId: string }) {
  const { data } = useSites();
  if (!data || (data.sites ?? []).length < 2) return null;
  return (
    <select data-testid={testId} value={value} onChange={(e) => onChange(e.target.value)} className={sel} aria-label="Location">
      <option value="">All locations</option>
      {(data.sites ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
    </select>
  );
}

/** One-tap lot pills ("All lots" + each lot). Hidden for yards with under 2 lots, and on the dashboard for a location manager (locked to their lot). */
export function LotSwitcher({ value, onChange, testId, allLabel = "All lots", hideForLotManager = false }: { value: string; onChange: (v: string) => void; testId: string; allLabel?: string; hideForLotManager?: boolean }) {
  const { data } = useSites();
  if (!data || (data.sites ?? []).length < 2 || (hideForLotManager && data.my_site_id)) return null;
  const opts = [{ id: "", name: allLabel }, ...(data.sites ?? []).map((s) => ({ id: s.id, name: s.name }))];
  return (
    <div role="radiogroup" aria-label="Location" data-testid={testId} className="inline-flex flex-wrap gap-1 rounded-full border border-border bg-card/70 p-1 backdrop-blur">
      {opts.map((o) => (
        <button key={o.id || "all"} type="button" role="radio" aria-checked={value === o.id} data-testid={`${testId}-${o.id || "all"}`} onClick={() => onChange(o.id)}
          className={cn("flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-[background-color,color] duration-150",
            value === o.id ? "bg-sky-500/20 text-white shadow-[inset_0_0_0_1px_var(--color-sky-500)]" : "text-slate-400 hover:bg-white/5 hover:text-white")}>
          {o.id ? <MapPin className="size-3" /> : null}{o.name}{o.id && o.id === data.my_site_id ? " (yours)" : ""}
        </button>
      ))}
    </div>
  );
}

/** Rep card: which location this rep works at. */
export function RepSiteSelect({ rep }: { rep: User }) {
  const qc = useQueryClient();
  const { data } = useSites();
  const save = useMutation({
    mutationFn: (site_id: string) => apiPatch<User>(`/users/reps/${rep.id}/site`, { site_id } satisfies RepSiteUpdate),
    onSuccess: (u) => (toast.success(`${u.name}: ${(data?.sites ?? []).find((s) => s.id === u.site_id)?.name ?? "no location"}`), qc.invalidateQueries({ queryKey: ["reps"] }), qc.invalidateQueries({ queryKey: ["sites"] })),
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!(data?.sites ?? []).length || data?.my_site_id) return null;
  return (
    <select data-testid={`rep-site-${rep.id}`} value={rep.site_id} disabled={save.isPending} aria-label="Location"
      onClick={(e) => (e.preventDefault(), e.stopPropagation())} onChange={(e) => save.mutate(e.target.value)}
      className="h-7 max-w-36 rounded border border-border bg-surface px-1.5 font-mono text-[11px] text-slate-300">
      <option value="">No location</option>
      {(data?.sites ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
    </select>
  );
}

/** Reps page: the yard's locations (up to the plan's limit). */
export function SitesPanel() {
  const qc = useQueryClient();
  const { data } = useSites();
  const [name, setName] = useState("");
  const [edit, setEdit] = useState<{ id: string; name: string } | null>(null);
  const set = (d: SiteList) => (qc.setQueryData(["sites"], d), qc.invalidateQueries({ queryKey: ["reps"] }));
  const add = useMutation({ mutationFn: () => apiPost<SiteList>("/sites", { name } satisfies SiteCreate), onSuccess: (d) => (set(d), setName(""), toast.success("Location added")), onError: (e) => toast.error(errorMessage(e)) });
  const rename = useMutation({ mutationFn: (e: { id: string; name: string }) => apiPatch<SiteList>(`/sites/${e.id}`, { name: e.name } satisfies SiteCreate), onSuccess: (d) => (set(d), setEdit(null)), onError: (e) => toast.error(errorMessage(e)) });
  const managers = useQuery({ queryKey: ["sites", "managers"], queryFn: () => apiGet<User[]>("/sites/managers") });
  const setMgr = useMutation({
    mutationFn: (e: { id: string; manager_id: string }) => apiPatch<SiteList>(`/sites/${e.id}/manager`, { manager_id: e.manager_id } satisfies SiteManagerUpdate),
    onSuccess: (d) => (set(d), toast.success("Location manager saved — they'll get the daily email for just this lot")),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const goal = useMutation({
    mutationFn: (e: { id: string; goal: number }) => apiPatch<SiteList>(`/sites/${e.id}/goal`, { goal: e.goal } satisfies SiteGoalUpdate),
    onSuccess: (d) => (set(d), qc.invalidateQueries({ queryKey: ["sites", "leaderboard"] }), toast.success("Monthly goal saved")),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const del = useMutation({ mutationFn: (id: string) => apiDelete<SiteList>(`/sites/${id}`), onSuccess: (d) => (set(d), toast("Location removed — its reps are unassigned")), onError: (e) => toast.error(errorMessage(e)) });
  if (!data) return null;
  const full = (data.sites ?? []).length >= data.limit;
  const lotMgr = !!data.my_site_id;
  const visible = lotMgr ? (data.sites ?? []).filter((x) => x.id === data.my_site_id) : (data.sites ?? []);
  return (
    <Panel testId="sites-panel">
      <div className="flex flex-wrap items-center gap-2">
        <MapPin className="size-4 text-sky-300" /><Overline>Locations</Overline>
        <span data-testid="sites-usage" className="ml-auto font-mono text-xs text-slate-400">{(data.sites ?? []).length} of {data.limit} on {data.plan_name}</span>
      </div>
      <p className="mt-1 text-sm text-slate-400">Put each rep at a location to filter calls, rep cards and reports by lot. A location manager also gets the daily follow-up email for just their lot.</p>
      <ul className="mt-3 flex flex-wrap gap-2">
        {visible.map((s) => (
          <li key={s.id} data-testid={`site-${s.id}`} className="flex items-center gap-2 rounded-lg border border-border bg-surface/60 px-3 py-1.5 text-sm">
            {edit?.id === s.id ? (
              <form className="flex items-center gap-1" onSubmit={(e) => (e.preventDefault(), edit.name.trim() && rename.mutate(edit))}>
                <Input autoFocus data-testid={`site-rename-input-${s.id}`} value={edit.name} maxLength={60} onChange={(e) => setEdit({ ...edit, name: e.target.value })} className="h-7 w-36" />
                <button type="submit" aria-label="Save name" data-testid={`site-rename-save-${s.id}`}><Check className="size-4 text-emerald-300" /></button>
                <button type="button" aria-label="Cancel" onClick={() => setEdit(null)}><X className="size-4 text-slate-400" /></button>
              </form>
            ) : (
              <>
                <span className="text-white">{s.name}</span>
                <span className="font-mono text-[11px] text-slate-500">{s.reps} rep{s.reps === 1 ? "" : "s"}</span>
                {!lotMgr && <select data-testid={`site-manager-${s.id}`} value={s.manager_id} aria-label={`${s.name} manager`} onChange={(e) => setMgr.mutate({ id: s.id, manager_id: e.target.value })}
                  title="Location manager — gets the daily follow-up email for just this lot" className="h-7 max-w-40 rounded border border-border bg-surface px-1 font-mono text-[11px] text-slate-300">
                  <option value="">No location manager</option>
                  {(managers.data ?? []).map((m) => <option key={m.id} value={m.id}>Mgr: {m.name}</option>)}
                </select>}
                <span className="flex items-center gap-1 font-mono text-[11px] text-slate-400">
                  goal $
                  <input type="number" min={0} step={500} defaultValue={s.goal || ""} key={`${s.id}-${s.goal}`} placeholder="none" data-testid={`site-goal-${s.id}`} aria-label={`${s.name} monthly sales goal`}
                    onBlur={(e) => Number(e.target.value || 0) !== s.goal && goal.mutate({ id: s.id, goal: Math.max(0, Number(e.target.value || 0)) })}
                    className="h-7 w-20 rounded border border-border bg-surface px-1 text-slate-200" />/mo
                </span>
                {!lotMgr && <>
                <button type="button" aria-label={`Rename ${s.name}`} data-testid={`site-rename-${s.id}`} onClick={() => setEdit({ id: s.id, name: s.name })} className="text-slate-500 transition-colors duration-150 hover:text-white"><Pencil className="size-3.5" /></button>
                <button type="button" aria-label={`Remove ${s.name}`} data-testid={`site-delete-${s.id}`} onClick={() => del.mutate(s.id)} className="text-slate-500 transition-colors duration-150 hover:text-red-300"><Trash2 className="size-3.5" /></button>
                </>}
              </>
            )}
          </li>
        ))}
      </ul>
      {lotMgr && <p data-testid="sites-lot-manager-note" className="mt-3 text-xs text-sky-300">You manage this location — you see and manage only its reps, calls, callbacks and reports.</p>}
      {!lotMgr && data.sites.length > 0 && <LotBoard sites={data} />}
      {!lotMgr && <form className="mt-3 flex flex-wrap items-center gap-2" onSubmit={(e) => (e.preventDefault(), name.trim() && add.mutate())}>
        <Input data-testid="site-name-input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder={full ? "Location limit reached" : "e.g. North lot"} disabled={full} className="h-9 w-56" />
        <Button size="sm" type="submit" data-testid="site-add" disabled={full || !name.trim() || add.isPending}><Plus className="size-3.5" /> Add location</Button>
        {full && <span data-testid="sites-full" className={cn("text-xs", "text-amber-200")}>{data.plan_name === "Enterprise Platinum" ? "Add more locations on the Billing page ($100/mo each)." : data.limit === 1 ? "More locations come with Enterprise (2) and Enterprise Platinum (4+)." : "Enterprise Platinum includes 4 locations, plus more at $100/mo each."}</span>}
      </form>}
    </Panel>
  );
}

const usd = (n: number) => `$${Math.round(n).toLocaleString()}`;

/** Team Dashboard: each location side by side — calls, close rate, sales. */
export function LocationLeaderboard({ lot = "" }: { lot?: string }) {
  const { data: sl } = useSites();
  const [days, setDays] = useState(30);
  const { data } = useQuery({ queryKey: ["sites", "leaderboard", days, lot], queryFn: () => apiGet<SiteBoard>(`/sites/leaderboard?days=${days}${lotQS(lot, "&")}`), enabled: ((sl?.sites ?? []).length) > 0 });
  if (!(sl?.sites ?? []).length || !data || !sl) return null;
  const top = Math.max(1, ...(data.rows ?? []).map((r) => r.revenue));
  return (
    <Panel testId="location-leaderboard" className="mb-6">
      <div className="flex flex-wrap items-center gap-2">
        <MapPin className="size-4 text-sky-300" /><Overline>{sl.my_site_id ? "Your location" : lot ? "This location" : "Locations side by side"}</Overline>
        <div className="ml-auto flex gap-1">
          {[7, 30, 90].map((d) => (
            <button key={d} type="button" data-testid={`location-board-days-${d}`} onClick={() => setDays(d)}
              className={cn("rounded-full border px-2.5 py-0.5 font-mono text-[11px] transition-colors duration-150", days === d ? "border-sky-500 bg-sky-500/15 text-white" : "border-border text-slate-400 hover:text-white")}>
              {d}d
            </button>
          ))}
        </div>
      </div>
      <div className="mt-4 grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min((data.rows ?? []).length, 4)}, minmax(0, 1fr))` }}>
        {(data.rows ?? []).map((r, i) => (
          <div key={r.site_id || "none"} data-testid={`location-board-${r.site_id || "none"}`} className={cn("rounded-xl border p-4", i === 0 && r.revenue > 0 ? "border-amber-400/50 bg-amber-500/[0.06]" : "border-border bg-surface/50")}>
            <p className="flex items-center gap-1.5 text-sm font-semibold text-white">{i === 0 && r.revenue > 0 && <span aria-hidden>🏆</span>}{r.name}</p>
            <p className="font-mono text-[11px] text-slate-500">{r.reps} rep{r.reps === 1 ? "" : "s"}</p>
            <p data-testid={`location-board-revenue-${r.site_id || "none"}`} className="mt-3 font-heading text-2xl font-bold text-white">{usd(r.revenue)}</p>
            <div className="mt-1 h-1.5 rounded-full bg-border"><div className="h-1.5 rounded-full bg-amber-400 transition-[width] duration-300" style={{ width: `${(r.revenue / top) * 100}%` }} /></div>
            {r.goal > 0 && (
              <div className="mt-3" data-testid={`location-goal-${r.site_id || "none"}`}>
                <div className="flex justify-between font-mono text-[10px] text-slate-400">
                  <span>This month {usd(r.month_revenue)}</span><span>goal {usd(r.goal)}</span>
                </div>
                <div className="mt-1 h-2 rounded-full bg-border">
                  <div className={cn("h-2 rounded-full transition-[width] duration-500", r.month_revenue >= r.goal ? "bg-emerald-400" : "bg-sky-400")} style={{ width: `${Math.min(100, (r.month_revenue / r.goal) * 100)}%` }} />
                </div>
                <p className="mt-0.5 font-mono text-[10px] text-slate-500">{r.month_revenue >= r.goal ? "Goal hit 🎉" : `${Math.round((r.month_revenue / r.goal) * 100)}% · ${usd(r.goal - r.month_revenue)} to go`}</p>
              </div>
            )}
            <dl className="mt-3 grid grid-cols-2 gap-1 text-xs">
              <dt className="text-slate-500">Calls</dt><dd data-testid={`location-board-calls-${r.site_id || "none"}`} className="text-right font-mono text-slate-200">{r.calls}</dd>
              <dt className="text-slate-500">Close rate</dt><dd data-testid={`location-board-close-${r.site_id || "none"}`} className="text-right font-mono text-slate-200">{r.close_rate}%</dd>
              <dt className="text-slate-500">Sales won</dt><dd className="text-right font-mono text-slate-200">{r.won} / {r.sales_calls}</dd>
            </dl>
          </div>
        ))}
      </div>
    </Panel>
  );
}

/** Billing (Enterprise Platinum): add or drop $100/mo locations — prorated on the Stripe bill right away. */
export function ExtraSitesCard({ org }: { org: OrgInfo }) {
  const qc = useQueryClient();
  const [n, setN] = useState(org.extra_sites);
  const [confirm, setConfirm] = useState(false);
  const save = useMutation({
    mutationFn: () => apiPost<ExtraSitesResult>("/billing/extra-sites", { extra_sites: n } satisfies ExtraSitesUpdate),
    onSuccess: (r) => (toast.success(`Now ${r.max_sites} locations · extra locations $${r.monthly_cost}/mo`), setConfirm(false), qc.invalidateQueries({ queryKey: ["org"] }), qc.invalidateQueries({ queryKey: ["sites"] })),
    onError: (e) => (toast.error(errorMessage(e)), setConfirm(false)),
  });
  const diff = n - org.extra_sites;
  const minExtra = Math.max(0, org.sites_used - 4);
  return (
    <div data-testid="extra-sites-card" className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface/60 px-4 py-3 text-sm">
      <MapPin className="size-4 text-sky-300" />
      <span className="text-slate-200">4 locations included · extra locations <strong>$100/mo each</strong></span>
      <span className="ml-auto flex items-center gap-2">
        <Button size="icon" variant="ghost" aria-label="One fewer" data-testid="extra-sites-minus" disabled={n <= minExtra} onClick={() => (setN(n - 1), setConfirm(false))}><Minus className="size-4" /></Button>
        <span data-testid="extra-sites-count" className="w-8 text-center font-mono text-lg text-white">{n}</span>
        <Button size="icon" variant="ghost" aria-label="One more" data-testid="extra-sites-plus" disabled={n >= 50} onClick={() => (setN(n + 1), setConfirm(false))}><Plus className="size-4" /></Button>
        <span className="font-mono text-xs text-slate-400">= ${n * 100}/mo</span>
        {diff !== 0 && (confirm ? (
          <>
            <span data-testid="extra-sites-confirm-text" className="text-xs text-amber-200">{diff > 0 ? `Adds $${diff * 100}/mo (prorated today)` : `Saves $${-diff * 100}/mo (credit on next bill)`}</span>
            <Button size="sm" data-testid="extra-sites-confirm" disabled={save.isPending} onClick={() => save.mutate()}>Confirm</Button>
            <Button size="sm" variant="ghost" data-testid="extra-sites-cancel" onClick={() => (setN(org.extra_sites), setConfirm(false))}>Cancel</Button>
          </>
        ) : (
          <Button size="sm" data-testid="extra-sites-save" onClick={() => setConfirm(true)}>{diff > 0 ? `Add ${diff}` : `Remove ${-diff}`}</Button>
        ))}
      </span>
      {minExtra > 0 && <p className="w-full text-[11px] text-slate-500">You have {org.sites_used} locations set up — remove one on the Reps page to drop below {minExtra} extra.</p>}
    </div>
  );
}

/** Reps page: drag a rep onto another lot. Their past calls stay with the lot they were at. */
function LotBoard({ sites }: { sites: SiteList }) {
  const qc = useQueryClient();
  const reps = useReps();
  const [over, setOver] = useState<string | null>(null);
  const move = useMutation({
    mutationFn: (e: { rep: User; site_id: string }) => apiPatch<User>(`/users/reps/${e.rep.id}/site`, { site_id: e.site_id } satisfies RepSiteUpdate),
    onSuccess: (u) => (toast.success(`${u.name} moved to ${(sites.sites ?? []).find((x) => x.id === u.site_id)?.name ?? "no location"} — past calls stay with their old lot`),
      ["reps", "sites", "calls", "report"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }))),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const cols = [...(sites.sites ?? []).map((x) => ({ id: x.id, name: x.name })), { id: "", name: "No location" }];
  const list = (reps.data ?? []).filter((r) => r.name !== "Unassigned");
  const drop = (site_id: string, e: React.DragEvent) => {
    e.preventDefault();
    setOver(null);
    const rep = list.find((r) => r.id === e.dataTransfer.getData("text/rep"));
    if (rep && rep.site_id !== site_id) move.mutate({ rep, site_id });
  };
  return (
    <div className="mt-4" data-testid="lot-board">
      <p className="mb-2 font-mono text-[11px] uppercase tracking-wider text-slate-500">Drag reps between lots</p>
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(cols.length, 5)}, minmax(0, 1fr))` }}>
        {cols.map((c) => (
          <div key={c.id || "none"} data-testid={`lot-col-${c.id || "none"}`}
            onDragOver={(e) => (e.preventDefault(), setOver(c.id))} onDragLeave={() => setOver(null)} onDrop={(e) => drop(c.id, e)}
            className={cn("min-h-24 rounded-lg border border-dashed p-2 transition-colors duration-150", over === c.id ? "border-sky-400 bg-sky-500/10" : "border-border bg-surface/40")}>
            <p className="mb-1.5 text-xs font-semibold text-slate-300">{c.name}</p>
            <div className="flex flex-wrap gap-1.5">
              {list.filter((r) => (r.site_id || "") === c.id || (c.id === "" && r.site_id && !(sites.sites ?? []).some((x) => x.id === r.site_id))).map((r) => (
                <span key={r.id} draggable data-testid={`lot-chip-${r.id}`} onDragStart={(e) => e.dataTransfer.setData("text/rep", r.id)}
                  className="cursor-grab rounded-full border border-border bg-card px-2.5 py-1 text-xs text-white shadow-sm transition-transform duration-150 hover:-translate-y-0.5 active:cursor-grabbing">
                  {r.name}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
