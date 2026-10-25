import { cn } from "@/lib/utils";
import type { BillingInterval } from "@/lib/types";

/** Monthly / Yearly (one month free) switch for plan prices and checkout. */
export default function IntervalToggle({ value, onChange }: { value: BillingInterval; onChange: (v: BillingInterval) => void }) {
  return (
    <div className="mb-4 flex items-center gap-3" data-testid="billing-interval-toggle">
      <div className="flex rounded-full border border-border bg-card p-1 text-sm">
        {(["month", "year"] as const).map((v) => (
          <button
            key={v}
            type="button"
            data-testid={`billing-interval-${v}`}
            onClick={() => onChange(v)}
            className={cn("rounded-full px-4 py-1.5 transition-colors duration-150", value === v ? "bg-amber-500 font-semibold text-primary-foreground" : "text-slate-400 hover:text-white")}
          >
            {v === "month" ? "Monthly" : "Yearly"}
          </button>
        ))}
      </div>
      <span className={cn("rounded-full border px-2.5 py-0.5 font-mono text-[11px] transition-colors duration-150", value === "year" ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300" : "border-border text-slate-500")}>
        Pay yearly · 1 month free
      </span>
    </div>
  );
}
