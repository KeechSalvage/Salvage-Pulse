import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, LogOut, MonitorSmartphone, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Panel } from "@/components/common";
import { apiDelete, apiGet, apiPost, apiPut, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { PasswordChange, RemindersToggle, ResetResult, SignOutResult, StaffDevices, StaffLockdown } from "@/lib/types";

/** Console "Staff sign-in security": Google-only switch (master) + new-device alerts note. */
export function StaffLockdownPanel({ isMaster }: { isMaster: boolean }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["admin", "staff-lockdown"], queryFn: () => apiGet<StaffLockdown>("/admin/staff-lockdown") });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => apiPut<StaffLockdown>("/admin/staff-lockdown", { enabled } satisfies RemindersToggle),
    onSuccess: (d) => {
      qc.setQueryData(["admin", "staff-lockdown"], d);
      toast.success(d.enabled ? "Staff now sign in with Google only" : "Staff passwords work again");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!data) return null;
  const ask = () =>
    data.enabled
      ? window.confirm("Allow master and admin to sign in with passwords again?")
      : window.confirm(`Require Google sign-in with an @${data.staff_domain} account for master and admin?\n\nPasswords and "Forgot password" stop working for staff. Yard logins are not affected.`);
  return (
    <Panel testId="admin-staff-lockdown-panel" className="mt-6">
      <div className="flex flex-wrap items-center gap-3">
        <ShieldCheck className="size-5 text-sky-300" />
        <div className="mr-auto max-w-2xl">
          <h3 className="text-xl font-bold text-white">Staff sign-in security</h3>
          <p className="text-xs text-slate-500">
            Google-only: master and admin must use "Continue with Google" with their @{data.staff_domain} Workspace account — passwords and resets stop working for them.
            Every staff sign-in from a new browser emails the master address.
          </p>
          {!data.enabled && data.staff_total > 0 && (
            <div className="mt-2 max-w-md" data-testid="admin-staff-google-progress">
              <div className="flex justify-between font-mono text-[11px] text-slate-400">
                <span>{data.google_linked} of {data.staff_total} staff have signed in with Google</span>
                <span>turns on automatically at {data.staff_total}</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-emerald-400 transition-[width] duration-500" style={{ width: `${Math.round((100 * data.google_linked) / data.staff_total)}%` }} />
              </div>
            </div>
          )}
          {isMaster && !data.enabled && !data.you_signed_in_with_google && (
            <p data-testid="admin-staff-lockdown-hint" className="mt-1 text-xs text-amber-300">
              To switch it on, first sign out and back in with Google using your @{data.staff_domain} account — that proves it works before passwords go off.
            </p>
          )}
        </div>
        <span
          data-testid="admin-staff-lockdown-state"
          className={cn("rounded border px-2 py-0.5 font-mono text-[11px] uppercase", data.enabled ? "border-emerald-500/40 text-emerald-300" : "border-slate-600 text-slate-400")}
        >
          {data.enabled ? "On — Google only" : "Off — passwords allowed"}
        </span>
        {isMaster && (
          <Button size="sm" variant={data.enabled ? "outline" : "default"} data-testid="admin-staff-lockdown-toggle" disabled={toggle.isPending} onClick={() => ask() && toggle.mutate(!data.enabled)}>
            {data.enabled ? "Allow passwords" : "Require Google"}
          </Button>
        )}
      </div>
    </Panel>
  );
}

