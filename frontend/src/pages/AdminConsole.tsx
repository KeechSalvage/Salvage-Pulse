import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import DiscountButton, { DiscountRevenuePanel } from "@/components/AdminDiscount";
import { Building2, Copy, Eye, KeyRound, LogIn, Mail, Phone, Plus, Trash2, UserRound, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageHeader, Panel, fmtDate } from "@/components/common";
import { apiDelete, apiGet, apiPatch, apiPost, errorMessage } from "@/lib/api";
import { useMe } from "@/lib/hooks";
import { queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import type { AdminOrg, AdminOrgCreate, AdminOrgCreated, AdminOrgUpdate, AdminUser, AdminUserCreate, AdminUserUpdate, AuditEntry, OrgStatus, PlanId, User, AdminCancel, ExtendTrial, Role } from "@/lib/types";
import { roleLabel } from "@/lib/types";
import { DemoLoginPanel, FreeDayPanel, FunnelPanel, RemindersPanel } from "@/components/AdminGrowth";
import { MessagesPanel } from "@/components/ContactUs";
import { ChangePasswordPanel, StaffDevicesPanel, StaffLockdownPanel } from "@/components/StaffSecurity";
import StaffAccountsPanel from "@/components/StaffAccounts";
import { homeFor } from "@/components/AppShell";
import { APP_VERSION, APP_STAGE, IS_BETA } from "@/lib/version";

const PLANS: PlanId[] = ["starter", "pro", "pro_unlimited", "enterprise", "enterprise_platinum"];
const PLAN_LABEL: Record<PlanId, string> = { starter: "starter", pro: "pro", pro_unlimited: "pro platinum", enterprise: "enterprise", enterprise_platinum: "enterprise platinum" };
const STATUSES: OrgStatus[] = ["incomplete", "trialing", "active", "past_due", "canceled", "demo"];
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

function SetPasswordDialog({ user, onClose }: { user: AdminUser | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [newPassword, setNewPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const setPw = useMutation({
    mutationFn: (body: { password: string }) => apiPost(`/admin/users/${user?.id}/password`, body),
    onSuccess: (data: any) => {
      toast.success(data?.message || `Password for ${user?.name} updated successfully`);
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
      onClose();
      setNewPassword("");
    },
    onError: (e) => toast.error(errorMessage(e, "Failed to update password")),
  });

  if (!user) return null;

  return (
    <Dialog open={Boolean(user)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg font-bold text-white">Set Password for {user.name}</DialogTitle>
          <p className="text-xs text-slate-400">
            {user.email} · <span className="font-mono uppercase text-sky-400">{roleLabel(user.role)}</span>
          </p>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (newPassword.length < 6) {
              toast.error("Password must be at least 6 characters");
              return;
            }
            setPw.mutate({ password: newPassword });
          }}
          className="space-y-4 py-2"
        >
          <div>
            <Label htmlFor="admin-new-pw" className="text-xs text-slate-300">
              New Password
            </Label>
            <div className="relative mt-1">
              <Input
                id="admin-new-pw"
                type={showPassword ? "text" : "password"}
                placeholder="Enter new password (min. 6 characters)"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="bg-surface pr-16"
                autoFocus
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-white"
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
            <p className="mt-1 text-[11px] text-slate-500">
              This user will immediately be able to sign in with this password.
            </p>
          </div>

          <DialogFooter className="gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={onClose} disabled={setPw.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={newPassword.length < 6 || setPw.isPending}>
              {setPw.isPending ? "Saving..." : "Save Password"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NewUserDialog({ open, onClose, defaultOrgId, orgs }: { open: boolean; onClose: () => void; defaultOrgId: string; orgs: AdminOrg[] }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<AdminUserCreate>({
    org_id: defaultOrgId || (orgs[0]?.id ?? ""),
    name: "",
    email: "",
    role: "rep",
    title: "",
    password: "",
  });

  useEffect(() => {
    if (defaultOrgId) {
      setForm((prev) => ({ ...prev, org_id: defaultOrgId }));
    } else if (orgs.length > 0 && !form.org_id) {
      setForm((prev) => ({ ...prev, org_id: orgs[0].id }));
    }
  }, [defaultOrgId, orgs]);

  const create = useMutation({
    mutationFn: () => apiPost<AdminUser & { temp_password?: string; emailed?: boolean }>("/admin/users", form),
    onSuccess: (r) => {
      toast.success(r.emailed ? `User ${r.name} added — welcome email sent!` : `User ${r.name} added to yard!`);
      qc.invalidateQueries({ queryKey: ["admin"] });
      onClose();
      setForm({
        org_id: defaultOrgId || (orgs[0]?.id ?? ""),
        name: "",
        email: "",
        role: "rep",
        title: "",
        password: "",
      });
    },
    onError: (e) => toast.error(errorMessage(e, "Failed to create user")),
  });

  const selectedOrg = orgs.find((o) => o.id === form.org_id);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md" data-testid="new-user-dialog">
        <DialogHeader>
          <DialogTitle className="text-lg font-bold text-white">Add User on Behalf of Yard</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4 pt-2"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="new-user-org">Target Yard</Label>
            <select
              id="new-user-org"
              data-testid="new-user-org-select"
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-sm text-slate-200"
              value={form.org_id}
              onChange={(e) => setForm({ ...form, org_id: e.target.value })}
              required
            >
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} ({o.plan})
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-user-role">Role</Label>
            <select
              id="new-user-role"
              data-testid="new-user-role-select"
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-sm text-slate-200"
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value as Role })}
            >
              <option value="owner">Owner</option>
              <option value="sales_manager">Sales Manager</option>
              <option value="inventory_manager">Inventory Manager</option>
              <option value="rep">Sales Representative</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-user-name">Full Name</Label>
            <Input
              id="new-user-name"
              data-testid="new-user-name-input"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Alex Morgan"
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-user-email">Login Email</Label>
            <Input
              id="new-user-email"
              data-testid="new-user-email-input"
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              placeholder="alex@yard.com"
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-user-title">Title / Desk (Optional)</Label>
            <Input
              id="new-user-title"
              data-testid="new-user-title-input"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="e.g. Counter Sales Lead"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-user-password">Initial Password (Optional)</Label>
            <Input
              id="new-user-password"
              data-testid="new-user-password-input"
              type="text"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              placeholder="Leave blank to auto-generate temporary password"
            />
            <p className="text-xs text-slate-400">
              An invitation email will be sent automatically with login instructions.
            </p>
          </div>

          <DialogFooter className="gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={onClose} disabled={create.isPending}>
              Cancel
            </Button>
            <Button
              type="submit"
              data-testid="new-user-submit-button"
              disabled={create.isPending || !form.name.trim() || !form.email.trim() || !form.org_id}
            >
              {create.isPending ? "Adding..." : "Add user to yard"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function YardDetailDialog({
  org,
  onClose,
  onFilterUsers,
}: {
  org: AdminOrg | null;
  onClose: () => void;
  onFilterUsers?: (orgId: string) => void;
}) {
  if (!org) return null;
  const users = org.user_list ?? [];
  const activeCount = users.filter((u) => !u.disabled).length;

  return (
    <Dialog open={Boolean(org)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="yard-detail-dialog" className="max-w-xl">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Building2 className="size-5 text-amber-400" />
            <DialogTitle className="text-xl text-white">{org.name}</DialogTitle>
          </div>
          <p className="text-xs text-slate-400">Yard details, billing contacts, and staff directory.</p>
        </DialogHeader>

        <div className="space-y-5 pt-2">
          {/* Contact & Billing Information */}
          <div className="rounded-xl border border-border/70 bg-surface/50 p-4 space-y-3">
            <div className="text-[11px] font-mono uppercase tracking-wider text-slate-400 font-semibold">
              Contact &amp; Billing
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <div className="space-y-1">
                <span className="text-xs text-slate-400 flex items-center gap-1.5">
                  <Phone className="size-3.5 text-slate-500" /> Main Phone
                </span>
                <p className="font-mono text-white font-medium">{org.phone || "—"}</p>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-slate-400 flex items-center gap-1.5">
                  <UserRound className="size-3.5 text-slate-500" /> Billing Contact
                </span>
                <p className="text-white font-medium">{org.billing_contact_name || "—"}</p>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-slate-400 flex items-center gap-1.5">
                  <Mail className="size-3.5 text-slate-500" /> Billing Email
                </span>
                <p className="text-slate-300 font-mono text-xs">{org.billing_email || "—"}</p>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-slate-400 flex items-center gap-1.5">
                  <Phone className="size-3.5 text-slate-500" /> Billing Phone
                </span>
                <p className="font-mono text-white text-xs">{org.billing_phone || org.phone || "—"}</p>
              </div>
            </div>
          </div>

          {/* Quick List of Users and Titles */}
          <div className="rounded-xl border border-border/70 bg-surface/50 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-[11px] font-mono uppercase tracking-wider text-slate-400 font-semibold flex items-center gap-1.5">
                <Users className="size-3.5 text-slate-400" /> Assigned Users ({activeCount} active{users.length > activeCount ? `, ${users.length - activeCount} disabled` : ""})
              </div>
              <span className="font-mono text-[11px] text-slate-500">{org.calls} calls tracked</span>
            </div>

            <div className="max-h-60 overflow-y-auto divide-y divide-border/50 border border-border/40 rounded-lg">
              {users.length === 0 ? (
                <div className="p-4 text-center text-xs text-slate-500">
                  No users currently assigned to this yard.
                </div>
              ) : (
                users.map((u) => (
                  <div key={u.id} className="flex items-center justify-between px-3 py-2 text-xs hover:bg-slate-800/30">
                    <div className="min-w-0 pr-3">
                      <div className="flex items-center gap-1.5">
                        <span className={cn("font-medium text-white truncate", u.disabled && "text-slate-500 line-through")}>
                          {u.name}
                        </span>
                        {u.disabled && (
                          <span className="rounded bg-red-500/20 px-1 py-0.2 font-mono text-[9px] text-red-300">
                            Disabled
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-slate-400 truncate">{u.email}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <span className="inline-block rounded-md bg-slate-800/90 border border-border px-2 py-0.5 font-mono text-[10px] text-amber-300">
                        {u.title || roleLabel(u.role)}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <DialogFooter className="mt-2 flex items-center justify-between sm:justify-between">
          {onFilterUsers ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-xs border-slate-700 hover:bg-slate-800"
              onClick={() => {
                onFilterUsers(org.id);
                onClose();
              }}
            >
              Filter users table below
            </Button>
          ) : <div />}
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function AdminConsole() {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const [orgId, setOrgId] = useState<string>("");
  const [selectedYard, setSelectedYard] = useState<AdminOrg | null>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [passwordUser, setPasswordUser] = useState<AdminUser | null>(null);
  const [userDialogOpen, setUserDialogOpen] = useState(false);
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
  const delUser = useMutation({
    mutationFn: (id: string) => apiDelete<{ ok: boolean; message: string }>(`/admin/users/${id}`),
    onSuccess: (r) => (toast.success(r.message), inval()),
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
      window.location.assign(homeFor(u.role));
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
        <div className="flex items-center gap-3">
          <div className="hidden sm:flex items-center gap-1.5 rounded-lg border border-border bg-card/60 px-3 py-1.5 text-xs text-slate-400">
            <span>System Release:</span>
            {IS_BETA && (
              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase text-amber-300 ring-1 ring-amber-500/30">
                {APP_STAGE}
              </span>
            )}
            <span className="font-mono text-slate-200 font-semibold">v{APP_VERSION}</span>
          </div>
          <Button size="lg" data-testid="new-yard-button" onClick={() => setOpen(true)}>
            <Plus className="size-4" /> New yard
          </Button>
        </div>
      </PageHeader>
      <NewYardDialog open={open} onClose={() => setOpen(false)} />
      <YardDetailDialog org={selectedYard} onClose={() => setSelectedYard(null)} />
      <SetPasswordDialog user={passwordUser} onClose={() => setPasswordUser(null)} />
      <NewUserDialog open={userDialogOpen} onClose={() => setUserDialogOpen(false)} defaultOrgId={orgId} orgs={orgs.data ?? []} />

      <Panel testId="admin-orgs-panel" id="admin-yards" className="scroll-mt-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-xl font-bold text-white">Yards ({orgs.data?.length ?? 0})</h3>
          <p className="text-xs text-slate-400">Manage subscriptions, sites, discounts, and demo status across all client yards.</p>
        </div>
        <div className="mt-4 overflow-x-auto rounded-lg border border-border/70">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-surface/60 font-mono text-[11px] uppercase tracking-wider text-slate-400">
              <tr>
                <th className="py-2.5 px-4 font-semibold text-slate-300">Yard</th>
                <th className="py-2.5 px-3 font-semibold text-slate-300">Plan</th>
                <th className="py-2.5 px-3 font-semibold text-slate-300">Status</th>
                <th className="py-2.5 px-3 font-semibold text-slate-300">Trial ends</th>
                <th className="py-2.5 px-3 font-semibold text-slate-300">Card</th>
                <th className="py-2.5 px-3 font-semibold text-slate-300">Discount</th>
                <th className="py-2.5 px-3 font-semibold text-slate-300">Users</th>
                <th className="py-2.5 px-3 font-semibold text-slate-300">Calls</th>
                <th className="py-2.5 px-3 font-semibold text-slate-300">RingCentral</th>
                <th className="py-2.5 px-4 font-semibold text-slate-300 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border bg-card/40">
              {orgs.data?.length === 0 && (
                <tr>
                  <td colSpan={10} className="py-8 text-center text-sm text-slate-400">
                    No yards registered yet. Click <span className="font-semibold text-amber-300">&ldquo;+ Add Yard&rdquo;</span> above to create your first yard.
                  </td>
                </tr>
              )}
              {orgs.data?.map((o, i) => {
                const isOrgDisabled = Boolean(o.blocked || o.status === "canceled");
                const isDemo = o.status === "demo";
                return (
                  <tr key={o.id} data-testid={`admin-org-row-${i}`} className={cn(orgId === o.id && "bg-sky-500/[0.06]", isOrgDisabled && "opacity-75")}>
                    <td className="py-3 px-4 font-medium">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          data-testid={`admin-org-name-${i}`}
                          className="font-medium text-white hover:text-amber-300 hover:underline text-left cursor-pointer"
                          title="Click to view yard info & staff"
                          onClick={() => setSelectedYard(o)}
                        >
                          {o.name}
                        </button>
                        <button
                          type="button"
                          data-testid={`admin-org-info-btn-${i}`}
                          className="rounded p-1 text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                          title="View yard details and users"
                          onClick={() => setSelectedYard(o)}
                        >
                          <Eye className="size-3.5" />
                        </button>
                        {isOrgDisabled && (
                          <span className="rounded bg-red-500/20 px-1.5 py-0.5 font-mono text-[10px] text-red-300">
                            Disabled
                          </span>
                        )}
                        {isDemo && (
                          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-amber-300 ring-1 ring-amber-500/30">
                            Demo
                          </span>
                        )}
                      </div>
                    </td>
                  <td className="py-3 px-3">
                    <select data-testid={`admin-org-plan-${i}`} className={cn(sel, "w-full min-w-[130px]")} value={o.plan} onChange={(e) => updOrg.mutate({ id: o.id, body: { plan: e.target.value as PlanId } })}>
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
                  <td className="py-3 px-3">
                    <select data-testid={`admin-org-status-${i}`} className={cn(sel, "w-full min-w-[110px]")} value={o.status} onChange={(e) => updOrg.mutate({ id: o.id, body: { status: e.target.value as OrgStatus } })}>
                      {STATUSES.map((s) => <option key={s}>{s}</option>)}
                    </select>
                  </td>
                  <td className="py-3 px-3 font-mono text-xs text-slate-400 whitespace-nowrap">
                    {o.status === "trialing" && o.trial_ends_at ? fmtDate(o.trial_ends_at) : "—"}
                  </td>
                  <td className="py-3 px-3 text-xs" data-testid={`admin-org-card-${i}`}>
                    {isDemo ? (
                      <span className="font-mono text-slate-500 select-none" title="Card not applicable in demo mode">—</span>
                    ) : o.blocked ? (
                      <span className="text-red-300" title={o.cancel_reason}>closed</span>
                    ) : o.card_on_file ? (
                      <span className="text-emerald-300">on file</span>
                    ) : (
                      <span className="text-slate-500">none</span>
                    )}
                  </td>
                  <td className="py-3 px-3"><DiscountButton org={o} index={i} /></td>
                  <td className="py-3 px-3 font-mono">
                    <button
                      type="button"
                      className="transition-colors hover:text-amber-300 hover:underline cursor-pointer"
                      title={`Filter users by ${o.name}`}
                      onClick={() => setOrgId(orgId === o.id ? "" : o.id)}
                    >
                      {o.users}
                    </button>
                  </td>
                  <td className="py-3 px-3 font-mono">{o.calls}</td>
                  <td className="py-3 px-3 text-xs">{o.ringcentral_connected ? <span className="text-emerald-300">connected</span> : <span className="text-slate-500">—</span>}</td>
                  <td className="py-3 px-3">
                    <div className="flex justify-end items-center gap-1.5 whitespace-nowrap">
                      <Button
                        size="sm"
                        variant="ghost"
                        data-testid={`admin-org-paylink-${i}`}
                        disabled={isDemo}
                        className={cn(isDemo && "opacity-40 cursor-not-allowed hover:bg-transparent hover:text-inherit text-slate-500")}
                        title={isDemo ? "Payment link unavailable in demo mode" : "Copy payment link"}
                        onClick={() => !isDemo && payLink.mutate(o.id)}
                      >
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
          <div className="flex items-center gap-2">
            <Input data-testid="admin-user-search" placeholder="Search name or email" value={q} onChange={(e) => setQ(e.target.value)} className="h-9 w-64 bg-surface" />
            <Button
              size="sm"
              data-testid="admin-add-user-btn"
              onClick={() => setUserDialogOpen(true)}
              className="gap-1.5"
            >
              <Plus className="size-4" /> Add user
            </Button>
          </div>
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
              {sortedUsers.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-8 text-center text-sm text-slate-400">
                    No users found.
                  </td>
                </tr>
              )}
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
                      <Button
                        size="sm"
                        variant="ghost"
                        data-testid={`admin-user-set-pw-${i}`}
                        className="text-xs hover:text-amber-300"
                        title="Set password manually"
                        onClick={() => setPasswordUser(u)}
                      >
                        <KeyRound className="mr-1 size-3.5" /> Set password
                      </Button>
                      {(me?.role === "master" || !staff) && u.id !== me?.id && (
                        <Button
                          size="sm"
                          variant="ghost"
                          data-testid={`admin-user-delete-${i}`}
                          className="text-xs text-red-300 hover:text-red-200"
                          disabled={delUser.isPending}
                          title="Delete this login (their calls and sales are kept)"
                          onClick={() =>
                            window.confirm(`Delete ${u.name}'s account (${u.email})?\n\nTheir login is removed for good. Their calls, sales and other data are kept.`) &&
                            delUser.mutate(u.id)
                          }
                        >
                          <Trash2 className="mr-1 size-3.5" /> Delete
                        </Button>
                      )}
                      {!staff && (
                        <>
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

      <YardDetailDialog
        org={selectedYard}
        onClose={() => setSelectedYard(null)}
        onFilterUsers={(id) => setOrgId(id)}
      />
    </>
  );
}
