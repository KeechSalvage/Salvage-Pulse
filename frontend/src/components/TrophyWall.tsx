import { useQuery } from "@tanstack/react-query";
import { Flame, Trophy, Truck } from "lucide-react";
import { Overline, Panel, fmtMoney } from "@/components/common";
import { Avatar } from "@/components/AppShell";
import { apiGet } from "@/lib/api";
import { lotQS } from "@/lib/lot";
import { cn } from "@/lib/utils";
import type { TruckChamp, TrophyWall, WinBackLeader } from "@/lib/types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const label = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

function Slot({ title, l, stat, testId }: { title: string; l: WinBackLeader | null; stat: (l: WinBackLeader) => string; testId: string }) {
  return (
    <div data-testid={testId} className="flex items-center gap-2.5">
      <Trophy className={cn("size-4 shrink-0", l ? "text-amber-400" : "text-slate-700")} />
      <div className="min-w-0">
        <p className="font-mono text-[10px] uppercase tracking-wider text-slate-500">{title}</p>
        {l ? (
          <p className="truncate text-sm text-white">
            {l.rep_name} <span className="font-mono text-xs text-emerald-300">{stat(l)}</span>
          </p>
        ) : (
          <p className="text-sm text-slate-600">No winner</p>
        )}
      </div>
    </div>
  );
}

function TruckSlot({ champs, testId }: { champs: TruckChamp[]; testId: string }) {
  return (
    <div data-testid={testId} className="flex items-center gap-2.5">
      <Truck className={cn("size-4 shrink-0", champs.length ? "text-sky-300" : "text-slate-700")} />
      <div className="min-w-0">
        <p className="font-mono text-[10px] uppercase tracking-wider text-slate-500">Vehicle sales</p>
        {champs.length ? (
          <p className="truncate text-sm text-white">
            {champs.map((c) => c.rep_name).join(" & ")} <span className="font-mono text-xs text-sky-300">{champs[0].sales}</span>
          </p>
        ) : (
          <p className="text-sm text-slate-600">No winner</p>
        )}
      </div>
    </div>
  );
}

function StreakChip({ n, kind, testId }: { n: number; kind: "win-back" | "truck"; testId: string }) {
  const truck = kind === "truck";
  return (
    <span
      data-testid={testId}
      title={truck ? "Months in a row as vehicle-sales champion" : "Months in a row with a win-back trophy"}
      className={cn(
        "flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-xs transition-colors duration-200",
        n ? (truck ? "border-sky-500/50 bg-sky-500/10 text-sky-300" : "border-orange-500/50 bg-orange-500/10 text-orange-300") : "border-slate-700 text-slate-500",
      )}
    >
      {truck ? <Truck className="size-3.5" /> : <Flame className="size-3.5" />}
      {n ? `${n} mo` : "—"}
    </span>
  );
}

export default function TrophyWallPanel({ lot = "" }: { lot?: string }) {
  const { data, isError } = useQuery({ queryKey: ["winback-trophies", lot], queryFn: () => apiGet<TrophyWall>(`/analytics/winback/trophies${lotQS(lot)}`) });

  return (
    <Panel testId="trophy-wall-panel">
      <Overline>Trophy wall</Overline>
      <h3 className="mt-1 flex items-center gap-2 text-xl font-bold text-white">
        <Trophy className="size-5 text-amber-400" /> Monthly champions: win-backs & vehicle sales
      </h3>
      <p className="mt-1 text-sm text-slate-400">
        Three trophies each month: most dollars won back and most customers won back (confirmed by a won call), plus the vehicle-sales champion (most sales from vehicle-arrival lists). Streaks count back-to-back months — <Flame className="inline size-3.5 text-orange-300" /> win-back and <Truck className="inline size-3.5 text-sky-300" /> truck.
      </p>
      {isError && <p className="mt-4 text-sm text-slate-500">Trophy wall unavailable.</p>}
      {data && data.months.length === 0 && (
        <p data-testid="trophy-wall-empty" className="mt-4 text-sm text-slate-500">
          No champions yet. Trophies are awarded once a month with confirmed win-backs or vehicle-list sales has ended.
        </p>
      )}
      {data && data.months.length > 0 && (
        <div className="mt-5 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <ol className="space-y-2" data-testid="trophy-wall-reps">
            {data.reps.map((r, i) => (
              <li
                key={r.rep_id}
                data-testid={`trophy-rep-${i}`}
                className={cn("flex items-center gap-3 rounded-lg border bg-surface px-4 py-3", i === 0 ? "border-amber-500/50" : "border-border")}
              >
                <Avatar name={r.rep_name} size={32} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-white">{r.rep_name}</p>
                  <p className="font-mono text-[11px] text-slate-500">
                    best {r.best_streak} mo win-back · {r.best_truck_streak} mo truck
                  </p>
                </div>
                <div className="flex items-center gap-1" title={`${r.trophies} trophies`} data-testid={`trophy-rep-count-${i}`}>
                  {Array.from({ length: Math.min(r.trophies, 6) }, (_, k) => (
                    <Trophy key={k} className="size-4 text-amber-400" />
                  ))}
                  {r.trophies > 6 && <span className="font-mono text-xs text-amber-300">+{r.trophies - 6}</span>}
                  {Array.from({ length: Math.min(r.truck_trophies, 6) }, (_, k) => (
                    <Truck key={`t${k}`} className="size-4 text-sky-300" data-testid={`trophy-rep-truck-${i}-${k}`} />
                  ))}
                  {r.truck_trophies > 6 && <span className="font-mono text-xs text-sky-300">+{r.truck_trophies - 6}</span>}
                </div>
                <StreakChip n={r.current_streak} kind="win-back" testId={`trophy-rep-streak-${i}`} />
                <StreakChip n={r.truck_streak} kind="truck" testId={`trophy-rep-truck-streak-${i}`} />
              </li>
            ))}
          </ol>
          <div className="max-h-[360px] divide-y divide-border overflow-y-auto pr-1" data-testid="trophy-wall-months">
            {data.months.map((w, i) => (
              <div key={w.month} data-testid={`trophy-month-${i}`} className="grid grid-cols-[72px_1fr_1fr_1fr] items-center gap-4 py-3">
                <span className="font-heading text-sm font-bold text-white">{label(w.month)}</span>
                <Slot title="Most won back" l={w.top_dollars} stat={(l) => fmtMoney(l.won_value)} testId={`trophy-month-${i}-dollars`} />
                <Slot title="Most customers" l={w.top_customers} stat={(l) => `${l.customers_won}`} testId={`trophy-month-${i}-customers`} />
                <TruckSlot champs={w.truck} testId={`trophy-month-${i}-truck`} />
              </div>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}
