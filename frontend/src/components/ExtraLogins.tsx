import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Minus, Plus, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { apiPost, errorMessage } from "@/lib/api";
import type { ExtraLogins, OrgInfo, Plan } from "@/lib/types";

/** Billing: Pro add-on — 2 extra rep logins for $50/month per pack, capped so the bill stays ≤ $400/month. */
export default function ExtraLoginsCard({ org, plan, isManager }: { org: OrgInfo; plan: Plan | undefined; isManager: boolean }) {
  const qc = useQueryClient();
  const [packs, setPacks] = useState(org.extra_rep_packs);
  useEffect(() => setPacks(org.extra_rep_packs), [org.extra_rep_packs]);
  const save = useMutation({
    mutationFn: () => apiPost<OrgInfo>("/billing/extra-logins", { packs } satisfies ExtraLogins),
    onSuccess: (o) => {
      qc.setQueryData(["org"], o);
      qc.invalidateQueries({ queryKey: ["org"] });
      toast.success(`You now have ${o.max_reps} rep logins`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!org.max_extra_packs || !plan) return null;
  const base = plan.max_reps ?? 0;
  const total = plan.price + packs * org.extra_pack_price;
  return (
    <div className="mt-6 rounded-xl border border-border bg-card p-5" data-testid="extra-logins-card">
      <div className="flex items-center gap-2">
        <UserPlus className="size-4 text-amber-300" />
        <p className="font-heading font-bold text-white">Extra rep logins</p>
      </div>
      <p className="mt-1 text-sm text-slate-400">
        {plan.name} includes {base} rep logins. Add 2 more for ${org.extra_pack_price}/month — up to {org.max_extra_packs} packs (${plan.price + org.max_extra_packs * org.extra_pack_price}/month max). Need more? Enterprise is unlimited.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <Button size="icon" variant="outline" data-testid="extra-logins-minus" disabled={!isManager || packs <= 0} onClick={() => setPacks(packs - 1)}>
            <Minus className="size-4" />
          </Button>
          <span className="w-28 text-center font-mono text-sm text-white" data-testid="extra-logins-count">
            {packs} pack{packs === 1 ? "" : "s"} (+{packs * 2})
          </span>
          <Button size="icon" variant="outline" data-testid="extra-logins-plus" disabled={!isManager || packs >= org.max_extra_packs} onClick={() => setPacks(packs + 1)}>
            <Plus className="size-4" />
          </Button>
        </div>
        <p className="font-mono text-sm text-slate-300" data-testid="extra-logins-total">
          {base + packs * 2} logins · ${total.toFixed(0)}/month
        </p>
        {isManager && (
          <Button data-testid="extra-logins-save" disabled={packs === org.extra_rep_packs || save.isPending} onClick={() => save.mutate()}>
            Update logins
          </Button>
        )}
      </div>
      {!org.card_on_file && <p className="mt-3 text-xs text-slate-500">Add a card first — extra logins are added to your subscription.</p>}
    </div>
  );
}
