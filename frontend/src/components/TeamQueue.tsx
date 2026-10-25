import { useQuery } from "@tanstack/react-query";
import { ListChecks } from "lucide-react";
import { Overline, Panel } from "@/components/common";
import { apiGet } from "@/lib/api";
import { lotQS } from "@/lib/lot";
import { cn } from "@/lib/utils";
import type { TeamQueue } from "@/lib/types";

/** Team Dashboard: how much of today's call queue each rep has cleared; flags reps behind by noon. */
export default function TeamQueuePanel({ lot = "" }: { lot?: string }) {
  const { data } = useQuery({ queryKey: ["queue", "team", lot], queryFn: () => apiGet<TeamQueue>(`/queue/team${lotQS(lot)}`), refetchInterval: 120_000 });
  if (!data?.reps.length) return null;
  const behind = data.reps.filter((r) => r.behind).length;
  return (
    <Panel className="mb-6" testId="team-queue-panel">
      <div className="flex flex-wrap items-center gap-3">
        <ListChecks className="size-5 text-amber-300" />
        <div className="mr-auto">
          <Overline>Today's call queues</Overline>
          <p className="text-xs text-slate-500">Vehicle callers, missed callers and role-plays cleared today. "Behind" = past noon and under half done.</p>
        </div>
        {data.after_noon && behind > 0 && (
          <span data-testid="team-queue-behind-count" className="rounded-full border border-red-500/40 bg-red-500/10 px-3 py-1 font-mono text-xs text-red-300">
            {behind} rep{behind === 1 ? "" : "s"} behind
          </span>
        )}
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {data.reps.map((r) => (
          <div key={r.rep_id} data-testid={`team-queue-rep-${r.rep_id}`} className={cn("rounded-lg border p-3", r.behind ? "border-red-500/40 bg-red-500/5" : "border-border bg-surface")}>
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium text-white">{r.rep_name}</span>
              <span className={cn("font-mono text-xs", r.behind ? "text-red-300" : "text-slate-400")}>
                {r.cleared_today} done · {r.remaining} left {r.behind && "· behind"}
              </span>
            </div>
            <div className="mt-2 h-2 rounded-full bg-slate-800">
              <div className={cn("h-full rounded-full transition-[width] duration-500", r.behind ? "bg-red-400/80" : "bg-emerald-500/80")} style={{ width: `${r.pct}%` }} />
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}
