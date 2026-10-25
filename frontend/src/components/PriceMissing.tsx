import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CircleDollarSign } from "lucide-react";
import { Panel, fmtMoney } from "@/components/common";
import { apiGet } from "@/lib/api";
import type { CallSummary, DrillCalls } from "@/lib/types";

export const priceMissing = (c: Pick<CallSummary, "outcome" | "order_value">) => c.outcome === "won" && !(c.order_value > 0);

/** Small amber badge on any sale that has no amount yet. */
export function PriceMissingBadge({ testId }: { testId: string }) {
  return (
    <span data-testid={testId} title="This sale has no amount — add the price so profit and reports stay accurate" className="inline-flex items-center gap-1 rounded border border-amber-500/50 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-amber-300">
      <CircleDollarSign className="size-3" /> price missing
    </span>
  );
}

/** Performance page: the rep's sales with no amount, each a tap away from the call's sale box. */
export function PriceMissingReminder({ repId }: { repId?: string }) {
  const q = new URLSearchParams({ price_missing: "true", ...(repId ? { rep_id: repId } : {}) }).toString();
  const { data } = useQuery({ queryKey: ["calls", "price-missing", repId ?? "me"], queryFn: () => apiGet<DrillCalls>(`/drill/calls?${q}`) });
  if (!data?.total) return null;
  return (
    <Panel testId="price-missing-reminder" className="mb-6 border-amber-500/40 bg-amber-500/[0.04]">
      <div className="flex flex-wrap items-center gap-2">
        <CircleDollarSign className="size-4 text-amber-300" />
        <p className="font-semibold text-white" data-testid="price-missing-count">
          {data.total} sale{data.total === 1 ? "" : "s"} missing a price
        </p>
        <span className="text-xs text-slate-400">Add what the parts sold for so profit and reports stay accurate.</span>
      </div>
      <ul className="mt-3 flex flex-wrap gap-2">
        {data.calls.slice(0, 12).map((c) => (
          <li key={c.id}>
            <Link to={`/calls/${c.id}`} data-testid={`price-missing-call-${c.id}`} className="block rounded-lg border border-border bg-surface px-3 py-1.5 text-sm transition-colors duration-150 hover:border-amber-500/60">
              <span className="text-white">{c.customer_name}</span>
              <span className="ml-2 font-mono text-[11px] text-slate-500">
                {new Date(c.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                {c.parts_sold.length ? ` · ${c.parts_sold.join(", ")}` : c.part_requested ? ` · ${c.part_requested}` : ""}
              </span>
            </Link>
          </li>
        ))}
        {data.total > 12 && <li className="self-center text-xs text-slate-500">+{data.total - 12} more</li>}
      </ul>
    </Panel>
  );
}

export { fmtMoney };
