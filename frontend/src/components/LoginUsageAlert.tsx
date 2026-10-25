import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { apiPost, errorMessage } from "@/lib/api";
import { useMe, useOrg } from "@/lib/hooks";
import type { ExtraLogins, OrgInfo } from "@/lib/types";

/** Pro managers: warn when the yard is 1 login (or 0) from its rep limit, with a one-tap "add 2 more". */
export default function LoginUsageAlert({ className = "" }: { className?: string }) {
  const { data: me } = useMe();
  const { data: org } = useOrg();
  const qc = useQueryClient();
  const add = useMutation({
    mutationFn: (packs: number) => apiPost<OrgInfo>("/billing/extra-logins", { packs } satisfies ExtraLogins),
    onSuccess: (o) => {
      qc.setQueryData(["org"], o);
      qc.invalidateQueries({ queryKey: ["org"] });
      toast.success(`Added 2 logins — you now have ${o.max_reps} rep logins`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (me?.role !== "manager" || !org || org.plan !== "pro" || org.max_reps == null || org.reps < org.max_reps - 1) return null;
  const left = Math.max(0, org.max_reps - org.reps);
  const atCap = org.extra_rep_packs >= org.max_extra_packs;
  return (
    <div data-testid="login-usage-alert" className={`${className} flex flex-wrap items-center gap-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-5 py-4`}>
      <UserPlus className="size-5 shrink-0 text-amber-300" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-white" data-testid="login-usage-text">
          {left === 0 ? "All rep logins are in use" : "1 rep login left"} — {org.reps} of {org.max_reps} used
        </p>
        <p className="text-sm text-slate-400">
          {atCap
            ? "You're at the Pro maximum. Enterprise has unlimited rep logins."
            : org.card_on_file
              ? `Add 2 more logins for $${org.extra_pack_price}/month, added to your subscription right away.`
              : `Add a card on the Billing page first, then add 2 more logins for $${org.extra_pack_price}/month.`}
        </p>
      </div>
      {atCap ? (
        <Link to="/billing" data-testid="login-usage-enterprise-link" className={buttonVariants({ variant: "outline" })}>See Enterprise</Link>
      ) : org.card_on_file ? (
        <Button data-testid="login-usage-add-button" disabled={add.isPending} onClick={() => add.mutate(org.extra_rep_packs + 1)}>
          {add.isPending && <Loader2 className="size-4 animate-spin" />} Add 2 more · ${org.extra_pack_price}/mo
        </Button>
      ) : (
        <Link to="/billing" data-testid="login-usage-billing-link" className={buttonVariants()}>Add card</Link>
      )}
    </div>
  );
}
