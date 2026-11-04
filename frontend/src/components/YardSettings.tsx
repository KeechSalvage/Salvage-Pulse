import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DollarSign, Store } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SitesPanel } from "@/components/Sites";
import { apiGet, apiPut, errorMessage } from "@/lib/api";
import type { BusinessSettings } from "@/lib/types";

export function OrderValuePanel() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["business-settings"], queryFn: () => apiGet<BusinessSettings>("/settings/business") });
  const [val, setVal] = useState<string | null>(null);
  const cur = val ?? (data?.avg_order_value != null ? String(data.avg_order_value) : "");
  const save = useMutation({
    mutationFn: (v: number | null) => apiPut<BusinessSettings>("/settings/business", { avg_order_value: v } satisfies BusinessSettings),
    onSuccess: (r) => {
      toast.success(r.avg_order_value ? `Average order value set to $${r.avg_order_value}` : "Reset to default ($350)");
      setVal(null);
      qc.invalidateQueries({ queryKey: ["business-settings"] });
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["customer"] });
    },
    onError: (e) => toast.error(errorMessage(e, "Enter a positive dollar amount")),
  });
  const num = Number(cur);
  return (
    <div data-testid="order-value-panel" className="rounded-xl border border-border bg-card p-6">
      <div className="flex items-center gap-2">
        <DollarSign className="size-4 text-amber-400" />
        <h3 className="text-xl font-bold text-white">Average order value</h3>
      </div>
      <p className="mt-1 max-w-2xl text-sm text-slate-400">
        Used to estimate account value for orders without a scored transcript. Once 3+ sales have been AI-scored, the real average from those calls takes over.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">$</span>
          <Input
            data-testid="order-value-input"
            type="number"
            min={1}
            value={cur}
            onChange={(e) => setVal(e.target.value)}
            placeholder="350"
            className="h-10 w-40 bg-surface pl-7"
          />
        </div>
        <Button data-testid="order-value-save" variant="outline" disabled={save.isPending || !(num > 0)} onClick={() => save.mutate(num)}>
          Save
        </Button>
        {data?.avg_order_value != null && (
          <Button data-testid="order-value-reset" variant="ghost" disabled={save.isPending} onClick={() => save.mutate(null)}>
            Reset to default
          </Button>
        )}
      </div>
    </div>
  );
}

export function YardNamePanel() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["business-settings"], queryFn: () => apiGet<BusinessSettings>("/settings/business") });
  const [val, setVal] = useState<string | null>(null);
  const cur = val ?? data?.yard_name ?? "";
  const save = useMutation({
    mutationFn: (v: string | null) => apiPut<BusinessSettings>("/settings/business", { yard_name: v } satisfies BusinessSettings),
    onSuccess: (r) => {
      toast.success(r.yard_name ? `Yard name set to ${r.yard_name}` : "Yard name cleared");
      setVal(null);
      qc.invalidateQueries({ queryKey: ["business-settings"] });
      qc.invalidateQueries({ queryKey: ["customers"] });
    },
    onError: (e) => toast.error(errorMessage(e, "Couldn't save the yard name")),
  });
  return (
    <div data-testid="yard-name-panel" className="rounded-xl border border-border bg-card p-6">
      <div className="flex items-center gap-2">
        <Store className="size-4 text-amber-400" />
        <h3 className="text-xl font-bold text-white">Yard name</h3>
      </div>
      <p className="mt-1 max-w-2xl text-sm text-slate-400">
        Used in suggested win-back opening lines, e.g. &ldquo;Hi John, it's Rich from {cur.trim() || "Salvage Pulse Pro"}.&rdquo;
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Input
          data-testid="yard-name-input"
          value={cur}
          maxLength={80}
          onChange={(e) => setVal(e.target.value)}
          placeholder="Salvage Pulse Pro"
          className="h-10 w-72 bg-surface"
        />
        <Button data-testid="yard-name-save" variant="outline" disabled={save.isPending || !cur.trim() || cur.trim() === data?.yard_name} onClick={() => save.mutate(cur.trim())}>
          Save
        </Button>
        {data?.yard_name && (
          <Button data-testid="yard-name-clear" variant="ghost" disabled={save.isPending} onClick={() => save.mutate(null)}>
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}

/** Settings → Yard & locations: yard defaults plus per-location rep locks. */
export default function YardSettings() {
  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h2 className="font-heading text-2xl font-bold text-white">Yard &amp; locations</h2>
        <p className="mt-1 text-sm text-slate-400">
          Set the yard defaults and lock each rep to the location they work at. Location assignments keep calls, reports, and leaderboards separated.
        </p>
      </div>
      <YardNamePanel />
      <OrderValuePanel />
      <SitesPanel />
    </div>
  );
}
