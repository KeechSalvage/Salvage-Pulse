import { ArrowDownWideNarrow } from "lucide-react";
import { cn } from "@/lib/utils";
import type { VehicleMake, VehicleModelOption, VehicleRank } from "@/lib/types";

export const RANKS: { id: VehicleRank; label: string; hint: string }[] = [
  { id: "calls", label: "Most asked", hint: "all-time calls, then orders (current ranking)" },
  { id: "recent", label: "Last 30 days", hint: "what callers want right now" },
  { id: "lost", label: "Didn't buy", hint: "where you're losing sales" },
];

/** The rank metric shown next to a picker option, e.g. "12 calls" / "4 in 30d" / "3 didn't buy". */
export const rankStat = (o: Pick<VehicleMake | VehicleModelOption, "calls" | "calls_30d" | "lost">, rank: VehicleRank) =>
  rank === "recent" ? (o.calls_30d ? `${o.calls_30d} in 30d` : "") : rank === "lost" ? (o.lost ? `${o.lost} didn't buy` : "") : o.calls ? `${o.calls} calls` : "";

/** One ranking switch for every vehicle list on the Vehicles page. */
export default function VehicleRankToggle({ value, onChange }: { value: VehicleRank; onChange: (r: VehicleRank) => void }) {
  return (
    <div className="mb-6 flex flex-wrap items-center gap-3" data-testid="vehicle-rank-toggle">
      <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-slate-500">
        <ArrowDownWideNarrow className="size-4 text-amber-300" /> Rank vehicles by
      </span>
      <div className="flex rounded-lg border border-border bg-card/60 p-0.5 text-sm backdrop-blur">
        {RANKS.map((r) => (
          <button
            key={r.id}
            type="button"
            title={r.hint}
            data-testid={`vehicle-rank-${r.id}`}
            onClick={() => onChange(r.id)}
            className={cn("rounded-md px-3 py-1 transition-colors duration-150", value === r.id ? "bg-amber-500 text-black" : "text-slate-400 hover:text-white")}
          >
            {r.label}
          </button>
        ))}
      </div>
      <span className="text-xs text-slate-500">{RANKS.find((r) => r.id === value)?.hint}</span>
    </div>
  );
}
