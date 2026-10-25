import { useQuery } from "@tanstack/react-query";
import { Award, Crown, ListChecks, Tag, Trophy, Truck } from "lucide-react";
import { apiGet } from "@/lib/api";
import { lotQS } from "@/lib/lot";
import { cn } from "@/lib/utils";
import type { ChampionCase, ChampionCategory, TeamPlayerBoard } from "@/lib/types";
import { HeartHandshake, MapPin } from "lucide-react";

const CAT: Record<ChampionCategory, { label: string; icon: typeof Trophy; cls: string }> = {
  callback_lists: { label: "Callback lists", icon: ListChecks, cls: "border-sky-500/40 text-sky-300" },
  vehicle_sales: { label: "Vehicle sales", icon: Trophy, cls: "border-amber-500/40 text-amber-300" },
  winback_dollars: { label: "Win-back $", icon: Crown, cls: "border-emerald-500/40 text-emerald-300" },
  winback_customers: { label: "Win-back customers", icon: Award, cls: "border-emerald-500/40 text-emerald-300" },
  tagging: { label: "Top tagger", icon: Tag, cls: "border-violet-500/40 text-violet-300" },
  delivery_score: { label: "Delivery checklist", icon: Truck, cls: "border-sky-500/40 text-sky-300" },
  team_player: { label: "Team Player champ", icon: HeartHandshake, cls: "border-rose-400/50 text-rose-300" },
  top_location: { label: "Top Location", icon: MapPin, cls: "border-sky-400/50 text-sky-300" },
};

export const useTeamPlayers = (lot = "") =>
  useQuery({ queryKey: ["leaderboards", "team-player", lot], queryFn: () => apiGet<TeamPlayerBoard>(`/leaderboards/team-player${lotQS(lot)}`), staleTime: 10 * 60_000 });

/** Trophy case; lot → that lot's own champions (only its reps compete). */
export const useChampions = (lot = "") =>
  useQuery({ queryKey: ["leaderboards", "champions", lot], queryFn: () => apiGet<ChampionCase>(`/leaderboards/champions${lotQS(lot)}`), staleTime: 10 * 60_000 });

/** A rep's trophy count per category (from the Leaderboards trophy case). Renders nothing with no trophies. */
export default function ChampionBadges({ repId, className, testId = "champion-badges" }: { repId?: string; className?: string; testId?: string }) {
  const { data } = useChampions();
  const tp = useTeamPlayers();
  if (!repId || !data) return null;
  const counts = new Map<ChampionCategory, number>();
  for (const c of data.champions) if (c.rep_ids.includes(repId)) counts.set(c.category, (counts.get(c.category) ?? 0) + 1);
  const team = tp.data?.reps.find((r) => r.rep_id === repId)?.all_time ?? 0;
  if (!counts.size && !team) return null;
  const teamBadge = team > 0 && (
    <span data-testid={`${testId}-team-player`} title={`${team} callback${team === 1 ? "" : "s"} handled while covering for a teammate`}
      className="inline-flex items-center gap-1 rounded-full border border-rose-400/50 px-2 py-0.5 text-[11px] text-rose-300">
      <HeartHandshake className="size-3" /> Team player ×{team}
    </span>
  );
  if (!counts.size) return <div className={cn("flex flex-wrap items-center gap-1.5", className)} data-testid={testId}>{teamBadge}</div>;
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)} data-testid={testId}>
      <span data-testid={`${testId}-total`} className="inline-flex items-center gap-1 rounded-full border border-amber-400/60 bg-amber-500/10 px-2 py-0.5 font-mono text-[11px] text-amber-200">
        <Trophy className="size-3" /> {total}
      </span>
      {[...counts.entries()].map(([k, n]) => {
        const m = CAT[k];
        const Icon = m.icon;
        return (
          <span key={k} data-testid={`${testId}-${k}`} title={`${n}× ${m.label} champion`} className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]", m.cls)}>
            <Icon className="size-3" /> {m.label} ×{n}
          </span>
        );
      })}
      {teamBadge}
    </div>
  );
}
