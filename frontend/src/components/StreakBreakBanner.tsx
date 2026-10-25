import { useQuery } from "@tanstack/react-query";
import { Zap } from "lucide-react";
import { apiGet } from "@/lib/api";
import { lotQS } from "@/lib/lot";
import type { StreakBreak } from "@/lib/types";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const first = (n: string) => n.split(" ")[0];
const join = (names: string[]) => names.map(first).join(" & ");

/** Whole-team shout-out when someone breaks (or is breaking) the vehicle-sales streak leader's run. */
export default function StreakBreakBanner({ className = "mb-6", lot = "" }: { className?: string; lot?: string }) {
  const { data } = useQuery({ queryKey: ["arrivals", "streak-break", lot], queryFn: () => apiGet<StreakBreak>(`/arrivals/streak-break${lotQS(lot)}`) });
  if (!data?.kind) return null;
  const broken = data.kind === "broken";
  const month = MONTHS[Number(data.month.slice(5, 7)) - 1];
  const leader = first(data.leader_name);
  return (
    <div
      data-testid="streak-break-banner"
      className={`${className} relative flex items-center gap-4 overflow-hidden rounded-xl border border-fuchsia-500/40 bg-gradient-to-r from-fuchsia-500/15 via-sky-500/10 to-card px-5 py-4 animate-in fade-in slide-in-from-top-1 duration-500`}
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-fuchsia-500/25">
        <Zap className="size-5 text-fuchsia-200" />
      </span>
      <div className="min-w-0 flex-1 text-sm">
        <p data-testid="streak-break-title" className="font-heading text-base font-bold text-white">
          {broken ? `${join(data.breakers)} broke ${leader}'s ${data.streak}-month vehicle streak!` : `${join(data.breakers)} ${data.breakers.length > 1 ? "are" : "is"} breaking ${leader}'s ${data.streak}-month vehicle streak`}
        </p>
        <p data-testid="streak-break-detail" className="text-slate-300">
          {broken
            ? `${month}'s vehicle-sales trophy went to ${join(data.breakers)} with ${data.breaker_sales} sale${data.breaker_sales === 1 ? "" : "s"} from arrival lists. New month, new race.`
            : `${data.breaker_sales} vehicle-list sales this month vs ${leader}'s ${data.leader_sales}. If it holds to month end, the run is over.`}
        </p>
      </div>
    </div>
  );
}
