import { useState } from "react";
import TileGrid from "@/components/TileGrid";
import ListProgress from "@/components/ListProgress";
import DeliveryTipLibrary from "@/components/DeliveryTipLibrary";
import ChampionBadges from "@/components/ChampionBadges";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlarmClock, ArrowRight, DollarSign, Loader2, Mail, Store, Trophy, Truck, UserPlus } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageHeader, ScoreBadge } from "@/components/common";
import { Avatar } from "@/components/AppShell";
import RepTrendsPanel from "@/components/RepTrends";
import { useAssignments } from "@/components/AssignmentNudge";
import PremiumGate from "@/components/PremiumGate";
import TrophyWallPanel from "@/components/TrophyWall";
import TruckTrophy, { useTruckWinner } from "@/components/TruckTrophy";
import TagTrophy, { useTagChampion } from "@/components/TagTrophy";
import LoginUsageAlert from "@/components/LoginUsageAlert";
import RoleplayScoreboardPanel from "@/components/RoleplayScoreboard";
import { apiGet, apiPost, apiPut, errorMessage } from "@/lib/api";
import { useAllReps } from "@/lib/hooks";
import { RepSiteSelect, SiteFilter, SitesPanel, useSites } from "@/components/Sites";
import RepLoginToggle, { RepLoginLog, useLoginLog, whenShort } from "@/components/RepLoginToggle";
import { cn } from "@/lib/utils";
import type { BusinessSettings, DigestResult, DigestSettings, Overview, RepCreate, Role, User } from "@/lib/types";
import { roleLabel } from "@/lib/types";

function OrderValuePanel() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["business-settings"], queryFn: () => apiGet<BusinessSettings>("/settings/business") });
  const [val, setVal] = useState<string | null>(null);
  const cur = val ?? (data?.avg_order_value != null ? String(data.avg_order_value) : "");
  const save = useMutation({
    mutationFn: (v: number | null) => apiPut<BusinessSettings>("/settings/business", { avg_order_value: v } satisfies BusinessSettings),
    onSuccess: (r) => {
      toast.success(r.avg_order_value ? `Average order value set to $${r.avg_order_value}` : "Reset to default ($350)");
      setVal(null);
      qc.invalidateQueries({ queryKey: ["business-settings"] });
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["customer"] });
    },
    onError: (e) => toast.error(errorMessage(e, "Enter a positive dollar amount")),
  });
  const num = Number(cur);
  return (
    <div data-testid="order-value-panel" className="rounded-xl border border-border bg-card p-6">
      <div className="flex items-center gap-2">
        <DollarSign className="size-4 text-amber-400" />
        <h3 className="text-xl font-bold text-white">Average order value</h3>
      </div>
      <p className="mt-1 max-w-2xl text-sm text-slate-400">
        Used to estimate account value for orders without a scored transcript. Once 3+ sales have been AI-scored, the real average from those calls takes over.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">$</span>
          <Input
            data-testid="order-value-input"
            type="number"
            min={1}
            value={cur}
            onChange={(e) => setVal(e.target.value)}
            placeholder="350"
            className="h-10 w-40 bg-surface pl-7"
          />
        </div>
        <Button data-testid="order-value-save" variant="outline" disabled={save.isPending || !(num > 0)} onClick={() => save.mutate(num)}>
          Save
        </Button>
        {data?.avg_order_value != null && (
          <Button data-testid="order-value-reset" variant="ghost" disabled={save.isPending} onClick={() => save.mutate(null)}>
            Reset to default
          </Button>
        )}
      </div>
    </div>
  );
}

