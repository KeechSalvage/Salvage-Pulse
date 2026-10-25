import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, Mail, MailWarning, Pencil, UserPlus, Users, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Panel } from "@/components/common";
import { apiGet, apiPatch, apiPost, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { StaffAccount, StaffCreate, StaffCreated, StaffLockdown, StaffUpdate } from "@/lib/types";

const KEY = ["admin", "staff"];
const sel = "h-8 rounded-md border border-border bg-card px-2 text-sm text-white";

/** Console → Staff accounts (masters): add, rename, change role, turn off, give a new starting password. */
export default function StaffAccountsPanel() {
  const qc = useQueryClient();
  const lock = useQuery({ queryKey: ["admin", "staff-lockdown"], queryFn: () => apiGet<StaffLockdown>("/admin/staff-lockdown") });
  const domain = lock.data?.staff_domain ?? "salvagepulsepro.com";
  const { data } = useQuery({ queryKey: KEY, queryFn: () => apiGet<StaffAccount[]>("/admin/staff") });
  const [form, setForm] = useState<StaffCreate>({ name: "", email: "", role: "admin" });
  const [shown, setShown] = useState<StaffCreated | null>(null);
  const [editing, setEditing] = useState("");
  const [name, setName] = useState("");
  const add = useMutation({
    mutationFn: () => apiPost<StaffCreated>("/admin/staff", form),
    onSuccess: (r) => {
      setShown(r);
      setForm({ name: "", email: "", role: "admin" });
      qc.invalidateQueries({ queryKey: KEY });
      toast.success(r.emailed ? `${r.account.name} added — welcome email sent` : `${r.account.name} added`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: StaffUpdate }) => apiPatch<StaffAccount[]>(`/admin/staff/${id}`, body),
    onSuccess: (d) => {
      qc.setQueryData(KEY, d);
      setEditing("");
      toast.success("Staff login updated");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const reset = useMutation({
    mutationFn: (id: string) => apiPost<StaffCreated>(`/admin/staff/${id}/reset-password`),
    onSuccess: (r) => {
      setShown(r);
      qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const ready = form.name.trim() && form.email.toLowerCase().trim().endsWith(`@${domain}`);
  return (
    <Panel testId="staff-accounts-panel" className="mt-6">
      <div className="flex items-center gap-3">
        <Users className="size-5 text-sky-300" />
        <div>
          <h3 className="text-xl font-bold text-white">Staff accounts</h3>
          <p className="text-xs text-slate-500">Masters can log in as any yard user; admins can't. New logins get a welcome email with a one-tap link to set their own password.</p>
        </div>
      </div>

      {(data ?? []).some((s) => s.email_bounced_at && !s.disabled) && (
        <div data-testid="staff-bounce-warning" className="mt-4 flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-100">
          <MailWarning className="mt-0.5 size-4 shrink-0" />
          <span>
            Emails to {(data ?? []).filter((s) => s.email_bounced_at && !s.disabled).map((s) => s.name).join(", ")} bounce — that mailbox doesn't seem to exist, so they won't get
            security alerts or set-password links. Create the mailbox, or give them a <strong>New password</strong> here and pass it on in person.
          </span>
        </div>
      )}
      {shown?.emailed && (
        <div data-testid="staff-welcome-sent-box" className="mt-4 flex items-center gap-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-100">
          <Mail className="size-4" />
          <span>
            Email sent to <strong>{shown.account.email}</strong> with a one-tap link to set their password (works once, for 72 hours). Nothing to share by hand.
          </span>
          <Button size="icon" variant="ghost" aria-label="Hide" data-testid="staff-welcome-sent-hide" className="ml-auto" onClick={() => setShown(null)}><X className="size-4" /></Button>
        </div>
      )}
      {shown && !shown.emailed && (
        <div data-testid="staff-temp-password-box" className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100">
          <KeyRound className="size-4" />
          <span>
            Couldn't email {shown.account.email} (does that mailbox exist?). Starting password instead:{" "}
            <code data-testid="staff-temp-password" className="rounded bg-black/30 px-1.5 py-0.5 font-mono text-white">{shown.temp_password}</code> — shown once; they'll pick their own at first sign-in.
          </span>
          <Button size="sm" variant="outline" data-testid="staff-temp-password-copy" onClick={() => navigator.clipboard?.writeText(shown.temp_password).then(() => toast.success("Copied"))}>
            <Copy className="size-3.5" /> Copy
          </Button>
          <Button size="icon" variant="ghost" aria-label="Hide" data-testid="staff-temp-password-hide" className="ml-auto" onClick={() => setShown(null)}><X className="size-4" /></Button>
        </div>
      )}

      <ul className="mt-4 divide-y divide-border">
        {(data ?? []).map((s) => (
          <li key={s.id} data-testid={`staff-row-${s.id}`} className={cn("flex flex-wrap items-center gap-3 py-3", s.disabled && "opacity-60")}>
            <div className="mr-auto min-w-0">
              {editing === s.id ? (
                <form className="flex items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); update.mutate({ id: s.id, body: { name } }); }}>
                  <Input autoFocus maxLength={80} value={name} onChange={(e) => setName(e.target.value)} data-testid={`staff-name-input-${s.id}`} className="h-8 w-48" />
                  <Button type="submit" size="icon" variant="ghost" aria-label="Save name" data-testid={`staff-name-save-${s.id}`} disabled={!name.trim()}><Check className="size-4 text-emerald-300" /></Button>
                  <Button type="button" size="icon" variant="ghost" aria-label="Cancel" data-testid={`staff-name-cancel-${s.id}`} onClick={() => setEditing("")}><X className="size-4" /></Button>
                </form>
              ) : (
                <p className="font-medium text-white" data-testid={`staff-name-${s.id}`}>
                  {s.name}
                  {s.you && <span className="ml-2 rounded bg-sky-500/15 px-1.5 py-0.5 align-middle text-[10px] uppercase text-sky-300">you</span>}
                  {s.must_change_password && <span data-testid={`staff-starting-pw-${s.id}`} className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 align-middle text-[10px] uppercase text-amber-300">starting password</span>}
                  <span data-testid={`staff-google-${s.id}`} className={cn("ml-2 rounded px-1.5 py-0.5 align-middle text-[10px] uppercase", s.google_linked ? "bg-emerald-500/15 text-emerald-300" : "bg-white/5 text-slate-500")}>
                    {s.google_linked ? "Google ✓" : "no Google yet"}
                  </span>
                  {s.email_bounced_at && (
                    <span data-testid={`staff-bounce-${s.id}`} title={s.email_bounce_reason} className="ml-2 rounded bg-red-500/15 px-1.5 py-0.5 align-middle text-[10px] uppercase text-red-300">
                      email bounces
                    </span>
                  )}
                  {s.disabled && <span data-testid={`staff-off-${s.id}`} className="ml-2 rounded bg-red-500/15 px-1.5 py-0.5 align-middle text-[10px] uppercase text-red-300">off</span>}
                  <button type="button" aria-label="Rename" data-testid={`staff-rename-${s.id}`} onClick={() => (setEditing(s.id), setName(s.name))}
                    className="ml-2 inline-flex rounded p-1 align-middle text-slate-500 transition-colors duration-150 hover:bg-white/5 hover:text-amber-300">
                    <Pencil className="size-3.5" />
                  </button>
                </p>
              )}
              <p className="font-mono text-xs text-slate-500" data-testid={`staff-email-${s.id}`}>{s.email}</p>
            </div>
            <select aria-label="Role" data-testid={`staff-role-${s.id}`} className={sel} value={s.role} disabled={s.you || update.isPending}
              onChange={(e) => update.mutate({ id: s.id, body: { role: e.target.value as "master" | "admin" } })}>
              <option value="master">Master</option>
              <option value="admin">Admin</option>
            </select>
            <Button size="sm" variant="outline" data-testid={`staff-reset-${s.id}`} disabled={s.you || reset.isPending}
              onClick={() => window.confirm(`Reset ${s.name}'s password? They're signed out everywhere and get an email link to set a new one.`) && reset.mutate(s.id)}>
              <KeyRound className="size-3.5" /> New password
            </Button>
            <Button size="sm" variant={s.disabled ? "outline" : "destructive"} data-testid={`staff-toggle-${s.id}`} disabled={s.you || update.isPending}
              onClick={() => (s.disabled || window.confirm(`Turn off ${s.name}'s login? They're signed out right away.`)) && update.mutate({ id: s.id, body: { disabled: !s.disabled } })}>
              {s.disabled ? "Turn on" : "Turn off"}
            </Button>
          </li>
        ))}
      </ul>

      <form className="mt-4 grid gap-3 border-t border-border pt-4 sm:grid-cols-[1fr_1.4fr_auto_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); if (ready) add.mutate(); }}>
        <div className="space-y-1.5">
          <Label htmlFor="staff-new-name">Name</Label>
          <Input id="staff-new-name" data-testid="staff-new-name" maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. JamieR" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="staff-new-email">Email</Label>
          <Input id="staff-new-email" data-testid="staff-new-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder={`name@${domain}`} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="staff-new-role">Role</Label>
          <select id="staff-new-role" data-testid="staff-new-role" className={cn(sel, "h-9")} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as "master" | "admin" })}>
            <option value="admin">Admin</option>
            <option value="master">Master</option>
          </select>
        </div>
        <Button type="submit" data-testid="staff-add-button" disabled={!ready || add.isPending}>
          <UserPlus className="size-4" /> Add staff login
        </Button>
      </form>
    </Panel>
  );
}
