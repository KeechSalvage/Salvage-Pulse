import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import DiscountButton, { DiscountRevenuePanel } from "@/components/AdminDiscount";
import { Copy, LogIn, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageHeader, Panel, fmtDate } from "@/components/common";
import { apiGet, apiPatch, apiPost, errorMessage } from "@/lib/api";
import { useMe } from "@/lib/hooks";
import { queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import type { AdminOrg, AdminOrgCreate, AdminOrgCreated, AdminOrgUpdate, AdminUser, AdminUserUpdate, AuditEntry, OrgStatus, PlanId, User, AdminCancel, ExtendTrial, Role } from "@/lib/types";
import { roleLabel } from "@/lib/types";
import { DemoLoginPanel, FreeDayPanel, FunnelPanel, RemindersPanel } from "@/components/AdminGrowth";
import { MessagesPanel } from "@/components/ContactUs";
import { ChangePasswordPanel, StaffDevicesPanel, StaffLockdownPanel } from "@/components/StaffSecurity";
import StaffAccountsPanel from "@/components/StaffAccounts";

const PLANS: PlanId[] = ["starter", "pro", "pro_unlimited", "enterprise", "enterprise_platinum"];
const PLAN_LABEL: Record<PlanId, string> = { starter: "starter", pro: "pro", pro_unlimited: "pro platinum", enterprise: "enterprise", enterprise_platinum: "enterprise platinum" };
const STATUSES: OrgStatus[] = ["incomplete", "trialing", "active", "past_due", "canceled"];
const sel = "h-9 rounded-md border border-border bg-surface px-2 text-sm text-slate-200";

function NewYardDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState<AdminOrgCreate>({ yard_name: "", manager_name: "", email: "", password: "", plan: "pro", status: "trialing", discount: null });
  const [link, setLink] = useState("");
  const create = useMutation({
    mutationFn: () => apiPost<AdminOrgCreated>("/admin/orgs", f),
    onSuccess: (r) => {
      setLink(r.payment_link);
      toast.success(`${r.org.name} created`);
      qc.invalidateQueries({ queryKey: ["admin"] });
    },
    onError: (e) => toast.error(errorMessage(e, "Couldn't create yard")),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && (onClose(), setLink(""))}>
      <DialogContent data-testid="new-yard-dialog">
        <DialogHeader>
          <DialogTitle>Set up a new yard</DialogTitle>
        </DialogHeader>
        {link ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-300">Send this secure payment link to the yard's manager to start their subscription:</p>
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
              <code data-testid="new-yard-payment-link" className="flex-1 truncate font-mono text-xs">{link}</code>
              <button onClick={() => navigator.clipboard.writeText(link).then(() => toast.success("Copied"))}>
                <Copy className="size-4" />
              </button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {(
              [
                ["yard_name", "Yard name"],
                ["manager_name", "Manager name"],
                ["email", "Manager email"],
                ["password", "Temporary password"],
              ] as const
            ).map(([k, l]) => (
              <div key={k}>
                <Label>{l}</Label>
                <Input data-testid={`new-yard-${k}-input`} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} className="mt-1" />
              </div>
            ))}
            <select data-testid="new-yard-plan-select" className={sel} value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value as PlanId })}>
              {PLANS.map((p) => (
                <option key={p} value={p}>{PLAN_LABEL[p]}</option>
              ))}
            </select>
            <select data-testid="new-yard-status-select" className={sel} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as "trialing" | "active" })}>
              <option value="trialing">7-day trial (temporary login, card added later)</option>
              <option value="active">Active now (paid outside the app)</option>
            </select>
            <div className="col-span-2 rounded-lg border border-border p-3">
              <label className="flex items-center gap-2 text-sm text-slate-200">
                <input type="checkbox" data-testid="new-yard-discount-toggle" checked={!!f.discount} onChange={(e) => setF({ ...f, discount: e.target.checked ? { percent: 20, months: 3, reason: "" } : null })} />
                Sign them up at a discount
              </label>
              {f.discount && (
                <div className="mt-2 grid grid-cols-3 gap-2">
                  <Input type="number" min={1} max={100} data-testid="new-yard-discount-percent" aria-label="Percent off" value={f.discount.percent} onChange={(e) => setF({ ...f, discount: { ...f.discount!, percent: Number(e.target.value) } })} />
                  <Input type="number" min={1} max={36} data-testid="new-yard-discount-months" aria-label="Months" value={f.discount.months} onChange={(e) => setF({ ...f, discount: { ...f.discount!, months: Number(e.target.value) } })} />
                  <Input data-testid="new-yard-discount-reason" placeholder="Reason (referral…)" value={f.discount.reason} onChange={(e) => setF({ ...f, discount: { ...f.discount!, reason: e.target.value.slice(0, 60) } })} />
                  <p className="col-span-3 text-[11px] text-slate-500">% off · months · reason — the payment link checks out at the lower price.</p>
                </div>
              )}
            </div>
          </div>
        )}
        <DialogFooter>
          {!link && (
            <Button data-testid="new-yard-submit-button" disabled={create.isPending} onClick={() => create.mutate()}>
              Create yard
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function AdminConsole() {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const [orgId, setOrgId] = useState<string>("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const orgs = useQuery({ queryKey: ["admin", "orgs"], queryFn: () => apiGet<AdminOrg[]>("/admin/orgs") });
  const users = useQuery({
    queryKey: ["admin", "users", orgId, q],
    queryFn: () => apiGet<AdminUser[]>(`/admin/users?${new URLSearchParams({ ...(orgId ? { org_id: orgId } : {}), q })}`),
  });

  type SortKey = "yard-asc" | "yard-desc" | "name-asc" | "name-desc" | "role";
  const [sortKey, setSortKey] = useState<SortKey>("yard-asc");

  const sortedUsers = useMemo(() => {
    const list = [...(users.data ?? [])];
    const roleRank: Record<string, number> = {
      master: 0,
      admin: 1,
      owner: 2,
      sales_manager: 3,
      manager: 3,
      inventory_manager: 4,
      rep: 5,
      sales_rep: 5,
    };
    list.sort((a, b) => {
      if (sortKey === "yard-asc") {
        const c = (a.org_name || "").localeCompare(b.org_name || "");
        return c !== 0 ? c : (a.name || "").localeCompare(b.name || "");
      }
      if (sortKey === "yard-desc") {
        const c = (b.org_name || "").localeCompare(a.org_name || "");
        return c !== 0 ? c : (a.name || "").localeCompare(b.name || "");
      }
      if (sortKey === "name-asc") {
        return (a.name || "").localeCompare(b.name || "");
      }
      if (sortKey === "name-desc") {
        return (b.name || "").localeCompare(a.name || "");
      }
      if (sortKey === "role") {
        const rA = roleRank[a.role] ?? 99;
        const rB = roleRank[b.role] ?? 99;
        return rA !== rB ? rA - rB : (a.name || "").localeCompare(b.name || "");
      }
      return 0;
    });
    return list;
  }, [users.data, sortKey]);
  const audit = useQuery({ queryKey: ["admin", "audit"], queryFn: () => apiGet<AuditEntry[]>("/admin/audit") });
  const inval = () => qc.invalidateQueries({ queryKey: ["admin"] });
  const updOrg = useMutation({
    mutationFn: ({ id, body }: { id: string; body: AdminOrgUpdate }) => apiPatch<AdminOrg>(`/admin/orgs/${id}`, body),
    onSuccess: (o) => (toast.success(`${o.name} updated`), inval()),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const updUser = useMutation({
    mutationFn: ({ id, body }: { id: string; body: AdminUserUpdate }) => apiPatch<AdminUser>(`/admin/users/${id}`, body),
    onSuccess: (u) => (toast.success(`${u.name} updated`), inval()),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const payLink = useMutation({
    mutationFn: (id: string) => apiPost<{ payment_link: string }>(`/admin/orgs/${id}/payment-link`),
    onSuccess: (r) => navigator.clipboard.writeText(r.payment_link).then(() => toast.success("Payment link copied")),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const cancelOrg = useMutation({
    mutationFn: ({ id, body }: { id: string; body: AdminCancel }) => apiPost<AdminOrg>(`/admin/orgs/${id}/cancel`, body),
    onSuccess: (o) => (toast.success(`${o.name} and associated users disabled`), inval()),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const extend = useMutation({
    mutationFn: (id: string) => apiPost<AdminOrg>(`/admin/orgs/${id}/extend`, { days: 3 } satisfies ExtendTrial),
    onSuccess: (o) => (toast.success(`${o.name}: trial now ends ${o.trial_ends_at ? fmtDate(o.trial_ends_at) : ""}`), inval()),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const askCancel = (o: AdminOrg) => {
    const reason = window.prompt(`Cancel ${o.name}'s ${o.status === "trialing" ? "trial" : "subscription"}? Stripe billing stops and the yard is locked out.\n\nReason (kept in the audit log):`, "Trial abuse");
    if (reason !== null) cancelOrg.mutate({ id: o.id, body: { reason, block: true } });
  };
  const loginAs = useMutation({
    mutationFn: (id: string) => apiPost<User>(`/admin/impersonate/${id}`),
    onSuccess: (u) => {
      queryClient.cancelQueries(); // full page load below drops every cached admin query
      window.location.assign(u.role === "manager" ? "/dashboard" : "/me");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  useEffect(() => {
    const handleHash = () => {
      const hash = window.location.hash;
      if (hash) {
        const el = document.querySelector(hash);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
          el.classList.add("ring-2", "ring-amber-500/50");
          setTimeout(() => el.classList.remove("ring-2", "ring-amber-500/50"), 1200);
        }
      }
    };
    const t = setTimeout(handleHash, 150);
    window.addEventListener("hashchange", handleHash);
    return () => {
      clearTimeout(t);
      window.removeEventListener("hashchange", handleHash);
    };
  }, []);

  return (
    <>
      <PageHeader overline={`Salvage Pulse · ${me?.role === "master" ? "Master" : "Administrator"}`} title="Platform console">
        <Button size="lg" data-testid="new-yard-button" onClick={() => setOpen(true)}>
          <Plus className="size-4" /> New yard
        </Button>
      </PageHeader>
      <NewYardDialog open={open} onClose={() => setOpen(false)} />

      <Panel testId="admin-orgs-panel" id="admin-yards" className="scroll-mt-8">
        <h3 className="text-xl font-bold text-white">Yards ({orgs.data?.length ?? 0})</h3>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="font-mono text-[11px] uppercase tracking-wider text-slate-500">
              <tr>
                {["Yard", "Plan", "Status", "Trial ends", "Card", "Discount", "Users", "Calls", "RingCentral", ""].map((h) => (
                  <th key={h} className="py-2 pr-3 text-left font-normal">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {orgs.data?.map((o, i) => {
                const isOrgDisabled = Boolean(o.blocked || o.status === "canceled");
                return (
                  <tr key={o.id} data-testid={`admin-org-row-${i}`} className={cn(orgId === o.id && "bg-sky-500/[0.06]", isOrgDisabled && "opacity-75")}>
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-2">
                        <button data-testid={`admin-org-name-${i}`} className="font-medium text-white hover:underline" onClick={() => setOrgId(orgId === o.id ? "" : o.id)}>
                          {o.name}
                        </button>
                        {isOrgDisabled && (
                          <span className="rounded bg-red-500/20 px-1.5 py-0.5 font-mono text-[10px] text-red-300">
                            Disabled
                          </span>
                        )}
                      </div>
                    </td>
                  <td className="pr-3">
                    <select data-testid={`admin-org-plan-${i}`} className={sel} value={o.plan} onChange={(e) => updOrg.mutate({ id: o.id, body: { plan: e.target.value as PlanId } })}>
                      {PLANS.map((p) => <option key={p} value={p}>{PLAN_LABEL[p]}</option>)}
                    </select>
                    <p data-testid={`admin-org-sites-${i}`} className="mt-1 flex items-center gap-1 font-mono text-[11px] text-slate-500">
                      {o.sites}/{o.max_sites} locations
                      {o.plan === "enterprise_platinum" && (
                        <>
                          <span>· extra</span>
                          <input type="number" min={0} max={50} defaultValue={o.extra_sites} key={`${o.id}-${o.extra_sites}`} data-testid={`admin-org-extra-sites-${i}`} aria-label="Extra locations ($100/mo each)"
                            className="h-6 w-12 rounded border border-border bg-surface px-1 text-slate-200"
                            onBlur={(e) => Number(e.target.value) !== o.extra_sites && updOrg.mutate({ id: o.id, body: { extra_sites: Math.max(0, Math.min(50, Math.floor(Number(e.target.value) || 0))) } })} />
                        </>
                      )}
                    </p>
                  </td>
                  <td className="pr-3">
                    <select data-testid={`admin-org-status-${i}`} className={sel} value={o.status} onChange={(e) => updOrg.mutate({ id: o.id, body: { status: e.target.value as OrgStatus } })}>
                      {STATUSES.map((s) => <option key={s}>{s}</option>)}
                    </select>
                  </td>
                  <td className="pr-3 font-mono text-xs text-slate-400">{o.trial_ends_at ? fmtDate(o.trial_ends_at) : "—"}</td>
                  <td className="pr-3 text-xs" data-testid={`admin-org-card-${i}`}>
                    {o.blocked ? (
                      <span className="text-red-300" title={o.cancel_reason}>closed</span>
                    ) : o.card_on_file ? (
                      <span className="text-emerald-300">on file</span>
                    ) : (
                      <span className="text-slate-500">none</span>
                    )}
                  </td>
                  <td className="pr-3"><DiscountButton org={o} index={i} /></td>
                  <td className="pr-3 font-mono">
                    <button
                      type="button"
                      className="transition-colors hover:text-amber-300 hover:underline cursor-pointer"
                      title={`Filter users by ${o.name}`}
                      onClick={() => setOrgId(orgId === o.id ? "" : o.id)}
                    >
                      {o.users}
                    </button>
                  </td>
                  <td className="pr-3 font-mono">{o.calls}</td>
                  <td className="pr-3 text-xs">{o.ringcentral_connected ? <span className="text-emerald-300">connected</span> : <span className="text-slate-500">—</span>}</td>
                  <td>
                    <div className="flex justify-end gap-1 whitespace-nowrap">
                      <Button size="sm" variant="ghost" data-testid={`admin-org-paylink-${i}`} onClick={() => payLink.mutate(o.id)}>
                        Payment link
                      </Button>
                      {o.status === "trialing" && !o.blocked && (
                        <Button size="sm" variant="ghost" className="text-amber-300 hover:text-amber-200" data-testid={`admin-org-extend-${i}`} disabled={extend.isPending} onClick={() => extend.mutate(o.id)}>
                          +3 days
                        </Button>
                      )}
                      {o.blocked ? (
                        <Button size="sm" variant="ghost" data-testid={`admin-org-reopen-${i}`} onClick={() => updOrg.mutate({ id: o.id, body: { blocked: false, status: "active" } })}>
                          Reopen
                        </Button>
                      ) : (
                        o.status !== "canceled" && o.name !== "Salvage Pulse Pro" && (
                          <Button size="sm" variant="ghost" className="text-red-300 hover:text-red-200" data-testid={`admin-org-cancel-${i}`} disabled={cancelOrg.isPending} onClick={() => askCancel(o)}>
                            {o.status === "trialing" || o.status === "incomplete" ? "Cancel trial" : "Cancel"}
                          </Button>
                        )
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            </tbody>
          </table>
        </div>
      </Panel>

      <div id="admin-discounts" className="scroll-mt-8">
        <DiscountRevenuePanel />
      </div>

      <div id="admin-growth" className="scroll-mt-8 space-y-6">
        <DemoLoginPanel />
        <FreeDayPanel />
        <FunnelPanel />
        <RemindersPanel isMaster={me?.role === "master"} />
      </div>

      <div id="admin-messages" className="scroll-mt-8">
        <MessagesPanel />
      </div>

      <div id="admin-security" className="scroll-mt-8 space-y-6">
        <StaffLockdownPanel isMaster={me?.role === "master"} />
        {me?.role === "master" && <StaffAccountsPanel />}
        <StaffDevicesPanel isMaster={me?.role === "master"} />
        <ChangePasswordPanel />
      </div>

      <Panel testId="admin-users-panel" id="admin-users" className="mt-6 scroll-mt-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h3 className="text-xl font-bold text-white">Users</h3>
            {orgId && (
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-300">
                Yard: {orgs.data?.find((o) => o.id === orgId)?.name ?? "Selected Yard"}
              </span>
            )}
          </div>
          <Input data-testid="admin-user-search" placeholder="Search name or email" value={q} onChange={(e) => setQ(e.target.value)} className="h-9 w-64 bg-surface" />
        </div>

        {/* Dropdown controls under the Users box header */}
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-border/70 bg-surface/50 p-3">
          <div className="flex items-center gap-2">
            <Label htmlFor="admin-user-yard-filter" className="font-mono text-xs text-slate-400">Yard:</Label>
            <select
              id="admin-user-yard-filter"
              data-testid="admin-user-yard-filter"
              className={sel}
              value={orgId}
              onChange={(e) => setOrgId(e.target.value)}
            >
              <option value="">All yards ({orgs.data?.length ?? 0})</option>
              {orgs.data?.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <Label htmlFor="admin-user-sort" className="font-mono text-xs text-slate-400">Sort by:</Label>
            <select
              id="admin-user-sort"
              data-testid="admin-user-sort"
              className={sel}
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
            >
              <option value="yard-asc">Yard name (A → Z)</option>
              <option value="yard-desc">Yard name (Z → A)</option>
              <option value="name-asc">User name (A → Z)</option>
              <option value="name-desc">User name (Z → A)</option>
              <option value="role">Role (Master → Owner → Sales Mgr → Inv Mgr → Rep)</option>
            </select>
          </div>

          {orgId && (
            <Button
              size="sm"
              variant="ghost"
              className="h-8 text-xs text-amber-300 hover:text-amber-200"
              onClick={() => setOrgId("")}
            >
              Clear yard filter
            </Button>
          )}

          <span className="ml-auto font-mono text-xs text-slate-400">
            {sortedUsers.length} user{sortedUsers.length === 1 ? "" : "s"} shown
          </span>
        </div>

        <div className="mt-4 max-h-[520px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left font-mono text-[11px] uppercase tracking-wider text-slate-400">
                <th className="pb-2 pr-3">User</th>
                <th
                  className="pb-2 pr-3 cursor-pointer select-none transition-colors hover:text-amber-300"
                  title="Click to toggle Yard sort order"
                  onClick={() => setSortKey(sortKey === "yard-asc" ? "yard-desc" : "yard-asc")}
                >
                  Yard {sortKey === "yard-asc" ? "▲" : sortKey === "yard-desc" ? "▼" : ""}
                </th>
                <th className="pb-2 pr-3">Role</th>
                <th className="pb-2 pr-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sortedUsers.map((u, i) => {
                const staff = u.role === "master" || u.role === "admin";
                return (
                  <tr key={u.id} data-testid={`admin-user-row-${i}`} className={cn(u.disabled && "opacity-50")}>
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-white">{u.name}</p>
                        {u.disabled && (
                          <span className="rounded bg-red-500/20 px-1.5 py-0.5 font-mono text-[10px] text-red-300">
                            Disabled
                          </span>
                        )}
                      </div>
                      <p className="font-mono text-[11px] text-slate-500">{u.email}</p>
                    </td>
                    <td className="pr-3 text-slate-300">
                      <button
                        type="button"
                        className="transition-colors hover:text-amber-300 hover:underline cursor-pointer text-left"
                        title={`Filter by ${u.org_name}`}
                        onClick={() => setOrgId(u.org_id)}
                      >
                        {u.org_name}
                      </button>
                    </td>
                    <td className="pr-3">
                      {staff ? (
                        <span className="font-mono text-xs uppercase text-sky-300">{u.role}</span>
                      ) : (
                        <select data-testid={`admin-user-role-${i}`} className={sel} value={u.role} onChange={(e) => updUser.mutate({ id: u.id, body: { role: e.target.value as Role } })}>
                          <option value="owner">Owner</option>
                          <option value="sales_manager">Sales Manager</option>
                          <option value="inventory_manager">Inventory Manager</option>
                          <option value="rep">Sales Representative</option>
                        </select>
                      )}
                    </td>
                    <td className="space-x-1 whitespace-nowrap text-right">
                      {!staff && (
                        <>
                          <Button size="sm" variant="ghost" data-testid={`admin-user-reset-${i}`}
                            onClick={() => {
                              const pw = window.prompt(`New password for ${u.name} (8+ characters)`);
                              if (pw) updUser.mutate({ id: u.id, body: { password: pw } });
                            }}
                          >
                            Reset password
                          </Button>
                          <Button size="sm" variant="ghost" data-testid={`admin-user-disable-${i}`} onClick={() => updUser.mutate({ id: u.id, body: { disabled: !u.disabled } })}>
                            {u.disabled ? "Enable" : "Disable"}
                          </Button>
                          {me?.role === "master" && (
                            <Button size="sm" variant="outline" data-testid={`admin-user-login-as-${i}`} onClick={() => loginAs.mutate(u.id)}>
                              <LogIn className="size-3.5" /> Log in as
                            </Button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel testId="admin-audit-panel" id="admin-activity" className="mt-6 scroll-mt-8">
        <h3 className="text-xl font-bold text-white">Activity log</h3>
        <div className="mt-3 max-h-64 divide-y divide-border overflow-y-auto text-sm">
          {audit.data?.length === 0 && <p className="py-3 text-slate-500">No admin activity yet.</p>}
          {audit.data?.map((a, i) => (
            <p key={i} className="py-2 text-slate-300">
              <span className="font-mono text-xs text-slate-500">{fmtDate(a.at)}</span> · {a.actor} · {a.action} <span className="text-slate-400">{a.target}</span>
            </p>
          ))}
        </div>
      </Panel>
    </>
  );
}
