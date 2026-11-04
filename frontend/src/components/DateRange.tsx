import { useState } from "react";
import { CalendarDays } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

export const DATE_PRESETS: { id: string; label: string; range: () => [string, string] }[] = [
  { id: "all", label: "All time", range: () => ["", ""] },
  { id: "this-month", label: "This month", range: () => { const n = new Date(); return [iso(new Date(n.getFullYear(), n.getMonth(), 1)), iso(n)]; } },
  { id: "last-month", label: "Last month", range: () => { const n = new Date(); return [iso(new Date(n.getFullYear(), n.getMonth() - 1, 1)), iso(new Date(n.getFullYear(), n.getMonth(), 0))]; } },
  { id: "30d", label: "Last 30 days", range: () => [iso(daysAgo(29)), iso(new Date())] },
  { id: "90d", label: "Last 90 days", range: () => [iso(daysAgo(89)), iso(new Date())] },
  { id: "ytd", label: "This year", range: () => [iso(new Date(new Date().getFullYear(), 0, 1)), iso(new Date())] },
];

/** Reusable date range pills for search and list screens. */
export function DateRangeFilter({
  from,
  to,
  onChange,
  testId = "date-range",
}: {
  from: string;
  to: string;
  onChange: (range: [string, string]) => void;
  testId?: string;
}) {
  const [custom, setCustom] = useState(false);
  const active = DATE_PRESETS.find((p) => {
    const [f, t] = p.range();
    return f === from && t === to;
  })?.id;

  return (
    <div data-testid={testId} className="flex flex-wrap items-center gap-2">
      <span className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-slate-500">
        <CalendarDays className="size-3.5" /> Dates
      </span>
      {DATE_PRESETS.map((p) => (
        <button
          key={p.id}
          type="button"
          data-testid={`${testId}-preset-${p.id}`}
          onClick={() => {
            setCustom(false);
            onChange(p.range());
          }}
          className={cn(
            "rounded-full border px-3 py-1 text-xs transition-colors duration-150",
            active === p.id && !custom ? "border-sky-500 bg-sky-500/15 text-white" : "border-border text-slate-400 hover:text-white",
          )}
        >
          {p.label}
        </button>
      ))}
      <button
        type="button"
        data-testid={`${testId}-preset-custom`}
        onClick={() => setCustom(true)}
        className={cn(
          "rounded-full border px-3 py-1 text-xs transition-colors duration-150",
          (custom || (!active && (from || to))) ? "border-sky-500 bg-sky-500/15 text-white" : "border-border text-slate-400 hover:text-white",
        )}
      >
        Custom
      </button>
      {(custom || (!active && (from || to))) && (
        <span className="flex items-center gap-2">
          <Input
            type="date"
            data-testid={`${testId}-from`}
            value={from}
            onChange={(e) => onChange([e.target.value, to])}
            className="h-8 w-40"
          />
          <span className="text-slate-500">to</span>
          <Input
            type="date"
            data-testid={`${testId}-to`}
            value={to}
            onChange={(e) => onChange([from, e.target.value])}
            className="h-8 w-40"
          />
        </span>
      )}
      <span className="ml-auto font-mono text-xs text-slate-500" data-testid={`${testId}-label`}>
        {from || to ? `${from || "…"} → ${to || "…"}` : "All time"}
      </span>
    </div>
  );
}
