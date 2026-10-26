import { useEffect, useState } from "react";
import PlanCompareTable from "@/components/PlanCompareTable";
import IntervalToggle from "@/components/IntervalToggle";
import SwitchYearlyCard from "@/components/SwitchYearlyCard";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { PageHeader, Panel } from "@/components/common";
import { PlanCards } from "@/pages/Signup";
import { ExtraSitesCard } from "@/components/Sites";
import ExtraLoginsCard from "@/components/ExtraLogins";
import EnterprisePreviewCard from "@/components/EnterprisePreview";
import { apiGet, apiPost, errorMessage } from "@/lib/api";
import { useMe } from "@/lib/hooks";
import type { CheckoutRequest, CheckoutResponse, OrgInfo, PaymentStatus, Plan, PlanId, BillingInterval } from "@/lib/types";
import { isManagerLike } from "@/lib/types";

const STATUS: Record<string, string> = { incomplete: "Card needed", trialing: "Free trial", active: "Active", past_due: "Payment overdue", canceled: "Canceled" };
const day = (s: string | null) => (s ? new Date(s).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "");

export default function Billing() {
  const { data: me } = useMe();
  const { data: org } = useQuery({ queryKey: ["org"], queryFn: () => apiGet<OrgInfo>("/org/me") });
  const [plan, setPlan] = useState<PlanId | undefined>();
  const pick = plan ?? org?.plan;
  const [interval, setInterval_] = useState<BillingInterval>(new URLSearchParams(window.location.search).get("interval") === "year" ? "year" : "month");
  const qc = useQueryClient();
  const checkout = useMutation({
    mutationFn: ({ p, now }: { p: PlanId; now: boolean }) =>
      apiPost<CheckoutResponse>("/billing/checkout", { plan: p, origin_url: window.location.origin, start_now: now, interval } satisfies CheckoutRequest),
    onSuccess: (r) => window.location.assign(r.checkout_url),
    onError: (e) => toast.error(errorMessage(e, "Couldn't start checkout")),
  });
  const startPaid = useMutation({
    mutationFn: () => apiPost<OrgInfo>("/billing/start-paid"),
    onSuccess: (o) => {
      qc.setQueryData(["org"], o);
      qc.invalidateQueries();
      toast.success(o.status === "active" ? "You're now a paying customer — everything is unlocked" : "Payment is processing");
    },
    onError: (e) => toast.error(errorMessage(e, "Couldn't start your paid plan")),
  });
  const isManager = isManagerLike(me?.role);
  const { data: plans } = useQuery({ queryKey: ["plans"], queryFn: () => apiGet<Plan[]>("/billing/plans"), staleTime: Infinity });
  const trialWithCard = org?.status === "trialing" && org.card_on_file;
  const trialNoCard = org?.status === "trialing" && !org.card_on_file;
  const incomplete = org?.status === "incomplete";
  const freeDay = !!org?.no_card_trial; // adding a card starts the 7-day trial (even after the free day ends)

  return (
    <>
      <PageHeader overline="Billing" title="Your Salvage Pulse AI plan" />
      {org && (
        <Panel testId="billing-status-panel">
          <div className="flex flex-wrap items-center gap-6">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-wider text-slate-500">Status</p>
              <p data-testid="billing-status" className="mt-1 text-xl font-bold text-white">
                {STATUS[org.status]}
                {org.status === "trialing" && ` — ${org.days_left} days left`}
              </p>
            </div>
            <div>
              <p className="font-mono text-[11px] uppercase tracking-wider text-slate-500">Plan</p>
              <p data-testid="billing-plan" className="mt-1 text-xl font-bold capitalize text-white">{plans?.find((p) => p.id === org.plan)?.name ?? org.plan.replace("_", " ")}{org.billing_interval === "year" ? " · yearly" : ""}</p>
            </div>
            <div>
              <p className="font-mono text-[11px] uppercase tracking-wider text-slate-500">Rep logins</p>
              <p className="mt-1 text-xl font-bold text-white">
                {org.reps} / {org.max_reps ?? "unlimited"}
              </p>
            </div>
            <div>
              <p className="font-mono text-[11px] uppercase tracking-wider text-slate-500">Locations</p>
              <p data-testid="billing-locations" className="mt-1 text-xl font-bold text-white">{org.max_sites}</p>
            </div>
          </div>
          {org.plan === "enterprise_platinum" && <ExtraSitesCard org={org} />}
          {org.discount && (
            <p data-testid="billing-discount" className="mt-4 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
              <strong>{org.discount.percent}% off</strong> — ${org.discount.discounted_price.toFixed(2)}/{org.billing_interval === "year" ? "yr" : "mo"} instead of ${org.discount.price.toFixed(2)}
              {org.discount.ends_at ? <> until <strong>{day(org.discount.ends_at)}</strong></> : <> for {org.discount.months} month{org.discount.months === 1 ? "" : "s"} once you subscribe</>}
              . {org.discount.reason ? <>A {org.discount.reason} thank-you from Salvage Pulse.</> : "A thank-you from Salvage Pulse."}
            </p>
          )}
          {org.blocked ? (
            <p data-testid="billing-blocked-message" className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
              This account was closed by Salvage Pulse. Contact support if you think this is a mistake.
            </p>
          ) : incomplete ? (
            <p data-testid="billing-start-trial-message" className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
              Add a card to start your <strong>7-day free trial</strong>. You won't be charged today — your card is charged automatically after 7 days unless you cancel. Days 5–7 have limited premium features.
            </p>
          ) : (
            !org.access &&
            (freeDay ? (
              <p data-testid="billing-free-day-ended-message" className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                Your free day is over. Add a card to start your <strong>7-day free trial</strong> — nothing is charged for 7 days, and everything you set up is still here.
              </p>
            ) : (
              <p data-testid="billing-locked-message" className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                Your {org.status === "trialing" ? "free trial has ended" : "subscription is inactive"}. Choose a plan below to unlock your call data again — nothing has been deleted.
              </p>
            ))
          )}
          {org.status === "trialing" && org.access && (
            <div data-testid="billing-trial-panel" className="mt-4 rounded-lg border border-border bg-surface px-4 py-3 text-sm text-slate-300">
              <p>
                {freeDay
                  ? `Your free day runs until ${new Date(org.trial_ends_at ?? "").toLocaleString()}. AI role-play and call scoring are limited to a few a day until you add a card.`
                  : org.trial_limited
                  ? "Premium features are limited for the rest of your trial: trends, parts insights, trend alerts and the daily email are paused; role-play is 1 call a day."
                  : `Full access until ${day(org.limited_starts_at)}. After that, premium features are limited until the trial ends on ${day(org.trial_ends_at)}.`}
              </p>
              <p className="mt-1 text-slate-400">
                {freeDay
                  ? "Add a card any time to start your 7-day free trial — nothing is charged for 7 days."
                  : org.card_on_file
                  ? `Your card is on file and will be charged automatically on ${day(org.trial_ends_at)}.`
                  : `Add a card before ${day(org.trial_ends_at)} to keep access — you won't be charged until the trial ends.`}
              </p>
              {isManager && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {trialWithCard && (
                    <Button data-testid="billing-start-paid-button" disabled={startPaid.isPending} onClick={() => startPaid.mutate()}>
                      {startPaid.isPending && <Loader2 className="size-4 animate-spin" />} Become a paying customer now
                    </Button>
                  )}
                  {trialNoCard && (
                    <>
                      <Button data-testid="billing-add-card-button" disabled={checkout.isPending} onClick={() => checkout.mutate({ p: pick ?? org.plan, now: false })}>
                        {freeDay ? "Add card — 7 days free" : "Add card (charged after trial)"}
                      </Button>
                      <Button variant="outline" data-testid="billing-pay-now-button" disabled={checkout.isPending} onClick={() => checkout.mutate({ p: pick ?? org.plan, now: true })}>
                        Pay now & unlock everything
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
          {isManager && <SwitchYearlyCard org={org} />}
          <EnterprisePreviewCard org={org} isManager={isManager} />
          <ExtraLoginsCard org={org} plan={plans?.find((p) => p.id === org.plan)} isManager={isManager} />
        </Panel>
      )}
      {!org?.blocked && !trialWithCard && (
        <>
          <h3 className="mb-3 mt-8 text-lg font-bold text-white">{org?.status === "active" ? "Change plan" : "Choose a plan"}</h3>
          <IntervalToggle value={interval} onChange={setInterval_} />
          <PlanCards selected={pick} onPick={setPlan} testPrefix="billing-plan" interval={interval} discount={org?.discount} />
          <PlanCompareTable current={org?.status === "active" || org?.status === "trialing" ? org.plan : undefined} selected={plan} onPick={isManager ? setPlan : undefined} interval={interval} />
          {isManager ? (
            <Button size="lg" className="mt-6" data-testid="billing-checkout-button" disabled={!pick || checkout.isPending} onClick={() => pick && checkout.mutate({ p: pick, now: false })}>
              {checkout.isPending && <Loader2 className="size-4 animate-spin" />} {incomplete || freeDay ? "Add card & start 7-day free trial" : "Continue to secure payment"}
            </Button>
          ) : (
            <p className="mt-6 text-sm text-slate-400">Ask your manager to update billing.</p>
          )}
        </>
      )}
      <p className="mt-3 text-xs text-slate-500">Payments are handled by Stripe. Test mode: use card 4242 4242 4242 4242, any future date, any CVC.</p>
    </>
  );
}

export function PaymentSuccess() {
  const [params] = useSearchParams();
  const sid = params.get("session_id") ?? "";
  const qc = useQueryClient();
  const [tries, setTries] = useState(0);
  const { data } = useQuery({
    queryKey: ["payment", sid, tries],
    queryFn: () => apiGet<PaymentStatus>(`/payments/status/${sid}`),
    enabled: !!sid,
  });
  const paid = data?.payment_status === "paid";
  const { data: org } = useQuery({ queryKey: ["org", "after-payment", paid], queryFn: () => apiGet<OrgInfo>("/org/me"), enabled: paid, retry: false });
  useEffect(() => {
    if (paid) {
      qc.invalidateQueries({ queryKey: ["org"] });
      return;
    }
    if (tries < 15) {
      const t = setTimeout(() => setTries((n) => n + 1), 2000);
      return () => clearTimeout(t);
    }
  }, [paid, tries, qc]);
  return (
    <div className="bg-grid flex min-h-screen items-center justify-center px-4">
      <div className="max-w-md rounded-xl border border-border bg-card p-8 text-center" data-testid="payment-result">
        <img src="/salvage-pulse-logo.jpg" alt="Salvage Pulse" className="mx-auto h-16 w-auto rounded-md" />
        {paid ? (
          <>
            <CheckCircle2 className="mx-auto mt-6 size-10 text-emerald-400" />
            <h1 className="mt-3 text-2xl font-bold text-white" data-testid="payment-result-title">{org?.status === "trialing" ? "Your 7-day free trial has started" : "You're subscribed"}</h1>
            <p className="mt-2 text-sm text-slate-400">
              {org?.status === "trialing"
                ? `Card saved — nothing is charged until ${day(org.trial_ends_at)}. Explore the sample calls, then drop in your own.`
                : "Thanks! Your yard's Salvage Pulse AI account is active."}
            </p>
          </>
        ) : (
          <>
            <Loader2 className="mx-auto mt-6 size-8 animate-spin text-sky-400" />
            <h1 className="mt-3 text-xl font-bold text-white">{tries >= 15 ? "Still confirming your payment…" : "Confirming your payment…"}</h1>
          </>
        )}
        <Link to="/" data-testid="payment-continue-link" className="mt-6 inline-block text-sm font-medium text-sky-300 hover:underline">
          Go to Salvage Pulse AI
        </Link>
      </div>
    </div>
  );
}
