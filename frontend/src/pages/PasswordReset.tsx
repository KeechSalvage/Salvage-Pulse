import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { motion } from "motion/react";
import { CheckCircle2, KeyRound, Loader2, Lock, MailCheck, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Overline } from "@/components/common";
import { apiPost, errorMessage } from "@/lib/api";
import { fadeUpLg, settle } from "@/lib/motion";
import { resetBrandingKeepMode } from "@/lib/theme";
import AppFooter from "@/components/AppFooter";
import type { ForgotPasswordRequest, LockAccountRequest, LockAccountResult, NotMeRequest, NotMeResult, PasswordResetRequest, ResetResult } from "@/lib/types";

function AuthCard({ overline, title, sub, children }: { overline: string; title: string; sub: string; children: ReactNode }) {
  useEffect(() => resetBrandingKeepMode(), []); // signed-out pages use the Salvage Pulse brand
  return (
    <div className="bg-grid flex min-h-screen flex-col items-center justify-between bg-background px-6 py-12">
      <div className="my-auto w-full max-w-md">
        <motion.div {...fadeUpLg} transition={settle} className="w-full rounded-2xl border border-border bg-card/80 p-8 shadow-2xl backdrop-blur-xl">
          <img src="/salvage-pulse-logo.jpg" alt="Salvage Pulse" className="mb-6 h-14 w-auto rounded" />
          <Overline>{overline}</Overline>
          <h1 className="mt-2 text-3xl font-bold text-white">{title}</h1>
          <p className="mt-2 text-sm text-slate-400">{sub}</p>
          {children}
          <p className="mt-6 text-sm text-slate-500">
            Remembered it?{" "}
            <Link to="/login" data-testid="auth-back-to-login" className="font-medium text-amber-400 hover:underline">
              Back to sign in
            </Link>
          </p>
        </motion.div>
      </div>
      <div className="w-full max-w-md">
        <AppFooter className="mt-6 pt-4 pb-0" />
      </div>
    </div>
  );
}

export function ForgotPassword() {
  const [email, setEmail] = useState("");
  const send = useMutation({
    mutationFn: (b: ForgotPasswordRequest) => apiPost<ResetResult>("/auth/forgot-password", b),
    onError: (e) => toast.error(errorMessage(e, "Couldn't send the reset link")),
  });
  return (
    <AuthCard overline="Forgot password" title="Reset your password" sub="Enter the email you sign in with and we'll send you a link to choose a new password.">
      {send.isSuccess ? (
        <div data-testid="forgot-sent" className="mt-8 flex gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-100">
          <MailCheck className="mt-0.5 size-5 shrink-0 text-emerald-300" />
          <div>
            <p>{send.data.message}</p>
            <p className="mt-1 text-emerald-200/70">The link works once, for 1 hour.</p>
          </div>
        </div>
      ) : (
        <form
          className="mt-8 space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            send.mutate({ email: email.trim() });
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="forgot-email">Email</Label>
            <Input id="forgot-email" data-testid="forgot-email-input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@yard.com" className="h-11 bg-card" />
          </div>
          <Button type="submit" size="lg" data-testid="forgot-submit-button" disabled={send.isPending} className="w-full">
            {send.isPending ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />} Email me a reset link
          </Button>
        </form>
      )}
    </AuthCard>
  );
}

export function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const nav = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const mismatch = confirm.length > 0 && confirm !== password;
  const reset = useMutation({
    mutationFn: (b: PasswordResetRequest) => apiPost<ResetResult>("/auth/reset-password", b),
    onSuccess: (r) => {
      toast.success(r.message);
      nav("/login", { replace: true });
    },
    onError: (e) => toast.error(errorMessage(e, "Couldn't reset your password")),
  });
  if (!token) {
    return (
      <AuthCard overline="Password reset" title="This link is incomplete" sub="Open the link from your reset email again, or request a new one.">
        <Link
          to="/forgot-password"
          data-testid="reset-request-new"
          className="mt-8 flex h-11 w-full items-center justify-center rounded-md bg-amber-500 font-medium text-primary-foreground transition-colors duration-150 hover:bg-amber-400"
        >
          Request a new link
        </Link>
      </AuthCard>
    );
  }
  return (
    <AuthCard overline="Password reset" title="Choose a new password" sub="At least 8 characters. You'll be signed out on every other device.">
      <form
        className="mt-8 space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (password !== confirm) return;
          reset.mutate({ token, password });
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="reset-password">New password</Label>
          <Input id="reset-password" data-testid="reset-password-input" type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} className="h-11 bg-card" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="reset-confirm">Type it again</Label>
          <Input id="reset-confirm" data-testid="reset-confirm-input" type="password" autoComplete="new-password" minLength={8} required value={confirm} onChange={(e) => setConfirm(e.target.value)} className="h-11 bg-card" />
          {mismatch && (
            <p data-testid="reset-mismatch" className="text-xs text-red-300">
              The two passwords don't match yet
            </p>
          )}
        </div>
        <Button type="submit" size="lg" data-testid="reset-submit-button" disabled={reset.isPending || mismatch || password.length < 8} className="w-full">
          {reset.isPending ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />} Save new password
        </Button>
        {reset.isError && (
          <Link to="/forgot-password" data-testid="reset-request-new" className="block text-center text-sm text-amber-400 hover:underline">
            Request a new link
          </Link>
        )}
      </form>
    </AuthCard>
  );
}

