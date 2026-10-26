import { useEffect, useState } from "react";
import { resetBrandingKeepMode } from "@/lib/theme";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { fadeUpLg, settle } from "@/lib/motion";
import { Loader2, ShieldCheck, UserRound, Crown, Briefcase, Package } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Overline } from "@/components/common";
import { homeFor } from "@/components/AppShell";
import { GoogleButton } from "@/components/GoogleSignIn";
import { apiGet, apiPost, errorMessage } from "@/lib/api";
import { beginSession } from "@/lib/session";
import { queryClient } from "@/lib/queryClient";
import type { DemoLoginRequest, DemoLoginStatus, User } from "@/lib/types";

const HERO =
  "https://images.unsplash.com/photo-1767340078189-4258fbb7bd7c?crop=entropy&cs=srgb&fm=jpg&ixlib=rb-4.1.0&q=85&w=1600";

export default function Login() {
  useEffect(() => resetBrandingKeepMode(), []); // signed-out pages use the Salvage Pulse brand
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const signedIn = (user: User) => {
    beginSession();
    queryClient.setQueryData(["me"], user);
    toast.success(`Welcome back, ${user.name.split(" ")[0]}`);
    nav(homeFor(user.role), { replace: true });
  };
  const login = useMutation({
    mutationFn: (body: { email: string; password: string }) =>
      apiPost<User>("/auth/login", body),
    onSuccess: signedIn,
    onError: (e) => toast.error(errorMessage(e, "Login failed")),
  });
  // Demo-yard sign-in happens server-side (no passwords in the browser); hidden unless the server enables it.
  const demo = useQuery({
    queryKey: ["demo-login"],
    queryFn: () => apiGet<DemoLoginStatus>("/auth/demo-login"),
    staleTime: Infinity,
  });
  const demoLogin = useMutation({
    mutationFn: (role: DemoLoginRequest["role"]) =>
      apiPost<User>("/auth/demo-login", { role } satisfies DemoLoginRequest),
    onSuccess: signedIn,
    onError: (e) => toast.error(errorMessage(e, "Demo login failed")),
  });

  return (
    <div className="grid min-h-screen grid-cols-1 bg-background lg:grid-cols-[1.15fr_1fr]">
      <section className="relative hidden overflow-hidden lg:block">
        <img
          src={HERO}
          alt="Salvage yard"
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-br from-background/95 via-background/75 to-background/40" />
        <div className="relative flex h-full flex-col justify-between p-12">
          <div className="flex items-center gap-3">
            <img
              src="/salvage-pulse-logo.jpg"
              alt="Salvage Pulse"
              className="h-14 w-auto rounded-md"
            />
            <span className="font-heading text-xl font-extrabold text-white">
              Salvage Pulse AI{" "}
              <span className="block font-mono text-[10px] font-normal uppercase tracking-[0.2em] text-sky-300">
                Call coaching for auto recyclers
              </span>
            </span>
          </div>
          <div className="max-w-xl">
            <Overline>Call intelligence for automotive recyclers</Overline>
            <h1 className="mt-4 text-5xl font-extrabold leading-[1.05] text-white">
              Every call scored. <br />
              <span className="text-amber-400">Every rep coached.</span>
            </h1>
            <p className="mt-5 max-w-md text-[15px] leading-relaxed text-slate-300">
              Upload yard calls, auto-sort them into categories, track the
              keywords that move parts, and turn every conversation into sales
              training — with an AI customer to practice on.
            </p>
          </div>
          <div className="grid max-w-xl grid-cols-3 gap-3">
            {[
              ["7", "scoring metrics"],
              ["8", "call categories"],
              ["24/7", "AI role-play"],
            ].map(([v, l]) => (
              <div
                key={l}
                className="rounded-xl border border-slate-700/60 bg-slate-900/70 p-4 backdrop-blur-xl"
              >
                <p className="font-heading text-2xl font-bold text-white">
                  {v}
                </p>
                <p className="font-mono text-[10px] uppercase tracking-wider text-slate-400">
                  {l}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-grid flex items-center justify-center px-6 py-12">
        <motion.div
          {...fadeUpLg}
          transition={settle}
          className="w-full max-w-md"
        >
          <Overline>Secure sign in</Overline>
          <h2 className="mt-2 text-3xl font-bold text-white">
            Access your yard console
          </h2>
          <p className="mt-2 text-sm text-slate-400">
            Managers see the whole team. Reps see their own call makeup.
          </p>

          <form
            className="mt-8 space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              login.mutate({ email, password });
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                data-testid="login-email-input"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@yard.com"
                className="h-11 bg-card"
                required
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="password">Password</Label>
                <Link to="/forgot-password" data-testid="login-forgot-password-link" className="text-xs text-slate-400 transition-colors duration-150 hover:text-amber-300">
                  Forgot password?
                </Link>
              </div>
              <Input
                id="password"
                data-testid="login-password-input"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-11 bg-card"
                required
              />
            </div>
            <Button
              data-testid="login-submit-button"
              type="submit"
              className="h-11 w-full text-[15px] font-semibold"
              disabled={login.isPending}
            >
              {login.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                "Sign in"
              )}
            </Button>
          </form>

          <div className="my-5 flex items-center gap-3 font-mono text-[11px] uppercase tracking-wider text-slate-500">
            <span className="h-px flex-1 bg-border" />
            or
            <span className="h-px flex-1 bg-border" />
          </div>
          <GoogleButton />

          <div className="mt-8 rounded-xl border border-border bg-card/80 p-4">
            <p className="mb-3 text-sm text-slate-400">
              New yard?{" "}
              <Link
                to="/signup"
                data-testid="login-signup-link"
                className="font-medium text-amber-300 hover:underline"
              >
                Try it free for a day — no card
              </Link>
            </p>
            {demo.data?.enabled && (
              <>
                <p className="font-mono text-[11px] uppercase tracking-wider text-slate-500">
                  Try the demo yard
                </p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    data-testid="demo-owner-button"
                    disabled={demoLogin.isPending}
                    onClick={() => demoLogin.mutate("owner")}
                    className="flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-left text-xs text-slate-200 transition-colors duration-150 hover:border-amber-500/60"
                  >
                    <Crown className="size-4 text-amber-400 shrink-0" />
                    <div>
                      <p className="font-medium text-white leading-tight">Owner</p>
                      <p className="text-[10px] text-slate-400">Linda Carter</p>
                    </div>
                  </button>
                  <button
                    type="button"
                    data-testid="demo-sales-manager-button"
                    disabled={demoLogin.isPending}
                    onClick={() => demoLogin.mutate("sales_manager")}
                    className="flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-left text-xs text-slate-200 transition-colors duration-150 hover:border-sky-500/60"
                  >
                    <Briefcase className="size-4 text-sky-400 shrink-0" />
                    <div>
                      <p className="font-medium text-white leading-tight">Sales Mgr</p>
                      <p className="text-[10px] text-slate-400">Marcus Reed</p>
                    </div>
                  </button>
                  <button
                    type="button"
                    data-testid="demo-inventory-manager-button"
                    disabled={demoLogin.isPending}
                    onClick={() => demoLogin.mutate("inventory_manager")}
                    className="flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-left text-xs text-slate-200 transition-colors duration-150 hover:border-emerald-500/60"
                  >
                    <Package className="size-4 text-emerald-400 shrink-0" />
                    <div>
                      <p className="font-medium text-white leading-tight">Inv Mgr</p>
                      <p className="text-[10px] text-slate-400">Rick Martinez</p>
                    </div>
                  </button>
                  <button
                    type="button"
                    data-testid="demo-rep-button"
                    disabled={demoLogin.isPending}
                    onClick={() => demoLogin.mutate("rep")}
                    className="flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-left text-xs text-slate-200 transition-colors duration-150 hover:border-indigo-500/60"
                  >
                    <UserRound className="size-4 text-indigo-400 shrink-0" />
                    <div>
                      <p className="font-medium text-white leading-tight">Sales Rep</p>
                      <p className="text-[10px] text-slate-400">Tyler Grant</p>
                    </div>
                  </button>
                </div>
              </>
            )}
          </div>
        </motion.div>
      </section>
    </div>
  );
}
