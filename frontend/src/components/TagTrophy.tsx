import { useQuery } from "@tanstack/react-query";
import { Trophy } from "lucide-react";
import { apiGet } from "@/lib/api";
import type { TagChampion } from "@/lib/types";

export const useTagChampion = () => useQuery({ queryKey: ["tagging", "champion"], queryFn: () => apiGet<TagChampion>("/tagging/champion") });

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** Last week's top vehicle tagger (Mon–Sun, yard time). Hidden when nobody tagged. */
export default function TagTrophy({ className = "" }: { className?: string }) {
  const { data } = useTagChampion();
  if (!(data?.winners?.length)) return null;
  const n = data.winners[0].tagged;
  const end = new Date(new Date(data.week_end).getTime() - 86_400_000).toISOString();
  return (
    <div
      data-testid="tag-trophy-banner"
      className={`${className} relative overflow-hidden rounded-xl border border-sky-400/40 bg-gradient-to-r from-sky-500/15 via-card to-card p-5 animate-in fade-in slide-in-from-bottom-1 duration-500`}
    >
      <div className="flex flex-wrap items-center gap-4">
        <div className="grid size-12 place-items-center rounded-full bg-sky-400 text-black shadow-[0_0_24px_rgba(56,189,248,0.35)]">
          <Trophy className="size-6" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[11px] uppercase tracking-wider text-sky-300">Weekly tagging champion · {day(data.week_start)} – {day(end)}</p>
          <p data-testid="tag-trophy-winner" className="font-heading text-xl font-bold text-white">{(data?.winners ?? []).map((w) => w.name).join(" & ")}</p>
          <p className="text-sm text-slate-400" data-testid="tag-trophy-detail">
            Tagged {n} vehicle{n === 1 ? "" : "s"} on calls last week — every tag sharpens vehicle demand and stock alerts
          </p>
        </div>
      </div>
    </div>
  );
}
