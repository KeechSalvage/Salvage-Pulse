import { useEffect, useState } from "react";
import IntervalToggle from "@/components/IntervalToggle";
import { resetBrandingKeepMode } from "@/lib/theme";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiGet, apiPost, errorMessage } from "@/lib/api";
import { beginSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { GoogleButton, startGoogleSignIn } from "@/components/GoogleSignIn";
import type { BillingInterval, Plan, PlanId, SignupRequest, User, YardDiscount } from "@/lib/types";

export function PlanCards({ selected, onPick, testPrefix = "plan", interval = "month", discount }: { selected?: PlanId; onPick: (p: PlanId) => void; testPrefix?: string; interval?: BillingInterval; discount?: YardDiscount | null }) {
  const { data: plans } = useQuery({ queryKey: ["plans"], queryFn: () => apiGet<Plan[]>("/billing/plans"), staleTime: Infinity });
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
      {(plans ?? []).map((p) => (
        <button
          key={p.id}
          type="button"
          data-testid={`${testPrefix}-card-${p.id}`}
          onClick={() => onPick(p.id)}
          className={cn(
            "flex flex-col justify-start rounded-xl border bg-card p-5 text-left transition-[border-color,transform] duration-150 hover:-translate-y-0.5",
            selected === p.id ? "border-sky-400 ring-1 ring-sky-400/50" : "border-border hover:border-slate-600",
          )}
        >
          <p className="font-mono text-[11px] uppercase tracking-wider text-sky-300">{p.name}</p>
          {discount ? (
            <>
              <p className="mt-2 font-heading text-3xl font-bold text-emerald-300" data-testid={`${testPrefix}-discount-price-${p.id}`}>
                {((v) => `$${v.toLocaleString(undefined, { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 })}`)(((interval === "year" ? p.price_yearly : p.price) * (100 - discount.percent)) / 100)}
                <span className="text-sm font-normal text-slate-400">{interval === "year" ? "/yr" : "/mo"}</span>
                <span className="ml-2 text-base font-normal text-slate-500 line-through">${(interval === "year" ? p.price_yearly : p.price).toLocaleString()}</span>
              </p>
              <p className="font-mono text-[11px] text-emerald-300" data-testid={`${testPrefix}-discount-note-${p.id}`}>
                Your {discount.percent}% off · {discount.ends_at ? `until ${new Date(discount.ends_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}` : `for ${discount.months} month${discount.months === 1 ? "" : "s"}`}
              </p>
            </>
          ) : (
            <p className="mt-2 font-heading text-3xl font-bold text-white">
              ${interval === "year" ? p.price_yearly.toLocaleString() : p.price}
              <span className="text-sm font-normal text-slate-400">{interval === "year" ? "/yr" : "/mo"}</span>
            </p>
          )}
          {interval === "year" && (
            <p className="font-mono text-[11px] text-emerald-300" data-testid={`${testPrefix}-yearly-saving-${p.id}`}>
              1 month free · save ${p.price} (≈ ${Math.round(p.price_yearly / 12)}/mo)
            </p>
          )}
          <ul className="mt-3 space-y-1.5">
            {p.features.map((f) => (
              <li key={f} className="flex gap-2 text-sm text-slate-300">
                <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-400" /> {f}
              </li>
            ))}
          </ul>
        </button>
      ))}
    </div>
  );
}

export default function Signup() {
  useEffect(() => resetBrandingKeepMode(), []); // signed-out pages use the Salvage Pulse brand
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [form, setForm] = useState<SignupRequest>({ yard_name: "", name: "", email: "", password: "", plan: (params.get("plan") as PlanId) || "pro" });
  const [interval, setInterval_] = useState<BillingInterval>(params.get("interval") === "year" ? "year" : "month");
  const set = (k: keyof SignupRequest) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  const signup = useMutation({
    mutationFn: () => apiPost<User>("/auth/signup", form),
    onSuccess: () => {
      beginSession();
      toast.success("Your free day has started — no card needed");
      nav("/dashboard");
    },
    onError: (e) => toast.error(errorMessage(e, "Sign-up failed")),
  });

  return (
    <div className="bg-grid min-h-screen px-4 py-10 md:px-10">
      <div className="mx-auto max-w-5xl">
        <div className="flex items-center gap-4">
          <img src="/salvage-pulse-logo.jpg" alt="Salvage Pulse" className="h-16 w-auto rounded-md" />
          <div>
            <h1 className="font-heading text-3xl font-extrabold text-white">Salvage Pulse AI</h1>
            <p className="text-sm text-slate-400">Call scoring, sales coaching and AI role-play for auto recyclers</p>
          </div>
          <Link to="/login" data-testid="signup-login-link" className="ml-auto text-sm text-sky-300 hover:underline">
            Already have an account? Sign in
          </Link>
        </div>

        <h2 className="mt-10 text-xl font-bold text-white">1. Pick a plan — try it free for a day, no card needed</h2>
        <div className="mt-4">
          <IntervalToggle value={interval} onChange={setInterval_} />
          <PlanCards selected={form.plan} onPick={(plan) => setForm({ ...form, plan })} interval={interval} />
        </div>

        <h2 className="mt-10 text-xl font-bold text-white">2. Create your yard's account</h2>
        <form
          className="mt-4 grid max-w-2xl grid-cols-1 gap-4 rounded-xl border border-border bg-card p-6 md:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            signup.mutate();
          }}
        >
          {(
            [
              ["yard_name", "Yard / company name", "text"],
              ["name", "Your name", "text"],
              ["email", "Work email", "email"],
              ["password", "Password (8+ characters)", "password"],
            ] as const
          ).map(([k, label, type]) => (
            <div key={k}>
              <Label htmlFor={k}>{label}</Label>
              <Input id={k} data-testid={`signup-${k}-input`} type={type} required minLength={k === "password" ? 8 : 1} value={form[k]} onChange={set(k)} className="mt-1.5 bg-surface" />
            </div>
          ))}
          <Button type="submit" size="lg" data-testid="signup-submit-button" disabled={signup.isPending} className="md:col-span-2">
            {signup.isPending && <Loader2 className="size-4 animate-spin" />} Start free trial
          </Button>
          <div className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-wider text-slate-500 md:col-span-2">
            <span className="h-px flex-1 bg-border" />
            or skip the password
            <span className="h-px flex-1 bg-border" />
          </div>
          <div className="md:col-span-2">
            <GoogleButton
              label="Sign up with Google"
              testId="signup-google-button"
              onClick={() => {
                if (form.yard_name.trim().length < 2) {
                  toast.error("Enter your yard / company name first");
                  document.getElementById("yard_name")?.focus();
                  return;
                }
                startGoogleSignIn({ yard_name: form.yard_name.trim(), plan: form.plan });
              }}
            />
            <p className="mt-2 text-xs text-slate-500">Uses your yard name and plan above; your name and email come from Google.</p>
          </div>
        </form>
      </div>
    </div>
  );
}