function YardNamePanel() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["business-settings"], queryFn: () => apiGet<BusinessSettings>("/settings/business") });
  const [val, setVal] = useState<string | null>(null);
  const cur = val ?? data?.yard_name ?? "";
  const save = useMutation({
    mutationFn: (v: string | null) => apiPut<BusinessSettings>("/settings/business", { yard_name: v } satisfies BusinessSettings),
    onSuccess: (r) => {
      toast.success(r.yard_name ? `Yard name set to ${r.yard_name}` : "Yard name cleared");
      setVal(null);
      qc.invalidateQueries({ queryKey: ["business-settings"] });
      qc.invalidateQueries({ queryKey: ["customers"] });
    },
    onError: (e) => toast.error(errorMessage(e, "Couldn't save the yard name")),
  });
  return (
    <div data-testid="yard-name-panel" className="rounded-xl border border-border bg-card p-6">
      <div className="flex items-center gap-2">
        <Store className="size-4 text-amber-400" />
        <h3 className="text-xl font-bold text-white">Yard name</h3>
      </div>
      <p className="mt-1 max-w-2xl text-sm text-slate-400">
        Used in suggested win-back opening lines, e.g. &ldquo;Hi John, it's Rich from {cur.trim() || "Salvage Pulse Pro"}.&rdquo;
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Input
          data-testid="yard-name-input"
          value={cur}
          maxLength={80}
          onChange={(e) => setVal(e.target.value)}
          placeholder="Salvage Pulse Pro"
          className="h-10 w-72 bg-surface"
        />
        <Button data-testid="yard-name-save" variant="outline" disabled={save.isPending || !cur.trim() || cur.trim() === data?.yard_name} onClick={() => save.mutate(cur.trim())}>
          Save
        </Button>
        {data?.yard_name && (
          <Button data-testid="yard-name-clear" variant="ghost" disabled={save.isPending} onClick={() => save.mutate(null)}>
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}

function DigestPanel() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["digest-settings"], queryFn: () => apiGet<DigestSettings>("/settings/digest") });
  const [email, setEmail] = useState<string | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const curEmail = email ?? data?.recipient_email ?? "";
  const curEnabled = enabled ?? data?.enabled ?? false;
  const save = useMutation({
    mutationFn: () => apiPut<DigestSettings>("/settings/digest", { recipient_email: curEmail, enabled: curEnabled } satisfies DigestSettings),
    onSuccess: () => {
      toast.success("Email settings saved");
      qc.invalidateQueries({ queryKey: ["digest-settings"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const send = useMutation({
    mutationFn: () => apiPost<DigestResult>("/digest/send-now"),
    onSuccess: (r) => toast.success(`Sent ${r.items} follow-ups across ${r.reps} reps to ${r.recipient}`),
    onError: (e) => toast.error(errorMessage(e, "Send failed")),
  });
  return (
    <div data-testid="digest-panel" className="rounded-xl border border-border bg-card p-6">
      <div className="flex items-center gap-2">
        <Mail className="size-4 text-amber-400" />
        <h3 className="text-xl font-bold text-white">Daily quote follow-up email</h3>
      </div>
      <p className="mt-1 max-w-2xl text-sm text-slate-400">
        Every Mon–Sat at 7:30am ET, one email lists each rep's open quotes (no order yet) and unreturned missed calls. Test mode: it goes only to the
        address below, never to reps.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Input
          data-testid="digest-email-input"
          type="email"
          value={curEmail}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="test recipient, e.g. you@yourcompany.com"
          className="h-10 w-80 bg-surface"
        />
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <Checkbox data-testid="digest-enabled-checkbox" checked={curEnabled} onCheckedChange={(v) => setEnabled(!!v)} />
          Send daily
        </label>
        <Button data-testid="digest-save-button" variant="outline" disabled={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
        <Button data-testid="digest-send-now-button" disabled={send.isPending || !data?.recipient_email} onClick={() => send.mutate()}>
          {send.isPending && <Loader2 className="size-4 animate-spin" />} Send test now
        </Button>
      </div>
    </div>
  );
}

const EMPTY: RepCreate = { name: "", email: "", password: "", title: "", role: "rep" };

export default function Team() {
  const qc = useQueryClient();
  const reps = useAllReps();
  const truckWinner = useTruckWinner();
  const ov = useQuery({ queryKey: ["overview", "team"], queryFn: () => apiGet<Overview>("/analytics/overview") });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<RepCreate>(EMPTY);

  const create = useMutation({
    mutationFn: () => apiPost<User>("/users/reps", form),
    onSuccess: (u) => {
      toast.success(`${u.name} added — they can sign in now`);
      qc.invalidateQueries({ queryKey: ["reps"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
      setForm(EMPTY);
      setOpen(false);
    },
    onError: (e) => toast.error(errorMessage(e, "Could not add rep")),
  });

  const loginLog = useLoginLog();
  const sites = useSites();
  const [siteId, setSiteId] = useState("");
  const [repSort, setRepSort] = useState<"name" | "site" | "calls" | "score">("name");
  const shown = (reps.data ?? []).filter((r) => !siteId || r.site_id === siteId);
  const lastChange = (id: string) => (loginLog.data ?? []).find((e) => e.rep_id === id);
  const tagChampion = useTagChampion();
  const stat = (id: string) => (ov.data?.leaderboard ?? []).find((l) => l.rep_id === id);
  const assignments = useAssignments();
  const overdueFor = (id: string) => (assignments.data ?? []).filter((a) => a.rep_id === id && a.status === "overdue");

  const sortedReps = [...shown].sort((a, b) => {
    if (repSort === "site") {
      const siteA = (sites.data?.sites ?? []).find((s) => s.id === a.site_id)?.name ?? "Main Yard";
      const siteB = (sites.data?.sites ?? []).find((s) => s.id === b.site_id)?.name ?? "Main Yard";
      const c = siteA.localeCompare(siteB);
      return c !== 0 ? c : a.name.localeCompare(b.name);
    }
    if (repSort === "calls") {
      return (stat(b.id)?.calls ?? 0) - (stat(a.id)?.calls ?? 0);
    }
    if (repSort === "score") {
      return (stat(b.id)?.avg_score ?? 0) - (stat(a.id)?.avg_score ?? 0);
    }
    return a.name.localeCompare(b.name);
  });

  const truckChamps = new Set((truckWinner.data?.winners ?? []).map((w) => w.rep_id));
  const tagChamps = new Set((tagChampion.data?.winners ?? []).map((w) => w.user_id));
  return (
    <>
      <PageHeader overline="Team" title="Sales reps">
        <Button size="lg" data-testid="add-rep-button" onClick={() => setOpen(true)}>
          <UserPlus className="size-4" /> Add rep
        </Button>
      </PageHeader>
      <LoginUsageAlert className="mb-6" />

      <TileGrid
        page="team"
        label="sections"
        className="grid grid-cols-1 gap-8"
        tiles={[
          { id: "callback-lists", label: "Callback lists", node: <ListProgress /> },
          { id: "delivery-tips", label: "Delivery tip texts", node: <DeliveryTipLibrary /> },
          { id: "sites", label: "Locations", node: <SitesPanel /> },
          { id: "reps", label: "Rep cards", node: (
            <div>
              <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-border/70 bg-surface/50 p-3">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-slate-400">Yard / Location:</span>
                  <SiteFilter value={siteId} onChange={setSiteId} testId="team-site-filter" />
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-slate-400">Sort by:</span>
                  <select
                    data-testid="team-rep-sort"
                    className="h-9 rounded-md border border-border bg-surface px-2 text-sm text-slate-200"
                    value={repSort}
                    onChange={(e) => setRepSort(e.target.value as any)}
                  >
                    <option value="name">Name (A → Z)</option>
                    <option value="site">Yard / Location</option>
                    <option value="calls">Most Calls</option>
                    <option value="score">Highest Score</option>
                  </select>
                </div>
                <span className="ml-auto font-mono text-xs text-slate-400">
                  {sortedReps.length} rep{sortedReps.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {sortedReps.map((r) => {
                const s = stat(r.id);
                return (
                  <Link
                    key={r.id}
                    to={`/reps/${r.id}`}
                    data-testid={`rep-card-${r.id}`}
                    className={cn("group rounded-xl border border-border bg-card p-5 transition-[border-color,transform,opacity] duration-150 hover:-translate-y-0.5 hover:border-amber-500/40", r.disabled && "opacity-60")}
                  >
                    <div className="flex items-center gap-4">
                      <Avatar name={r.name} url={r.avatar_url} size={48} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate font-heading text-lg font-bold text-white">{r.name}</p>
                          {r.role && r.role !== "rep" && (
                            <span className={cn(
                              "rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase",
                              r.role === "owner" && "bg-amber-500/20 text-amber-300 border border-amber-500/30",
                              r.role === "sales_manager" && "bg-sky-500/20 text-sky-300 border border-sky-500/30",
                              r.role === "inventory_manager" && "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                            )}>
                              {roleLabel(r.role)}
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-slate-400">{r.title || roleLabel(r.role)}</p>
                        <p className="font-mono text-[11px] text-slate-500">{r.email}</p>
                      </div>
                      {s && s.calls > 0 && <ScoreBadge score={Math.round(s.avg_score)} />}
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      {r.disabled && <span data-testid={`rep-login-off-${r.id}`} className="rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 font-mono text-[11px] text-red-300">Login off</span>}
                      {r.disabled && lastChange(r.id)?.action === "off" && <span data-testid={`rep-login-off-since-${r.id}`} className="truncate text-[11px] text-slate-500">since {whenShort(lastChange(r.id)!.at)} · {lastChange(r.id)!.by}</span>}
                      <RepSiteSelect rep={r} />
                      <span className="ml-auto"><RepLoginToggle rep={r} reps={reps.data ?? []} /></span>
                    </div>
                    <ChampionBadges repId={r.id} className="mt-3" testId={`rep-champions-${r.id}`} />
                    {truckChamps.has(r.id) && (
                      <p
                        data-testid={`rep-truck-champ-${r.id}`}
                        className="mt-3 mr-2 inline-flex items-center gap-1.5 rounded-full border border-amber-500/50 bg-amber-500/15 px-2.5 py-0.5 font-mono text-[11px] text-amber-200"
                      >
                        <Truck className="size-3" /> Vehicle-sales champ · last month
                      </p>
                    )}
                    {tagChamps.has(r.id) && (
                      <p
                        data-testid={`rep-tag-champ-${r.id}`}
                        className="mt-3 mr-2 inline-flex items-center gap-1.5 rounded-full border border-sky-400/50 bg-sky-500/15 px-2.5 py-0.5 font-mono text-[11px] text-sky-200"
                      >
                        <Trophy className="size-3" /> Top tagger · last week
                      </p>
                    )}
                    {overdueFor(r.id).length > 0 && (
                      <p
                        data-testid={`rep-overdue-${r.id}`}
                        title={overdueFor(r.id).map((a) => a.scenario_title).join(", ")}
                        className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-red-500/40 bg-red-500/10 px-2.5 py-0.5 font-mono text-[11px] text-red-300"
                      >
                        <AlarmClock className="size-3" /> {overdueFor(r.id).length} overdue role-play{overdueFor(r.id).length === 1 ? "" : "s"}
                      </p>
                    )}
                    <div className="mt-5 flex items-center justify-between border-t border-border pt-4 font-mono text-xs text-slate-400">
                      <span>{s?.calls ?? 0} calls</span>
                      <span>{s?.conversion_rate ?? 0}% close</span>
                      <span className="flex items-center gap-1 text-amber-400">
                        Profile <ArrowRight className="size-3 transition-transform duration-150 group-hover:translate-x-0.5" />
                      </span>
                    </div>
                  </Link>
                );
              })}
            </div>
            </div>
          ) },
          { id: "login-log", label: "Login changes", node: <RepLoginLog /> },
          { id: "rep-trends", label: "Rep comparison", node: <PremiumGate feature="rep_trends"><RepTrendsPanel testId="team-rep-trends-panel" className="" /></PremiumGate> },
          { id: "tag-trophy", label: "Weekly tagging champion", node: <TagTrophy /> },
          { id: "truck-trophy", label: "Vehicle-sales trophy", node: <PremiumGate feature="leaderboards" hidden><TruckTrophy /></PremiumGate> },
          { id: "trophy-wall", label: "Trophy wall", node: <PremiumGate feature="leaderboards"><TrophyWallPanel /></PremiumGate> },
          { id: "roleplay-scoreboard", label: "Role-play scoreboard", node: <PremiumGate feature="roleplay"><RoleplayScoreboardPanel /></PremiumGate> },
          { id: "yard-name", label: "Yard name", node: <YardNamePanel /> },
          { id: "order-value", label: "Average order value", node: <OrderValuePanel /> },
          { id: "daily-email", label: "Daily email", node: <PremiumGate feature="daily_email"><DigestPanel /></PremiumGate> },
        ]}
      />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid="add-rep-dialog">
          <DialogHeader>
            <DialogTitle>Add team member</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="rep-role">Role</Label>
              <select
                id="rep-role"
                data-testid="add-rep-role-select"
                className="h-10 w-full rounded-md border border-border bg-surface px-3 text-sm text-slate-200"
                value={form.role || "rep"}
                onChange={(e) => setForm({ ...form, role: e.target.value as Role })}
              >
                <option value="owner">Owner</option>
                <option value="sales_manager">Sales Manager</option>
                <option value="inventory_manager">Inventory Manager</option>
                <option value="rep">Sales Representative</option>
              </select>
            </div>
            {(
              [
                ["name", "Full name", "text"],
                ["title", "Desk / title", "text"],
                ["email", "Login email", "email"],
                ["password", "Temporary password (6+ chars)", "password"],
              ] as const
            ).map(([k, l, t]) => (
              <div key={k} className="space-y-1.5">
                <Label htmlFor={`rep-${k}`}>{l}</Label>
                <Input
                  id={`rep-${k}`}
                  data-testid={`add-rep-${k}-input`}
                  type={t}
                  value={form[k]}
                  onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                  required={k !== "title"}
                />
              </div>
            ))}
            <DialogFooter>
              <Button type="submit" data-testid="add-rep-submit-button" disabled={create.isPending}>
                {create.isPending && <Loader2 className="size-4 animate-spin" />} Create user login
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