/** Change your own password (current password required; other devices are signed out). */
export function ChangePasswordPanel({ onChanged, className = "mt-6", first = false }: { onChanged?: () => void; className?: string; first?: boolean }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const change = useMutation({
    mutationFn: () => apiPost<ResetResult>("/auth/change-password", { current_password: current, new_password: next } satisfies PasswordChange),
    onSuccess: (r) => {
      toast.success(r.message);
      setCurrent("");
      setNext("");
      setConfirm("");
      onChanged?.();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const mismatch = confirm.length > 0 && confirm !== next;
  const ready = current && next.length >= 8 && next === confirm;
  return (
    <Panel testId="change-password-panel" className={className}>
      <div className="flex items-center gap-3">
        <KeyRound className="size-5 text-sky-300" />
        <div>
          <h3 className="text-xl font-bold text-white">{first ? "Choose your own password" : "Change your password"}</h3>
          <p className="text-xs text-slate-500">
            {first
              ? "You're signed in with a starting password. Type it as the current password, then pick your own (at least 8 characters) to open the app."
              : "At least 8 characters. Your other signed-in devices are signed out; this one stays signed in."}
          </p>
        </div>
      </div>
      <form
        className="mt-4 grid gap-4 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) change.mutate();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="pw-current">Current password</Label>
          <Input id="pw-current" type="password" autoComplete="current-password" data-testid="change-password-current" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pw-new">New password</Label>
          <Input id="pw-new" type="password" autoComplete="new-password" data-testid="change-password-new" value={next} onChange={(e) => setNext(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pw-confirm">Repeat new password</Label>
          <Input id="pw-confirm" type="password" autoComplete="new-password" data-testid="change-password-confirm" aria-invalid={mismatch} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        <Button type="submit" data-testid="change-password-submit" disabled={!ready || change.isPending}>
          {change.isPending ? "Saving…" : "Change password"}
        </Button>
      </form>
      {mismatch && <p data-testid="change-password-mismatch" className="mt-2 text-xs text-red-300">The new passwords don't match</p>}
      {next.length > 0 && next.length < 8 && <p className="mt-2 text-xs text-slate-500">{8 - next.length} more characters needed</p>}
    </Panel>
  );
}

const seen = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "before tracking");

/** Each staff account's remembered browsers, with "forget this device" and "sign out everywhere" (master only). */
export function StaffDevicesPanel({ isMaster }: { isMaster: boolean }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["admin", "staff-devices"], queryFn: () => apiGet<StaffDevices[]>("/admin/staff-devices") });
  const forget = useMutation({
    mutationFn: ({ user, device }: { user: string; device: string }) => apiDelete<StaffDevices[]>(`/admin/staff-devices/${user}/${device}`),
    onSuccess: (d) => {
      qc.setQueryData(["admin", "staff-devices"], d);
      toast.success("Device forgotten — its sign-ins ended and the next sign-in from it will alert you");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const signOut = useMutation({
    mutationFn: (user: string) => apiPost<SignOutResult>(`/admin/staff/${user}/sign-out-everywhere`),
    onSuccess: (r) => {
      if (r.you) {
        window.location.assign("/login");
        return;
      }
      toast.success(`Signed out of ${r.ended} session${r.ended === 1 ? "" : "s"}`);
      qc.invalidateQueries({ queryKey: ["admin", "staff-devices"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!data) return null;
  return (
    <Panel testId="admin-staff-devices-panel" className="mt-6">
      <div className="flex items-center gap-3">
        <MonitorSmartphone className="size-5 text-sky-300" />
        <div>
          <h3 className="text-xl font-bold text-white">Trusted devices</h3>
          <p className="text-xs text-slate-500">Browsers each staff account has signed in from. Forgetting one ends its sign-ins; "Sign out everywhere" ends all of them (use it after a suspicious alert).</p>
        </div>
      </div>
      <div className="mt-4 space-y-5">
        {data.map((u) => (
          <div key={u.user_id} data-testid={`staff-devices-${u.role}`}>
            <div className="flex flex-wrap items-center gap-3">
              <p className="font-medium text-white">{u.name} <span className="font-mono text-xs text-slate-500">{u.email} · {u.role}</span></p>
              <span data-testid={`staff-sessions-${u.role}`} className="font-mono text-xs text-slate-400">{u.sessions} active sign-in{u.sessions === 1 ? "" : "s"}</span>
              {isMaster && (
                <Button
                  size="sm"
                  variant="destructive"
                  className="ml-auto"
                  data-testid={`staff-sign-out-everywhere-${u.role}`}
                  disabled={signOut.isPending}
                  onClick={() => window.confirm(`Sign ${u.email} out on every device${u.devices.some((d) => d.this_browser) ? " — including this browser" : ""}?`) && signOut.mutate(u.user_id)}
                >
                  <LogOut className="size-4" /> Sign out everywhere
                </Button>
              )}
            </div>
            {u.devices.length === 0 ? (
              <p className="mt-2 text-xs text-slate-500">No remembered browsers yet.</p>
            ) : (
              <table className="mt-2 w-full text-sm">
                <tbody className="divide-y divide-border">
                  {u.devices.map((d) => (
                    <tr key={d.id} data-testid={`staff-device-${d.id}`}>
                      <td className="py-2 pr-3 text-slate-200">
                        {d.nickname ? `${d.nickname} · ${d.browser}` : d.browser}
                        {d.this_browser && <span className="ml-2 rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] uppercase text-sky-300">this browser</span>}
                      </td>
                      <td className="pr-3 font-mono text-xs text-slate-500">{d.ip || "—"}</td>
                      <td className="pr-3 font-mono text-xs text-slate-500">first {seen(d.first_seen)}</td>
                      <td className="pr-3 font-mono text-xs text-slate-400">last {seen(d.last_seen)}</td>
                      <td className="text-right">
                        {isMaster && (
                          <Button size="sm" variant="ghost" data-testid={`staff-forget-device-${d.id}`} disabled={forget.isPending} onClick={() => window.confirm(`Forget ${d.browser}? Its sign-ins end now.`) && forget.mutate({ user: u.user_id, device: d.id })}>
                            Forget
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))}
      </div>
    </Panel>
  );
}
