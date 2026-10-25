import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarCheck, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { apiGet, apiPost, errorMessage } from "@/lib/api";
import type { OrgInfo, Plan } from "@/lib/types";

/** Monthly yards with a card on file: one tap (plus a confirm) to move to yearly billing with a month free. */
export default function SwitchYearlyCard({ org }: { org: OrgInfo }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const plans = useQuery({ queryKey: ["plans"], queryFn: () => apiGet<Plan[]>("/billing/plans"), staleTime: Infinity });
  const sw = useMutation({
    mutationFn: () => apiPost<OrgInfo>("/billing/switch-yearly"),
    onSuccess: (o) => {
      qc.setQueryData(["org"], o);
      qc.invalidateQueries({ queryKey: ["org"] });
      setConfirm(false);
      toast.success("You're on yearly billing — one month free every year");
    },
    onError: (e) => toast.error(errorMessage(e, "Couldn't switch")),
  });
  const plan = plans.data?.find((p) => p.id === org.plan);
  if (!plan || !org.card_on_file || org.billing_interval !== "month") return null;
  const monthly = plan.price + org.extra_rep_packs * org.extra_pack_price;
  const yearly = monthly * 11;
  return (
    <div data-testid="switch-yearly-card" className="mt-6 flex flex-wrap items-center gap-4 rounded-xl border border-emerald-500/40 bg-gradient-to-r from-emerald-500/10 via-card to-card p-5">
      <CalendarCheck className="size-6 shrink-0 text-emerald-300" />
      <div className="min-w-0 flex-1">
        <p className="font-heading font-bold text-white">Switch to yearly — get a month free</p>
        <p className="mt-1 text-sm text-slate-400" data-testid="switch-yearly-detail">
          ${yearly.toLocaleString()}/yr instead of ${(monthly * 12).toLocaleString()} paid monthly — you save ${monthly.toLocaleString()} a year.
          {confirm && " Stripe credits what's left of this month and charges the yearly amount today."}
        </p>
      </div>
      {confirm ? (
        <div className="flex gap-2">
          <Button variant="ghost" data-testid="switch-yearly-cancel" onClick={() => setConfirm(false)}>Not now</Button>
          <Button data-testid="switch-yearly-confirm" disabled={sw.isPending} onClick={() => sw.mutate()}>
            {sw.isPending && <Loader2 className="size-4 animate-spin" />} Confirm · ${yearly.toLocaleString()}/yr
          </Button>
        </div>
      ) : (
        <Button data-testid="switch-yearly-button" onClick={() => setConfirm(true)}>Switch to yearly</Button>
      )}
    </div>
  );
}