/** /not-me?token=… from a new-device alert email: one tap signs that device out, then on to choosing a new password.
 *  A button (not an automatic call on page load) so email link scanners can't use up the link. */
export function NotMe() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const nav = useNavigate();
  const go = useMutation({
    mutationFn: (b: NotMeRequest) => apiPost<NotMeResult>("/auth/not-me", b),
    onSuccess: (r) => {
      toast.success(r.message);
      if (r.reset_token) nav(`/reset-password?token=${encodeURIComponent(r.reset_token)}`, { replace: true });
    },
    onError: (e) => toast.error(errorMessage(e, "Couldn't sign that device out")),
  });
  if (go.isSuccess && !go.data.reset_token) {
    return (
      <AuthCard overline="Security" title="Device signed out" sub={go.data.message}>
        <p data-testid="not-me-done" className="mt-6 text-sm text-slate-400">This account's password can't be reset here.</p>
      </AuthCard>
    );
  }
  return (
    <AuthCard overline="Security" title="Wasn't you?" sub="We'll sign out the device from the alert email right away, then you'll choose a new password so it can't get back in.">
      {!token ? (
        <p data-testid="not-me-missing" className="mt-8 text-sm text-red-300">This link is incomplete — open it from the alert email again, or reset your password.</p>
      ) : (
        <Button size="lg" variant="destructive" data-testid="not-me-confirm-button" disabled={go.isPending} className="mt-8 w-full" onClick={() => go.mutate({ token })}>
          {go.isPending ? <Loader2 className="size-4 animate-spin" /> : <ShieldAlert className="size-4" />} Sign that device out
        </Button>
      )}
      {(go.isError || !token) && (
        <Link to="/forgot-password" data-testid="not-me-forgot-link" className="mt-4 block text-center text-sm text-amber-400 hover:underline">
          Reset my password instead
        </Link>
      )}
    </AuthCard>
  );
}

/** /lock-account?token=… from a lockout email: one tap signs out every device and keeps the account locked until a new password is set. */
export function LockAccount() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const nav = useNavigate();
  const go = useMutation({
    mutationFn: (b: LockAccountRequest) => apiPost<LockAccountResult>("/auth/lock-account", b),
    onSuccess: (r) => {
      toast.success(r.message);
      if (r.reset_token) nav(`/reset-password?token=${encodeURIComponent(r.reset_token)}`, { replace: true });
    },
    onError: (e) => toast.error(errorMessage(e, "Couldn't lock the account")),
  });
  if (go.isSuccess && !go.data.reset_token) {
    return (
      <AuthCard overline="Security" title="Account locked" sub={go.data.message}>
        <p data-testid="lock-account-done" className="mt-6 text-sm text-slate-400">It stays locked until its password is reset.</p>
      </AuthCard>
    );
  }
  return (
    <AuthCard overline="Security" title="Keep your account locked?" sub="We'll sign out every device right now and keep sign-in locked — even with the right password — until you choose a new one.">
      {!token ? (
        <p data-testid="lock-account-missing" className="mt-8 text-sm text-red-300">This link is incomplete — open it from the lockout email again, or reset your password.</p>
      ) : (
        <Button size="lg" variant="destructive" data-testid="lock-account-confirm-button" disabled={go.isPending} className="mt-8 w-full" onClick={() => go.mutate({ token })}>
          {go.isPending ? <Loader2 className="size-4 animate-spin" /> : <Lock className="size-4" />} Lock my account and sign everyone out
        </Button>
      )}
      {(go.isError || !token) && (
        <Link to="/forgot-password" data-testid="lock-account-forgot-link" className="mt-4 block text-center text-sm text-amber-400 hover:underline">
          Reset my password instead
        </Link>
      )}
    </AuthCard>
  );
}
