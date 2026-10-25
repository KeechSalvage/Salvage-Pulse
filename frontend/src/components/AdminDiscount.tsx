import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgePercent, Copy, Link2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiDelete, apiGet, apiPost, apiPut, errorMessage } from "@/lib/api";
import { Overline, Panel } from "@/components/common";
import { cn } from "@/lib/utils";
import type { AdminDiscount, AdminOrg, AdminOrgDiscount, DiscountSummary } from "@/lib/types";

const REASONS = ["loyalty", "referral", "win-back", "launch partner", "multi-yard"];
const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (s: string) => new Date(s).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/** Platform console: give a yard N% off their Stripe subscription for a set number of months (or remove it). */
export default function DiscountButton({ org, index }: { org: AdminOrg; index: number }) {
  const qc = useQueryClient();
  const d = org.discount;
  const [open, setOpen] = useState(false);
  const blank = () => ({ percent: String(d?.percent ?? 20), months: String(d?.months ?? 3), reason: d?.reason ?? "" });
  const [f, setF] = useState(blank);
  const [link, setLink] = useState("");
  const body = (): AdminDiscount => ({ percent: Number(f.percent), months: Number(f.months), reason: f.reason.trim() });
  const done = (r: AdminOrgDiscount) => (toast.success(`${org.name}: ${r.message}`), qc.invalidateQueries({ queryKey: ["admin"] }), setOpen(false));
  const save = useMutation({
    mutationFn: () => apiPut<AdminOrgDiscount>(`/admin/orgs/${org.id}/discount`, body()),
    onSuccess: done,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const withLink = useMutation({
    mutationFn: () => apiPost<AdminOrgDiscount>(`/admin/orgs/${org.id}/discount-link`, body()),
    onSuccess: (r) => {
      setLink(r.payment_link);
      navigator.clipboard?.writeText(r.payment_link).catch(() => {});
      toast.success(`${org.name}: discount set — payment link copied`);
      qc.invalidateQueries({ queryKey: ["admin"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({ mutationFn: () => apiDelete<AdminOrgDiscount>(`/admin/orgs/${org.id}/discount`), onSuccess: done, onError: (e) => toast.error(errorMessage(e)) });
  const pct = Number(f.percent), months = Number(f.months);
  const valid = Number.isInteger(pct) && pct >= 1 && pct <= 100 && Number.isInteger(months) && months >= 1 && months <= 36;
  const price = d?.price;
  return (
    <>
      <button
        type="button"
        data-testid={`admin-org-discount-${index}`}
        onClick={() => (setF(blank()), setLink(""), setOpen(true))}
        className={d ? "rounded-full bg-emerald-500/15 px-2 py-0.5 font-mono text-[11px] text-emerald-300 transition-colors duration-150 hover:bg-emerald-500/25" : "text-xs text-slate-500 transition-colors duration-150 hover:text-white"}
        title={d ? `${d.reason ? `${d.reason} · ` : ""}${d.ends_at ? `Ends ${day(d.ends_at)}` : "Applies at their checkout"}` : "Offer a discount"}
      >
        {d ? `${d.percent}% · ${d.ends_at ? `to ${day(d.ends_at)}` : "at checkout"}` : "+ Discount"}
      </button>
      {d?.reason && <p data-testid={`admin-org-discount-reason-${index}`} className="mt-0.5 text-[11px] text-slate-500">{d.reason}</p>}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid={`admin-discount-dialog-${index}`}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><BadgePercent className="size-5 text-emerald-400" /> Discount for {org.name}</DialogTitle>
            <DialogDescription>
              {org.card_on_file
                ? "Goes straight onto their Stripe subscription. Full price comes back on its own when the months run out."
                : "They have no subscription yet, so it's applied when they check out. Full price comes back on its own when the months run out."}
              {d && " Saving replaces the current discount."}
            </DialogDescription>
          </DialogHeader>
          <form className="grid grid-cols-2 gap-4" onSubmit={(e) => (e.preventDefault(), valid && save.mutate())}>
            <div className="space-y-1.5">
              <Label htmlFor={`disc-pct-${index}`}>Percent off</Label>
              <Input id={`disc-pct-${index}`} data-testid="admin-discount-percent" type="number" min={1} max={100} value={f.percent} onChange={(e) => setF({ ...f, percent: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`disc-mo-${index}`}>For how many months</Label>
              <Input id={`disc-mo-${index}`} data-testid="admin-discount-months" type="number" min={1} max={36} value={f.months} onChange={(e) => setF({ ...f, months: e.target.value })} />
            </div>
            <p data-testid="admin-discount-preview" className="col-span-2 text-sm text-slate-300">
              {valid ? `${pct}% off for ${months} month${months === 1 ? "" : "s"}` : "Enter 1–100% and 1–36 months"}
              {valid && price ? ` — $${(price * (100 - pct) / 100).toFixed(2)} instead of $${price.toFixed(2)}` : ""}
            </p>
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor={`disc-why-${index}`}>Reason (shown to the yard too)</Label>
              <Input id={`disc-why-${index}`} data-testid="admin-discount-reason" value={f.reason} maxLength={60} placeholder="e.g. loyalty" onChange={(e) => setF({ ...f, reason: e.target.value })} />
              <div className="flex flex-wrap gap-1.5">
                {REASONS.map((x) => (
                  <button key={x} type="button" data-testid={`admin-discount-reason-chip-${x.replace(" ", "-")}`} onClick={() => setF({ ...f, reason: x })}
                    className={cn("rounded-full border px-2.5 py-0.5 text-[11px] transition-colors duration-150", f.reason === x ? "border-emerald-500 bg-emerald-500/15 text-emerald-200" : "border-border text-slate-400 hover:text-white")}>
                    {x}
                  </button>
                ))}
              </div>
            </div>
            {d && <p className="col-span-2 font-mono text-[11px] text-slate-500">Current: {d.percent}% for {d.months} mo{d.reason ? ` · ${d.reason}` : ""} · set by {d.set_by}{d.ends_at ? ` · ends ${day(d.ends_at)}` : " · waiting for checkout"}</p>}
            {link && (
              <div className="col-span-2 flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
                <code data-testid="admin-discount-link" className="flex-1 truncate font-mono text-xs">{link}</code>
                <button type="button" aria-label="Copy link" data-testid="admin-discount-link-copy" onClick={() => navigator.clipboard.writeText(link).then(() => toast.success("Copied"))}><Copy className="size-4" /></button>
              </div>
            )}
            <DialogFooter className="col-span-2">
              {d && (
                <Button type="button" variant="ghost" className="mr-auto text-red-300 hover:text-red-200" data-testid="admin-discount-remove" disabled={remove.isPending} onClick={() => remove.mutate()}>
                  Remove discount
                </Button>
              )}
              {!org.card_on_file && (
                <Button type="button" variant="outline" data-testid="admin-discount-with-link" disabled={!valid || withLink.isPending} onClick={() => withLink.mutate()}>
                  {withLink.isPending ? <Loader2 className="size-4 animate-spin" /> : <Link2 className="size-4" />} Discount + payment link
                </Button>
              )}
              <Button type="submit" data-testid="admin-discount-save" disabled={!valid || save.isPending}>
                {save.isPending && <Loader2 className="size-4 animate-spin" />} {d ? "Replace discount" : "Give discount"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Platform console: monthly revenue given up to discounts (last 6 months + the next 3 from current discounts). */
export function DiscountRevenuePanel() {
  const { data } = useQuery({ queryKey: ["admin", "discounts"], queryFn: () => apiGet<DiscountSummary>("/admin/discounts/summary") });
  if (!data) return null;
  const max = Math.max(1, ...data.months.map((m) => m.cost));
  const label = (m: string) => new Date(`${m}-15`).toLocaleDateString(undefined, { month: "short", year: "2-digit" });
  return (
    <Panel testId="discount-revenue-panel">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Overline>Discounts</Overline>
          <h3 className="mt-1 text-xl font-bold text-white">What discounts cost each month</h3>
          <p className="text-sm text-slate-400">Monthly-equivalent revenue given up across all yards. Faded bars are the next 3 months if current discounts run their course.</p>
        </div>
        <p className="text-right"><span data-testid="discount-this-month" className="font-mono text-2xl font-bold text-emerald-300">{money(data.this_month)}</span><span className="block text-[11px] text-slate-500">this month</span></p>
      </div>
      <div className="mt-5 flex h-36 items-end gap-2" data-testid="discount-month-bars">
        {data.months.map((m) => (
          <div key={m.month} className="flex h-full flex-1 flex-col items-center justify-end gap-1" title={`${label(m.month)}: ${money(m.cost)} · ${m.yards} yard${m.yards === 1 ? "" : "s"}${m.projected ? " (projected)" : ""}`}>
            <span className="font-mono text-[10px] text-slate-400">{m.cost ? money(m.cost) : ""}</span>
            <div className="flex w-full flex-1 items-end">
              <div data-testid={`discount-bar-${m.month}`} className={cn("w-full rounded-t transition-[height] duration-300", m.projected ? "bg-emerald-500/25" : "bg-emerald-500/70")} style={{ height: `${Math.max(2, (m.cost / max) * 100)}%` }} />
            </div>
            <span className="font-mono text-[10px] text-slate-500">{label(m.month)}</span>
          </div>
        ))}
      </div>
      {data.yards.length > 0 ? (
        <ul className="mt-5 divide-y divide-border">
          {data.yards.map((y) => (
            <li key={y.org_id} data-testid={`discount-yard-${y.org_id}`} className="flex flex-wrap items-center gap-3 py-2 text-sm">
              <span className="text-white">{y.org_name}</span>
              <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 font-mono text-[11px] text-emerald-300">{y.percent}%</span>
              {y.reason && <span className="text-xs text-slate-400">{y.reason}</span>}
              <span className="text-xs text-slate-500">{y.applied ? (y.ends_at ? `ends ${day(y.ends_at)}` : "on their bill") : "waiting for checkout"}</span>
              <span className="ml-auto font-mono text-sm text-slate-200">−{money(y.monthly_cost)}/mo</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-5 text-sm text-slate-500">No yards have a discount right now.</p>
      )}
    </Panel>
  );
}
