import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Lock } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { useMe, useOrg } from "@/lib/hooks";
import { PreviewButton } from "@/components/EnterprisePreview";
import type { PremiumFeature } from "@/lib/types";
import { isManagerLike } from "@/lib/types";

const NAMES: Record<PremiumFeature, string> = {
  monthly_trends: "Monthly trends",
  rep_trends: "Rep trend comparison",
  parts_insights: "Seasonal parts insights",
  trend_alerts: "Keyword trend alerts",
  daily_email: "Daily follow-up email",
  inventory_insights: "Inventory insights",
  roleplay: "The AI role-play trainer",
  leaderboards: "Trophies, streaks & leaderboards",
  vehicle_arrivals: "Vehicle arrivals & the call queue",
};
const PRO_ONLY: PremiumFeature[] = ["roleplay", "daily_email", "leaderboards", "vehicle_arrivals"];

export const usePremiumLocked = (feature: PremiumFeature) => {
  const { data } = useOrg();
  return !!data && (data.locked_features.includes(feature) || data.plan_locked.includes(feature));
};

/** True once the yard's plan is known and the feature isn't locked (use as a query `enabled` flag). */
export const useFeatureOpen = (feature: PremiumFeature, enabled: boolean = true) => {
  const { data } = useOrg(enabled); // enabled=false for platform staff, who have no yard
  return !!data && !data.locked_features.includes(feature) && !data.plan_locked.includes(feature);
};

/** Shows an upgrade card instead of a premium feature during the last days of a free trial. `hidden` renders nothing instead. */
export default function PremiumGate({ feature, children, hidden = false, className = "" }: { feature: PremiumFeature; children: ReactNode; hidden?: boolean; className?: string }) {
  const { data: org, isLoading } = useOrg();
  const { data: me } = useMe();
  if (isLoading) return null;
  const planLock = !!org?.plan_locked.includes(feature);
  const proLock = planLock && PRO_ONLY.includes(feature) && org?.plan === "starter";
  if (!org || (!planLock && !org.locked_features.includes(feature))) return <>{children}</>;
  if (hidden) return null;
  return (
    <div data-testid={`premium-locked-${feature}`} className={`${className} relative overflow-hidden rounded-xl border border-amber-500/30 bg-gradient-to-br from-amber-500/10 via-card to-card p-6`}>
      <div className="flex flex-wrap items-center gap-4">
        <div className="grid size-11 place-items-center rounded-full bg-amber-500/15">
          <Lock className="size-5 text-amber-300" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-heading text-lg font-bold text-white">{proLock ? `${NAMES[feature]} comes with Pro` : planLock ? `${NAMES[feature]} is an Enterprise feature` : `${NAMES[feature]} is paused`}</p>
          <p className="text-sm text-slate-400">
            {proLock
              ? "Role-play coaching, the daily follow-up email, trophies & leaderboards and vehicle arrivals with the morning call queue start at Pro ($249/mo). Your calls and customers stay as they are."
              : planLock
              ? "Trends, seasonal parts and inventory insights (vehicle demand, stock alerts, watchlist) come with the Enterprise plan. Upgrade any time — your call data is already collected."
              : "Premium features are limited for the last days of your free trial. Upgrade to unlock them right away — your data is all still here."}
          </p>
        </div>
        {isManagerLike(me?.role) && planLock && !proLock && org.preview_available && <PreviewButton testId={`premium-preview-${feature}`} />}
        {isManagerLike(me?.role) ? (
          <Link to="/billing" data-testid={`premium-upgrade-${feature}`} className={buttonVariants()}>
            {proLock ? "See Pro" : planLock ? "See Enterprise" : "Upgrade now"}
          </Link>
        ) : (
          <span className="text-xs text-slate-500">Ask your manager to upgrade.</span>
        )}
      </div>
    </div>
  );
}
