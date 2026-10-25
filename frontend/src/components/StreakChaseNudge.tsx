import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Truck } from "lucide-react";
import { apiGet } from "@/lib/api";
import type { StreakChase } from "@/lib/types";

/** Rep dashboard: "one vehicle sale behind the streak leader" nudge. */
export default function StreakChaseNudge() {
  const { data } = useQuery({ queryKey: ["arrivals", "streak-chase"], queryFn: () => apiGet<StreakChase>("/arrivals/streak-chase") });
  if (!data?.show) return null;
  const first = data.leader_name.split(" ")[0];
  return (
    <Link
      to="/vehicles"
      data-testid="streak-chase-nudge"
      className="group mb-6 flex items-center gap-4 rounded-xl border border-sky-500/40 bg-gradient-to-r from-sky-500/15 via-card to-card px-5 py-4 transition-[border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-sky-400/70"
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-sky-500/20">
        <Truck className="size-5 text-sky-300" />
      </span>
      <span className="min-w-0 flex-1 text-sm">
        <span className="block font-heading text-base font-bold text-white" data-testid="streak-chase-title">
          One vehicle sale behind {first}
        </span>
        <span className="text-slate-300" data-testid="streak-chase-detail">
          {first} is on a {data.leader_streak}-month vehicle-sales streak with {data.leader_sales} this month — you have {data.my_sales}. One more sale ties it; two breaks it.
        </span>
      </span>
      <span className="flex items-center gap-1 whitespace-nowrap text-sm font-medium text-sky-300">
        Work your arrival list <ArrowRight className="size-4 transition-transform duration-150 group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}
