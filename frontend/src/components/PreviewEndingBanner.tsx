import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { apiGet, apiPost, errorMessage } from "@/lib/api";
import { useMe, useOrg } from "@/lib/hooks";
import type { CheckoutRequest, EnterpriseUpgrade, Plan } from "@/lib/types";
import { isManagerLike } from "@/lib/types";

/** Pro managers: Enterprise preview has ≤2 days left → one-tap upgrade. */
export default function PreviewEndingBanner() {
  const { data: me } = useMe();
  const { data: org } = useOrg();
  const qc = useQueryClient();
  const plans = useQuery({ queryKey: ["plans"], queryFn: () => apiGet<Plan[]>("/billing/plans"), staleTime: Infinity });
  const price = plans.data?.find((p) => p.id === "enterprise")?.price;
  const up = useMutation({
    mutationFn: () => apiPost<EnterpriseUpgrade>("/billing/upgrade-enterprise", { plan: "enterprise", origin_url: window.location.origin } satisfies CheckoutRequest),
    onSuccess: (r) => {
      if (r.checkout_url) return window.location.assign(r.checkout_url);
      qc.invalidateQueries();
      toast.success("You're on Enterprise — trends and inventory insights stay unlocked");
    },
    onError: (e) => toast.error(errorMessage(e, "Couldn't upgrade")),
  });
  if (!isManagerLike(me?.role) || !org?.preview_ending) return null;
  const days = org.preview_days_left ?? 1;
  return (
    <div data-testid="preview-ending-banner" className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-sky-500/40 bg-sky-500/15 px-6 py-2 text-sm text-sky-100">
      <Sparkles className="size-4 text-sky-300" />
      <span data-testid="preview-ending-text">
        Your free Enterprise preview ends in <strong>{days} {days === 1 ? "day" : "days"}</strong>
        {org.preview_ends_at && ` (${new Date(org.preview_ends_at).toLocaleDateString()})`}. After that, trends and inventory insights lock again.
      </span>
      <button
        data-testid="preview-ending-upgrade"
        disabled={up.isPending}
        onClick={() => up.mutate()}
        className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-sky-400 px-3 py-1 font-semibold text-black transition-[background-color,transform] duration-150 hover:bg-sky-300 active:scale-95 disabled:opacity-60"
      >
        {up.isPending && <Loader2 className="size-3.5 animate-spin" />} Upgrade to Enterprise{price ? ` · $${price}/mo` : ""}
      </button>
    </div>
  );
}
