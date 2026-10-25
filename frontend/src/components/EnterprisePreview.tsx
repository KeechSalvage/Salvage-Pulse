import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { apiPost, errorMessage } from "@/lib/api";
import type { OrgInfo } from "@/lib/types";

/** One-tap start of the free 7-day Enterprise preview (Pro yards, once). */
export function PreviewButton({ testId = "enterprise-preview-button", size = "default" }: { testId?: string; size?: "default" | "lg" }) {
  const qc = useQueryClient();
  const start = useMutation({
    mutationFn: () => apiPost<OrgInfo>("/billing/enterprise-preview"),
    onSuccess: (o) => {
      qc.setQueryData(["org"], o);
      qc.invalidateQueries();
      toast.success(`Enterprise preview is on — trends and inventory insights are unlocked for ${o.preview_days_left} days`);
    },
    onError: (e) => toast.error(errorMessage(e, "Couldn't start the preview")),
  });
  return (
    <Button data-testid={testId} size={size} disabled={start.isPending} onClick={() => start.mutate()}>
      {start.isPending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} Try Enterprise free for 7 days
    </Button>
  );
}

/** Billing: preview offer (Pro, unused) or countdown while it runs. */
export default function EnterprisePreviewCard({ org, isManager }: { org: OrgInfo; isManager: boolean }) {
  if (org.preview_ends_at) {
    return (
      <div data-testid="enterprise-preview-active" className="mt-6 rounded-xl border border-sky-500/40 bg-sky-500/10 p-5">
        <p className="font-heading font-bold text-white">
          Enterprise preview · {org.preview_days_left} day{org.preview_days_left === 1 ? "" : "s"} left
        </p>
        <p className="mt-1 text-sm text-slate-300">
          Monthly trends, seasonal parts and inventory insights are unlocked until {new Date(org.preview_ends_at).toLocaleDateString()}. Nothing is charged — your plan stays Pro unless you upgrade.
        </p>
      </div>
    );
  }
  if (!org.preview_available) return null;
  return (
    <div data-testid="enterprise-preview-offer" className="mt-6 flex flex-wrap items-center gap-4 rounded-xl border border-sky-500/30 bg-gradient-to-r from-sky-500/10 via-card to-card p-5">
      <div className="min-w-0 flex-1">
        <p className="font-heading font-bold text-white">Try Enterprise insights free for 7 days</p>
        <p className="mt-1 text-sm text-slate-400">Unlock monthly trends, seasonal parts, stock alerts, vehicle demand and the watchlist on your own calls. No charge, one time per yard — it switches back on its own.</p>
      </div>
      {isManager ? <PreviewButton /> : <span className="text-xs text-slate-500">Ask your manager to start it.</span>}
    </div>
  );
}
