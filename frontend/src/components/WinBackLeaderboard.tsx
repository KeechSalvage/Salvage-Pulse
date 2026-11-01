import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Trophy } from "lucide-react";
import { Overline, Panel, fmtMoney } from "@/components/common";
import { Avatar } from "@/components/AppShell";
import { monthLabel } from "@/components/MonthlyTrends";
import { apiGet } from "@/lib/api";
import { lotQS } from "@/lib/lot";
import { useMe } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import type { WinBackLeaderboard } from "@/lib/types";

const MEDALS = ["text-amber-300", "text-slate-300", "text-orange-400"];

export default function WinBackLeaderboardPanel({ testId = "winback-leaderboard-panel", lot = "" }: { testId?: string; lot?: string }) {
  const { data: me } = useMe();
  const [month, setMonth] = useState<string | null>(null);
  const { data: all } = useQuery({ queryKey: ["winback-leaderboard", "", lot], queryFn: () => apiGet<WinBackLeaderboard>(`/analytics/winback/leaderboard${lotQS(lot)}`) });
  const sel = month ?? all?.months?.[0] ?? "";
  const { data, isError } = useQuery({
    queryKey: ["winback-leaderboard", sel, lot],
    queryFn: () => apiGet<WinBackLeaderboard>(`/analytics/winback/leaderboard${sel ? `?month=${sel}${lotQS(lot, "&")}` : lotQS(lot)}`),
    enabled: !!all,
  });
  const top = (data?.leaders ?? [])[0]?.won_value || 1;

  return (
    <Panel className="xl:col-span-12" testId={testId}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Overline>Win-back leaderboard</Overline>
          <h3 className="mt-1 flex items-center gap-2 text-xl font-bold text-white">
            <Trophy className="size-5 text-amber-400" /> Who's bringing customers back
          </h3>
          <p className="mt-1 text-sm text-slate-400">Only orders confirmed by a won call within 30 days of the rep's follow-up count.</p>
        </div>
        {all && (all.months ?? []).length > 0 && (
          <div className="flex flex-wrap gap-1 rounded-lg bg-surface p-1">
            {[...(all.months ?? []).slice(0, 5), ""].map((m) => (
              <button
                key={m || "all"}
                data-testid={`winback-leaderboard-month-${m || "all"}`}
                onClick={() => setMonth(m)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium transition-colors duration-150",
                  sel === m ? "bg-amber-500 text-primary-foreground" : "text-slate-400 hover:text-white",
                )}
              >
                {m ? monthLabel(m) : "All time"}
              </button>
            ))}
          </div>
        )}
      </div>

      {isError && <p className="mt-4 text-sm text-slate-500">Leaderboard unavailable.</p>}
      {all && (all.months ?? []).length === 0 && (
        <p data-testid="winback-leaderboard-empty" className="mt-4 text-sm text-slate-500">
          No win-back calls marked yet. The first rep to win back a customer takes the top spot.
        </p>
      )}
      {data && (data.leaders ?? []).length > 0 && (
        <ol className="mt-5 space-y-2" data-testid="winback-leaderboard-list">
          {(data.leaders ?? []).map((l, i) => (
            <li
              key={l.rep_id}
              data-testid={`winback-leader-${i}`}
              className={cn(
                "relative flex items-center gap-4 overflow-hidden rounded-lg border border-border bg-surface px-4 py-3",
                l.rep_id === me?.id && "border-amber-500/50",
              )}
            >
              <div className="absolute inset-y-0 left-0 bg-emerald-500/[0.07] transition-[width] duration-500" style={{ width: `${(100 * l.won_value) / top}%` }} />
              <span className={cn("relative w-6 font-mono text-sm", MEDALS[i] ?? "text-slate-500")}>{String(i + 1).padStart(2, "0")}</span>
              <span className="relative">
                <Avatar name={l.rep_name} size={32} />
              </span>
              <span className="relative flex-1 font-medium text-white">
                {l.rep_name}
                {l.rep_id === me?.id && <span className="ml-2 font-mono text-[10px] uppercase text-amber-300">you</span>}
              </span>
              <div className="relative flex gap-6 text-right font-mono text-xs">
                <div>
                  <p data-testid={`winback-leader-value-${i}`} className="text-base text-emerald-300">{fmtMoney(l.won_value)}</p>
                  <p className="text-slate-500">won back</p>
                </div>
                <div>
                  <p data-testid={`winback-leader-customers-${i}`} className="text-base text-slate-200">{l.customers_won}</p>
                  <p className="text-slate-500">customers</p>
                </div>
                <div>
                  <p className="text-base text-slate-200">{l.marks}</p>
                  <p className="text-slate-500">follow-ups</p>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
