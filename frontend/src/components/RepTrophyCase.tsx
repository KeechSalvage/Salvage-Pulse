import { useQuery } from "@tanstack/react-query";
import { DollarSign, Flame, Trophy, Truck, Users } from "lucide-react";
import { Overline, Panel, fmtMoney } from "@/components/common";
import { apiGet } from "@/lib/api";
import type { TrophyWall } from "@/lib/types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const label = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

type Award = { month: string; kind: "dollars" | "customers" | "truck"; text: string };
const ICON = { dollars: DollarSign, customers: Users, truck: Truck };
const TITLE = { dollars: "Most won back", customers: "Most customers won back", truck: "Vehicle-sales champion" };

/** One rep's own trophies (win-back + truck) and streaks, from the yard's Trophy Wall. */
export default function RepTrophyCase({ repId, isSelf }: { repId: string | undefined; isSelf: boolean }) {
  const { data } = useQuery({ queryKey: ["winback-trophies"], queryFn: () => apiGet<TrophyWall>("/analytics/winback/trophies"), enabled: !!repId });
  if (!data || !repId) return null;
  const me = (data.reps ?? []).find((r) => r.rep_id === repId);
  const awards: Award[] = (data.months ?? []).flatMap((w) => [
    ...(w.top_dollars?.rep_id === repId ? [{ month: w.month, kind: "dollars" as const, text: fmtMoney(w.top_dollars.won_value) }] : []),
    ...(w.top_customers?.rep_id === repId ? [{ month: w.month, kind: "customers" as const, text: `${w.top_customers.customers_won} customers` }] : []),
    ...(w.truck ?? []).filter((t) => t.rep_id === repId).map((t) => ({ month: w.month, kind: "truck" as const, text: `${t.sales} sale${t.sales === 1 ? "" : "s"}${w.truck.length > 1 ? " · shared" : ""}` })),
  ]);
  const stats = [
    { k: "winback", label: "Win-back trophies", v: me?.trophies ?? 0, icon: Trophy, tone: "text-amber-400" },
    { k: "truck", label: "Vehicle trophies", v: me?.truck_trophies ?? 0, icon: Truck, tone: "text-sky-300" },
    { k: "winback-streak", label: "Win-back streak", v: `${me?.current_streak ?? 0} mo`, sub: `best ${me?.best_streak ?? 0}`, icon: Flame, tone: "text-orange-300" },
    { k: "truck-streak", label: "Vehicle streak", v: `${me?.truck_streak ?? 0} mo`, sub: `best ${me?.best_truck_streak ?? 0}`, icon: Truck, tone: "text-sky-300" },
  ];
  return (
    <Panel className="mt-6" testId="rep-trophy-case">
      <Overline>{isSelf ? "Your trophy case" : "Trophy case"}</Overline>
      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        {stats.map((s) => (
          <div key={s.k} data-testid={`trophy-case-${s.k}`} className="rounded-lg border border-border bg-surface px-4 py-3">
            <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-slate-500">
              <s.icon className={`size-3.5 ${s.tone}`} /> {s.label}
            </p>
            <p className="mt-1 font-heading text-2xl font-bold text-white">
              {s.v} {s.sub && <span className="font-mono text-xs font-normal text-slate-500">{s.sub}</span>}
            </p>
          </div>
        ))}
      </div>
      {awards.length ? (
        <ul className="mt-4 flex flex-wrap gap-2" data-testid="trophy-case-awards">
          {awards.map((a, i) => {
            const Icon = ICON[a.kind];
            return (
              <li
                key={`${a.month}-${a.kind}`}
                data-testid={`trophy-case-award-${i}`}
                title={TITLE[a.kind]}
                className={`flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${a.kind === "truck" ? "border-sky-500/40 bg-sky-500/10 text-sky-200" : "border-amber-500/40 bg-amber-500/10 text-amber-200"}`}
              >
                <Icon className="size-3.5" />
                <span className="font-semibold text-white">{label(a.month)}</span> {TITLE[a.kind]} · {a.text}
              </li>
            );
          })}
        </ul>
      ) : (
        <p data-testid="trophy-case-empty" className="mt-4 text-sm text-slate-500">
          {isSelf ? "No trophies yet — " : "No trophies yet. "}
          {isSelf ? "win back the most customers or close the most vehicle-arrival sales this month to earn your first." : ""}
        </p>
      )}
    </Panel>
  );
}
