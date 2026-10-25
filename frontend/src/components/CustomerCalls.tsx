import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShoppingCart, Truck, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { CategoryBadge, OutcomeBadge, Overline, Panel, fmtMoney } from "@/components/common";
import { SaleForm } from "@/components/SaleFields";
import { apiGet, apiPatch, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { CallSummary, CustomerCalls, DeliveryUpdate, SaleUpdate } from "@/lib/types";

/** Call detail: every call from this same customer (matched by phone, else name), newest first. */
export function CustomerCallsPanel({ call }: { call: CallSummary }) {
  const { data } = useQuery({
    queryKey: ["customer-calls", call.id],
    queryFn: () => apiGet<CustomerCalls>(`/calls/${call.id}/customer-calls`),
  });
  if (!data) return null;
  const others = data.calls.length - 1;
  return (
    <Panel className="mb-6" testId="customer-calls-panel">
      <div className="flex flex-wrap items-center gap-2">
        <Users className="size-4 text-sky-300" />
        <Overline>All calls from this customer</Overline>
        <span className="font-mono text-xs text-slate-500" data-testid="customer-calls-count">
          {data.calls.length} call{data.calls.length === 1 ? "" : "s"}{others > 0 ? ` · ${others} other` : ""}
        </span>
        {data.key && (
          <Link to={`/customers/${encodeURIComponent(data.key)}`} data-testid="customer-calls-profile-link" className="ml-auto text-xs text-sky-400 hover:underline">
            Customer profile →
          </Link>
        )}
      </div>
      {others <= 0 ? (
        <p className="mt-3 text-sm text-slate-500">This is the only call from this customer so far.</p>
      ) : (
        <ul className="mt-3 max-h-80 space-y-1.5 overflow-y-auto">
          {data.calls.map((c) => (
            <li key={c.id}>
              <Link
                to={`/calls/${c.id}`}
                data-testid={`customer-call-${c.id}`}
                className={cn(
                  "flex items-center gap-3 rounded-lg border px-3 py-2 transition-colors duration-150",
                  c.id === call.id ? "border-sky-500/40 bg-sky-500/[0.06]" : "border-border bg-surface hover:border-slate-500",
                )}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-white">
                    {new Date(c.created_at).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}
                    {c.id === call.id && <span className="ml-2 font-mono text-[10px] uppercase text-sky-300">this call</span>}
                  </p>
                  <p className="truncate text-xs text-slate-500">
                    {c.rep_name || "Unassigned"}
                    {c.vehicle ? ` · ${c.vehicle}` : ""}
                    {c.part_requested ? ` · ${c.part_requested}` : ""}
                    {c.parts_sold.length ? ` · sold ${c.parts_sold.join(", ")}` : ""}
                  </p>
                </div>
                <CategoryBadge category={c.category} />
                <OutcomeBadge outcome={c.outcome} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** Call detail: mark this call sold with what the parts went for and which part types. */
export function SaleBox({ call }: { call: CallSummary }) {
  const qc = useQueryClient();
  const sold = call.outcome === "won";
  const done = () => {
    qc.invalidateQueries({ queryKey: ["call", call.id] });
    qc.invalidateQueries({ queryKey: ["calls"] });
    qc.invalidateQueries({ queryKey: ["customer-calls"] });
    qc.invalidateQueries({ queryKey: ["report"] });
  };
  const delivery = useMutation({
    mutationFn: (b: DeliveryUpdate) => apiPatch<CallSummary>(`/calls/${call.id}/delivery`, b),
    onSuccess: (_, b) => (toast.success(b.delivery ? "Tagged as a delivery call — not counted as a sale" : "Delivery tag removed"), done()),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const save = useMutation({
    mutationFn: (b: SaleUpdate) => apiPatch<CallSummary>(`/calls/${call.id}/sale`, b),
    onSuccess: (_, b) => (toast.success(b.sold ? "Sale saved" : "Sale cleared"), done()),
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (call.delivery_call)
    return (
      <Panel className="mb-6 border-sky-500/30" testId="call-sale-panel">
        <div className="flex flex-wrap items-center gap-3">
          <Truck className="size-4 text-sky-300" />
          <Overline>Delivery call</Overline>
          <span data-testid="call-delivery-summary" className="text-sm text-slate-300">
            {call.delivery_kind === "confirmation" ? "Delivery confirmation" : "Question about a delivery"} — the parts were sold on a different call, so this isn't counted as a sale.
          </span>
          <Button size="sm" variant="ghost" className="ml-auto" data-testid="call-delivery-undo" disabled={delivery.isPending} onClick={() => delivery.mutate({ delivery: false })}>Not a delivery call</Button>
        </div>
      </Panel>
    );
  return (
    <Panel className="mb-6" testId="call-sale-panel">
      <div className="flex flex-wrap items-center gap-2">
        <ShoppingCart className="size-4 text-emerald-300" />
        <Overline>{sold ? "Sold on this call" : "Did this call sell parts?"}</Overline>
        {sold && (
          <span data-testid="call-sale-summary" className="font-mono text-xs text-emerald-300">
            {call.order_value > 0 ? fmtMoney(call.order_value) : <span className="text-amber-300">price missing — add it below</span>}
            {call.parts_sold.length ? ` · ${call.parts_sold.join(", ")}` : ""}
          </span>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <SaleForm
          key={`${call.order_value}-${call.parts_sold.join("|")}`}
          price={call.order_value || null}
          parts={call.parts_sold}
          saving={save.isPending}
          saveLabel={sold ? "Update sale" : "Mark sold"}
          testPrefix="call-sale"
          onSave={(p, parts) => save.mutate({ sold: true, sold_price: p, parts_sold: parts })}
        />
        {sold && (
          <Button size="sm" variant="ghost" data-testid="call-sale-clear" disabled={save.isPending} onClick={() => save.mutate({ sold: false, sold_price: null, parts_sold: [] })}>
            Not sold
          </Button>
        )}
        <Button size="sm" variant="outline" data-testid="call-delivery-tag" disabled={delivery.isPending} onClick={() => delivery.mutate({ delivery: true })}
          title="Delivery question or confirmation — the parts were sold on a different call; never counted in sales">
          <Truck className="size-3.5" /> {sold ? "Sold on different call" : "Delivery call"}
        </Button>
      </div>
    </Panel>
  );
}
