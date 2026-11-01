import { useQuery } from "@tanstack/react-query";
import { useFeatureOpen } from "@/components/PremiumGate";
import { Truck } from "lucide-react";
import { apiGet } from "@/lib/api";
import type { TruckWinner } from "@/lib/types";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const useTruckWinner = () => {
  const open = useFeatureOpen("leaderboards");
  return useQuery({ queryKey: ["arrivals", "winner"], queryFn: () => apiGet<TruckWinner>("/arrivals/winner"), enabled: open });
};

/** Last month's vehicle-sales champion (most sales from vehicle-arrival lists). Hidden when nobody sold. */
export default function TruckTrophy({ className = "" }: { className?: string }) {
  const { data } = useTruckWinner();
  if (!(data?.winners?.length)) return null;
  const n = data.winners[0].sales;
  return (
    <div
      data-testid="truck-trophy-banner"
      className={`${className} relative overflow-hidden rounded-xl border border-amber-500/40 bg-gradient-to-r from-amber-500/15 via-card to-card p-5 animate-in fade-in slide-in-from-bottom-1 duration-500`}
    >
      <div className="flex flex-wrap items-center gap-4">
        <div className="grid size-12 place-items-center rounded-full bg-amber-500 text-black shadow-[0_0_24px_rgba(245,158,11,0.35)]">
          <Truck className="size-6" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[11px] uppercase tracking-wider text-amber-300">Vehicle-sales champion · {MONTHS[Number(data.month.slice(5)) - 1]}</p>
          <p data-testid="truck-trophy-winner" className="font-heading text-xl font-bold text-white">
            {(data?.winners ?? []).map((w) => w.rep_name).join(" & ")}
          </p>
          <p className="text-sm text-slate-400" data-testid="truck-trophy-detail">
            {n} sale{n === 1 ? "" : "s"} from vehicle-arrival lists
            {data.winners.length === 1 && data.winners[0].avg_hours_to_sale != null && ` · avg ${Math.round(data.winners[0].avg_hours_to_sale)} hrs from vehicle logged to sale`}
          </p>
        </div>
      </div>
    </div>
  );
}
