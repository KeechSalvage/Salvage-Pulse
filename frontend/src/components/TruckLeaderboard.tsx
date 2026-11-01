import { useQuery } from "@tanstack/react-query";
import { Trophy } from "lucide-react";
import { Overline, Panel } from "@/components/common";
import { apiGet } from "@/lib/api";
import { lotQS } from "@/lib/lot";
import { cn } from "@/lib/utils";
import type { TruckLeaderboard as Board } from "@/lib/types";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const fmtSpeed = (h: number | null) => (h == null ? "—" : h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${Math.round(h)} hrs` : `${Math.round(h / 24)} days`);

/** Reps ranked by sales from vehicle-arrival lists this month (ties: fastest from vehicle logged to sale). */
export default function TruckLeaderboard({ lot = "" }: { lot?: string }) {
  const { data } = useQuery({ queryKey: ["arrivals", "leaderboard", lot], queryFn: () => apiGet<Board>(`/arrivals/leaderboard${lotQS(lot)}`) });
  if (!(data?.leaders?.length)) return null;
  return (
    <Panel testId="truck-leaderboard-panel">
      <div className="flex items-center gap-2">
        <Trophy className="size-4 text-amber-300" />
        <Overline>Vehicle leaderboard · {MONTHS[Number(data.month.slice(5)) - 1]}</Overline>
      </div>
      <p className="mt-1 text-xs text-slate-500">Sales from arrival lists (marked Sold or an order confirmed by a call). Ties go to the fastest follow-up.</p>
      <ol className="mt-4 grid gap-2 md:grid-cols-2">
        {data.leaders.map((l, i) => (
          <li key={l.rep_id} data-testid={`truck-leader-${i}`} className={cn("flex items-center gap-3 rounded-lg border px-3 py-2.5", i === 0 && l.sales > 0 ? "border-amber-500/50 bg-amber-500/10" : "border-border bg-surface")}>
            <span className={cn("grid size-7 place-items-center rounded-full font-mono text-xs font-bold", i === 0 && l.sales > 0 ? "bg-amber-500 text-black" : "bg-slate-800 text-slate-300")}>{i + 1}</span>
            <span className="flex-1 font-medium text-white">{l.rep_name}</span>
            <span className="font-mono text-xs text-slate-400">
              <b className="text-base text-white">{l.sales}</b> sales · avg {fmtSpeed(l.avg_hours_to_sale)} · {l.contacted} worked
            </span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}
