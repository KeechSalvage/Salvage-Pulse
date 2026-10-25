import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Mail, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Overline, Panel } from "@/components/common";
import { useMe } from "@/lib/hooks";
import { apiGet, apiPost, apiPut, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { AdminCancel, AdminOrg, SignupAlert, FreeDayStats, FreeDayYard, Funnel, ReminderPreview, RemindersToggle, TrialReminders, DemoLoginSwitch } from "@/lib/types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const STEPS = [
  { k: "signups", label: "Sign-ups", c: "bg-sky-400/70" },
  { k: "cards_added", label: "Cards added", c: "bg-amber-400/70" },
  { k: "paid", label: "Paying", c: "bg-emerald-400/70" },
  { k: "canceled", label: "Canceled", c: "bg-red-400/70" },
] as const;

const OUTCOME: Record<FreeDayYard["outcome"], { label: string; cls: string }> = {
  on_free_day: { label: "On free day", cls: "border-sky-500/40 bg-sky-500/10 text-sky-200" },
  added_card: { label: "Added card", cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200" },
  no_card: { label: "No card", cls: "border-slate-600 bg-slate-500/10 text-slate-300" },
};

function FreeDayStat({ label, value, sub, testId, tone = "text-white" }: { label: string; value: string | number; sub?: string; testId: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p data-testid={testId} className={cn("mt-1 font-heading text-3xl font-extrabold", tone)}>
        {value}
      </p>
      {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

/** One tap (plus a confirm) cancels and blocks every still-open yard in an abuse alert, via the audited per-yard cancel. */
function CancelNetworkButton({ alert }: { alert: SignupAlert }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const cancel = useMutation({
    mutationFn: async () => {
      const body: AdminCancel = { reason: `Abuse: ${alert.count} free-day yards from network ${alert.network} in 24h`, block: true };
      const results = await Promise.allSettled(alert.org_ids.map((id) => apiPost<AdminOrg>(`/admin/orgs/${id}/cancel`, body)));
      return { ok: results.filter((r) => r.status === "fulfilled").length, failed: results.filter((r) => r.status === "rejected").length };
    },
    onSuccess: ({ ok, failed }) => {
      if (failed) toast.error(`Canceled ${ok}, but ${failed} couldn't be canceled — try again`);
      else toast.success(`Canceled and blocked ${ok} ${ok === 1 ? "yard" : "yards"}`);
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["admin"] });
    },
    onError: (e) => toast.error(errorMessage(e, "Couldn't cancel these yards")),
  });
  return (
    <>
      <Button size="sm" variant="destructive" data-testid={`admin-free-day-cancel-${alert.network}`} onClick={() => setOpen(true)}>
        Cancel these yards
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid="admin-free-day-cancel-dialog">
          <DialogHeader>
            <DialogTitle>Cancel {alert.count} free-day yards?</DialogTitle>
            <DialogDescription>
              {alert.yards.join(", ")} will be locked and blocked from starting another trial. Any Stripe billing stops. This is logged in the audit trail.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" data-testid="admin-free-day-cancel-keep" onClick={() => setOpen(false)}>
              Keep them
            </Button>
            <Button variant="destructive" data-testid="admin-free-day-cancel-confirm" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
              Cancel & block {alert.count}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Self-serve free days (no card) → how many went on to add a card. */
export function FreeDayPanel() {
  const { data, isError } = useQuery({ queryKey: ["admin", "free-day"], queryFn: () => apiGet<FreeDayStats>("/admin/free-day") });
  const finished = data ? data.added_card + data.no_card : 0;
  return (
    <Panel testId="admin-free-day-panel" className="mt-6">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-amber-400/90">Trial conversion</p>
      <h3 className="mt-1 text-xl font-bold text-white">Free day → card added</h3>
      <p className="mt-1 text-sm text-slate-400">Yards that signed up for the no-card free day, and how many went on to add a card for the 7-day trial.</p>
      {isError && <p className="mt-4 text-sm text-red-300">Couldn't load trial conversion.</p>}
      {data && data.started === 0 && (
        <p data-testid="admin-free-day-empty" className="mt-4 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-slate-500">
          No free-day sign-ups yet. They'll show up here as soon as a yard signs up.
        </p>
      )}
      {data && data.alerts.length > 0 && (
        <div data-testid="admin-free-day-alerts" className="mt-4 space-y-2 rounded-lg border border-red-500/40 bg-red-500/[0.07] p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-red-200">
            <ShieldAlert className="size-4" /> Several free-day yards from one network in the last 24 hours
          </p>
          {data.alerts.map((a) => (
            <div key={a.network} data-testid={`admin-free-day-alert-${a.network}`} className="flex flex-wrap items-center gap-3 text-sm">
              <span className="font-mono text-xs text-red-300">{a.network}</span>
              <span className="rounded-full border border-red-500/40 px-2 py-0.5 font-mono text-[11px] text-red-200">{a.count} yards</span>
              <span className="text-slate-300">{a.yards.join(" · ")}</span>
              <span className="ml-auto font-mono text-[11px] text-slate-500">latest {new Date(a.last_at).toLocaleString()}</span>
              <CancelNetworkButton alert={a} />
            </div>
          ))}
          <p className="text-xs text-slate-500">The same network can open at most 3 a day. Use “Cancel trial” in the yards table above if they look like abuse.</p>
        </div>
      )}
      {data && data.started > 0 && (
        <>
          <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <FreeDayStat label="Conversion" value={`${data.conversion_rate}%`} sub={`${data.added_card} of ${finished} finished free days`} testId="admin-free-day-rate" tone="text-emerald-300" />
            <FreeDayStat label="Free days started" value={data.started} sub={`${data.started_30d} in the last 30 days`} testId="admin-free-day-started" />
            <FreeDayStat label="Added a card" value={data.added_card} sub={`${data.added_during_day} before the day ran out · ${data.added_card_30d} in 30 days`} testId="admin-free-day-carded" />
            <FreeDayStat
              label="Time to card"
              value={data.median_hours_to_card === null ? "—" : `${data.median_hours_to_card}h`}
              sub={`median · ${data.on_free_day} on a free day now · ${data.no_card} left without a card`}
              testId="admin-free-day-median"
            />
          </div>
          {finished > 0 && (
            <div className="mt-4 flex h-2 overflow-hidden rounded-full bg-slate-800" data-testid="admin-free-day-bar">
              <div className="bg-emerald-400/80 transition-[width] duration-500" style={{ width: `${(100 * data.added_card) / finished}%` }} />
            </div>
          )}
          <div className="mt-5 divide-y divide-border" data-testid="admin-free-day-recent">
            {data.recent.map((y) => (
              <div key={y.org_id} data-testid={`admin-free-day-yard-${y.org_id}`} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                <span className="min-w-[180px] flex-1 font-medium text-white">{y.name}</span>
                <span className="font-mono text-xs text-slate-500">started {new Date(y.started_at).toLocaleDateString()}</span>
                {y.card_added_at && <span className="font-mono text-xs text-slate-500">card {new Date(y.card_added_at).toLocaleDateString()}</span>}
                <span className={cn("rounded-full border px-2.5 py-0.5 text-xs", OUTCOME[y.outcome].cls)}>{OUTCOME[y.outcome].label}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}

export function FunnelPanel() {
  const { data } = useQuery({ queryKey: ["admin", "funnel"], queryFn: () => apiGet<Funnel>("/admin/funnel") });
  if (!data) return null;
  const max = Math.max(1, ...data.months.flatMap((m) => STEPS.map((s) => m[s.k])));
  const t = data.totals;
  const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "—");
  return (
    <Panel testId="admin-funnel-panel" className="mt-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h3 className="text-xl font-bold text-white">Trial funnel</h3>
          <p className="text-xs text-slate-500">Yards by the month each step happened (demo yard excluded). {data.trialing_now} on a trial right now.</p>
        </div>
        <div className="flex gap-6 font-mono text-xs text-slate-400" data-testid="admin-funnel-rates">
          <span>Card rate <b className="text-white">{pct(t.cards_added, t.signups)}</b></span>
          <span>Paid rate <b className="text-white">{pct(t.paid, t.signups)}</b></span>
          <span>Cancel rate <b className="text-white">{pct(t.canceled, t.signups)}</b></span>
        </div>
      </div>
      <div className="mt-5 grid grid-cols-6 gap-3">
        {data.months.map((m) => (
          <div key={m.month} data-testid={`admin-funnel-month-${m.month}`} className="rounded-lg border border-border bg-surface p-3">
            <p className="font-mono text-[11px] uppercase text-slate-500">{MONTHS[Number(m.month.slice(5)) - 1]} {m.month.slice(2, 4)}</p>
            <div className="mt-2 flex h-16 items-end gap-1">
              {STEPS.map((s) => (
                <div key={s.k} title={`${s.label}: ${m[s.k]}`} className={cn("w-full rounded-sm", s.c)} style={{ height: `${Math.max(3, (m[s.k] / max) * 64)}px` }} />
              ))}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-x-2 font-mono text-[11px] text-slate-400">
              {STEPS.map((s) => (
                <span key={s.k}>{s.label.split(" ")[0]} <b className="text-slate-100">{m[s.k]}</b></span>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-[11px] text-slate-500">
        {STEPS.map((s) => (
          <span key={s.k} className="flex items-center gap-1.5"><span className={cn("size-2 rounded-sm", s.c)} />{s.label}</span>
        ))}
      </div>
    </Panel>
  );
}

export function RemindersPanel({ isMaster }: { isMaster: boolean }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["admin", "reminders"], queryFn: () => apiGet<TrialReminders>("/admin/trial-reminders") });
  const [preview, setPreview] = useState<ReminderPreview | null>(null);
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => apiPut<TrialReminders>("/admin/trial-reminders", { enabled } satisfies RemindersToggle),
    onSuccess: (d) => {
      qc.setQueryData(["admin", "reminders"], d);
      toast.success(d.enabled ? "Trial reminder emails are ON" : "Trial reminder emails are off");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const show = async (kind: "day4" | "day6") => {
    try {
      setPreview(await apiGet<ReminderPreview>(`/admin/trial-reminders/preview?kind=${kind}`));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  if (!data) return null;
  return (
    <Panel testId="admin-reminders-panel" className="mt-6">
      <div className="flex flex-wrap items-center gap-3">
        <Mail className="size-5 text-amber-300" />
        <div className="mr-auto">
          <h3 className="text-xl font-bold text-white">Trial reminder emails</h3>
          <p className="text-xs text-slate-500">Day 4: premium features are about to be limited. Day 6: trial ends and when the card is charged. Sent daily at 10am ET.</p>
        </div>
        <span data-testid="admin-reminders-state" className={cn("rounded border px-2 py-0.5 font-mono text-[11px] uppercase", data.enabled ? "border-emerald-500/40 text-emerald-300" : "border-slate-600 text-slate-400")}>
          {data.enabled ? "On — sending" : "Off — nothing is sent"}
        </span>
        <Button size="sm" variant="outline" data-testid="admin-reminder-preview-day4" onClick={() => show("day4")}><Eye className="size-4" /> Day 4 email</Button>
        <Button size="sm" variant="outline" data-testid="admin-reminder-preview-day6" onClick={() => show("day6")}><Eye className="size-4" /> Day 6 email</Button>
        {isMaster && (
          <Button
            size="sm"
            variant={data.enabled ? "outline" : "default"}
            data-testid="admin-reminders-toggle"
            disabled={toggle.isPending}
            onClick={() => (data.enabled || window.confirm("Turn on real reminder emails to every trial yard's manager?")) && toggle.mutate(!data.enabled)}
          >
            {data.enabled ? "Switch off" : "Switch on"}
          </Button>
        )}
      </div>
      <table className="mt-4 w-full text-sm">
        <tbody className="divide-y divide-border">
          {data.upcoming.map((r) => (
            <tr key={r.org_id + r.kind} data-testid={`admin-reminder-row-${r.org_id}-${r.kind}`}>
              <td className="py-2 pr-3 text-white">{r.org_name}</td>
              <td className="pr-3 font-mono text-xs text-slate-400">{r.kind === "day4" ? "Day 4" : "Day 6"}</td>
              <td className="pr-3 font-mono text-xs text-slate-400">{r.to || "no manager email"}</td>
              <td className="pr-3 font-mono text-xs text-slate-400">{new Date(r.due_at).toLocaleString()}</td>
              <td className="text-right font-mono text-xs">{r.sent_at ? <span className="text-emerald-300">sent</span> : <span className="text-slate-500">{data.enabled ? "scheduled" : "would send"}</span>}</td>
            </tr>
          ))}
          {data.upcoming.length === 0 && (
            <tr>
              <td className="py-3 text-sm text-slate-500">No yards on a trial right now.</td>
            </tr>
          )}
        </tbody>
      </table>
      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="sm:max-w-2xl" data-testid="admin-reminder-preview-dialog">
          <DialogHeader>
            <DialogTitle>{preview?.subject}</DialogTitle>
            <DialogDescription>Preview with a sample yard — nothing is sent.</DialogDescription>
          </DialogHeader>
          {preview && <iframe title="Email preview" srcDoc={preview.html} sandbox="" className="h-80 w-full rounded-md bg-white" data-testid="admin-reminder-preview-frame" />}
        </DialogContent>
      </Dialog>
    </Panel>
  );
}

/** Platform console: one-tap demo login on/off, live (no redeploy). Masters flip it; turning off signs out demo sessions. */
export function DemoLoginPanel() {
  const qc = useQueryClient();
  const isMaster = useMe().data?.role === "master";
  const { data } = useQuery({ queryKey: ["admin", "demo-login"], queryFn: () => apiGet<DemoLoginSwitch>("/admin/demo-login") });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => apiPut<DemoLoginSwitch>("/admin/demo-login", { enabled } satisfies RemindersToggle),
    onSuccess: (d) => (toast.success(d.enabled ? "Demo login is on — the sign-in page shows the one-tap demo buttons" : "Demo login is off — demo sessions were signed out"), qc.invalidateQueries({ queryKey: ["admin", "demo-login"] })),
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!data) return null;
  return (
    <Panel testId="admin-demo-login-panel">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <Overline>Sign-in page</Overline>
          <h3 className="mt-1 text-xl font-bold text-white">One-tap demo login</h3>
          <p className="text-sm text-slate-400">
            Lets anyone try the anonymized demo yard without a password. Keep it off once real yards are using the app.
            {data.changed_by && <> Last changed by {data.changed_by}{data.changed_at ? ` · ${new Date(data.changed_at).toLocaleString()}` : ""}.</>}
          </p>
        </div>
        <span data-testid="admin-demo-login-state" className={data.enabled ? "rounded-full bg-amber-500/15 px-3 py-1 font-mono text-xs text-amber-200" : "rounded-full bg-emerald-500/15 px-3 py-1 font-mono text-xs text-emerald-300"}>
          {data.enabled ? "ON" : "OFF"}
        </span>
        {isMaster && (
          <Button size="sm" variant={data.enabled ? "default" : "outline"} data-testid="admin-demo-login-toggle" disabled={toggle.isPending}
            onClick={() => (!data.enabled || window.confirm("Turn off demo login? Anyone signed in to the demo right now is signed out.")) && toggle.mutate(!data.enabled)}>
            {data.enabled ? "Turn off" : "Turn on"}
          </Button>
        )}
      </div>
    </Panel>
  );
}
