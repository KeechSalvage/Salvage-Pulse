import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Award, Crown, ListChecks, Mail, Tag, Trophy, Truck } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useMe } from "@/lib/hooks";
import { PageHeader, Overline, Panel, fmtMoney } from "@/components/common";
import { MONTH_LONG } from "@/components/CallsDrill";
import WinBackLeaderboardPanel from "@/components/WinBackLeaderboard";
import TruckLeaderboard from "@/components/TruckLeaderboard";
import RoleplayScoreboardPanel from "@/components/RoleplayScoreboard";
import TrophyWallPanel from "@/components/TrophyWall";
import StreakBreakBanner from "@/components/StreakBreakBanner";
import { LotSwitcher } from "@/components/Sites";
import { lotQS, useLotParam } from "@/lib/lot";
import PremiumGate from "@/components/PremiumGate";
import { apiGet, apiPost, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useChampions, useTeamPlayers } from "@/components/ChampionBadges";
import { HeartHandshake, MapPin, Printer } from "lucide-react";
import type { ChampionCategory, DeliveryLeaderboard, ListLeaderboard, PosterSendResult, TaggingLeaderboard } from "@/lib/types";
import { isManagerLike } from "@/lib/types";

const TABS = [
  { id: "trophies", label: "Trophy case" },
  { id: "lists", label: "Callback lists" },
  { id: "vehicles", label: "Vehicle sales" },
  { id: "winback", label: "Win-back" },
  { id: "streaks", label: "Streaks" },
  { id: "tagging", label: "Tagging" },
  { id: "delivery", label: "Delivery checklist" },
  { id: "team", label: "Team player" },
  { id: "roleplay", label: "Role-play" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const LOT_TABS: readonly TabId[] = ["trophies", "lists", "vehicles", "winback", "streaks", "tagging", "delivery", "team"]; // boards each lot can race on its own

const CAT: Record<ChampionCategory, { label: string; icon: typeof Trophy; cls: string }> = {
  callback_lists: { label: "Callback-list champ", icon: ListChecks, cls: "text-sky-300 border-sky-500/40 bg-sky-500/[0.06]" },
  vehicle_sales: { label: "Vehicle-sales champ", icon: Trophy, cls: "text-amber-300 border-amber-500/40 bg-amber-500/[0.06]" },
  winback_dollars: { label: "Win-back $ champ", icon: Crown, cls: "text-emerald-300 border-emerald-500/40 bg-emerald-500/[0.06]" },
  winback_customers: { label: "Win-back customers champ", icon: Award, cls: "text-emerald-300 border-emerald-500/40 bg-emerald-500/[0.06]" },
  tagging: { label: "Top tagger", icon: Tag, cls: "text-violet-300 border-violet-500/40 bg-violet-500/[0.06]" },
  delivery_score: { label: "Delivery checklist champ", icon: Truck, cls: "text-sky-300 border-sky-500/40 bg-sky-500/[0.06]" },
  team_player: { label: "Team Player champ", icon: HeartHandshake, cls: "text-rose-300 border-rose-400/50 bg-rose-500/[0.06]" },
  top_location: { label: "Top Location", icon: MapPin, cls: "text-sky-300 border-sky-400/50 bg-sky-500/[0.06]" },
};

const periodLabel = (c: { category: ChampionCategory; period: string }) =>
  c.category === "tagging" ? `Week of ${new Date(`${c.period}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : (c.period ? MONTH_LONG(c.period) : "");

function TrophyCase({ lot }: { lot: string }) {
  const { data } = useChampions(lot);
  const { data: me } = useMe();
  const posters = useMutation({
    mutationFn: () => apiPost<PosterSendResult>("/leaderboards/posters/send-now"),
    onSuccess: (r) =>
      toast.success(
        (r.champions ? `Sent ${r.sent} of ${r.champions} champion poster${r.champions === 1 ? "" : "s"} for ${MONTH_LONG(r.month)}` : `No champions for ${MONTH_LONG(r.month)}`) +
          (r.lots ? ` · ${r.lot_sent} of ${r.lots} lot poster${r.lots === 1 ? "" : "s"} to location managers` : ""),
      ),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const [cat, setCat] = useState<ChampionCategory | "all">("all");
  const shown = (data?.champions ?? []).filter((c) => cat === "all" || c.category === cat);
  return (
    <div className="space-y-6">
      <Panel testId="trophy-case-panel">
        <Overline>Trophy case</Overline>
        <h3 className="mb-1 mt-1 text-xl font-bold text-white">Previous champions</h3>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <p className="text-xs text-slate-500">Every finished month (and tagging week) — ties share the trophy. Each month's champions get their poster by email on the 1st.</p>
          {lot && (
            <a href={`/poster/lot/${lot}`} target="_blank" rel="noreferrer" data-testid="lot-poster-link"
              className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-sky-500/50 bg-sky-500/10 px-3 py-1.5 text-xs font-medium text-sky-200 transition-colors duration-150 hover:bg-sky-500/20">
              <Printer className="size-3.5" /> This lot's break-room poster
            </a>
          )}
          {isManagerLike(me?.role) && !lot && (
            <Button size="sm" variant="outline" className="ml-auto" data-testid="posters-send-now" disabled={posters.isPending} onClick={() => posters.mutate()}>
              <Mail className="size-3.5" /> Email last month's posters
            </Button>
          )}
        </div>
        {!!(data?.totals ?? []).length && (
          <div className="mb-5 flex flex-wrap gap-2" data-testid="trophy-totals">
            {(data?.totals ?? []).map((t, i) => (
              <span key={t.name} data-testid={`trophy-total-${i}`} className={cn("inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm", i === 0 ? "border-amber-400/60 bg-amber-500/10 text-amber-200" : "border-border text-slate-300")}>
                <Trophy className="size-3.5" /> {t.name} <span className="font-mono text-xs">×{t.trophies}</span>
              </span>
            ))}
          </div>
        )}
        <div className="mb-4 flex flex-wrap gap-1.5">
          {(["all", ...Object.keys(CAT)] as (ChampionCategory | "all")[]).map((k) => (
            <button key={k} type="button" data-testid={`trophy-filter-${k}`} onClick={() => setCat(k)}
              className={cn("rounded-full border px-3 py-1 text-xs transition-colors duration-150", cat === k ? "border-amber-500 bg-amber-500/15 text-white" : "border-border text-slate-400 hover:text-white")}>
              {k === "all" ? "All categories" : CAT[k].label}
            </button>
          ))}
        </div>
        {!shown.length ? (
          <p className="text-sm text-slate-500" data-testid="trophy-case-empty">No champions crowned yet in this category — the first trophy goes out when a month (or tagging week) ends.</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="trophy-case-list">
            {shown.map((c) => {
              const m = CAT[c.category] ?? { label: c.category.replace("_", " "), icon: Trophy, cls: "text-amber-300 border-amber-500/40 bg-amber-500/[0.06]" };
              const Icon = m.icon;
              return (
                <li key={`${c.category}-${c.period}`} data-testid={`trophy-${c.category}-${c.period}`} className={cn("rounded-xl border p-4 transition-transform duration-150 hover:-translate-y-0.5", m.cls)}>
                  <div className="flex items-center gap-2">
                    <Icon className="size-4" />
                    <span className="font-mono text-[11px] uppercase tracking-wider">{m.label}</span>
                    <span className="ml-auto font-mono text-[11px] text-slate-400">{periodLabel(c)}</span>
                  </div>
                  <p className="mt-2 font-heading text-lg font-bold text-white">{c.names.join(" & ")}</p>
                  <p className="text-xs text-slate-400">{c.detail}</p>
                  {(c.site_ids ?? []).map((sid) => (
                    <a key={sid} href={`/poster/location/${sid}`} target="_blank" rel="noreferrer" data-testid={`location-poster-${sid}-${c.period}`} className="mt-2 inline-block font-mono text-[11px] text-sky-300 underline-offset-2 hover:underline">Break-room poster →</a>
                  ))}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
      <PremiumGate feature="leaderboards"><TrophyWallPanel /></PremiumGate>
    </div>
  );
}

function ListBoard({ lot }: { lot: string }) {
  const [by, setBy] = useState<"revenue" | "customers">("revenue");
  const { data } = useQuery({ queryKey: ["callback-lists", "leaderboard", lot], queryFn: () => apiGet<ListLeaderboard>(`/callback-lists/leaderboard${lotQS(lot)}`) });
  const reps = [...(data?.reps ?? [])].sort((a, b) => (by === "revenue" ? b.revenue - a.revenue || b.customers - a.customers : b.customers - a.customers || b.revenue - a.revenue));
  return (
    <Panel testId="list-leaderboard-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Overline>Callback lists · {data ? MONTH_LONG(data.month) : ""}</Overline>
          <h3 className="mt-1 text-xl font-bold text-white">Who turns lists into sales</h3>
          <p className="text-xs text-slate-500">Sales from list customers this month. Last month's #1 gets a trophy in the daily email.</p>
        </div>
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-surface p-1 text-xs">
          {(["revenue", "customers"] as const).map((k) => (
            <button key={k} type="button" data-testid={`list-leaderboard-by-${k}`} onClick={() => setBy(k)} className={cn("rounded-md px-3 py-1.5 transition-colors duration-150", by === k ? "bg-sky-500/20 text-white" : "text-slate-400 hover:text-white")}>
              {k === "revenue" ? "Sales $" : "Customers"}
            </button>
          ))}
        </div>
      </div>
      {!reps.length ? (
        <p className="mt-4 text-sm text-slate-500" data-testid="list-leaderboard-empty">No callback lists yet.</p>
      ) : (
        <ol className="mt-4 space-y-2">
          {reps.map((r, i) => (
            <li key={r.rep_id} data-testid={`list-leader-${r.rep_id}`} className={cn("flex items-center gap-3 rounded-lg border px-4 py-2.5", i === 0 && (r.revenue || r.customers) ? "border-amber-400/50 bg-amber-500/[0.06]" : "border-border bg-surface")}>
              <span className="w-6 font-mono text-sm text-slate-500">{i + 1}</span>
              {i === 0 && (r.revenue || r.customers) ? <Crown className="size-4 text-amber-300" /> : null}
              <span className="flex-1 text-white">{r.name}</span>
              <span className="font-mono text-xs text-slate-400">{r.lists} list{r.lists === 1 ? "" : "s"}</span>
              <span className={cn("w-24 text-right font-mono text-sm", by === "customers" ? "text-white" : "text-slate-400")}>{r.customers} bought</span>
              <span className={cn("w-24 text-right font-mono text-sm", by === "revenue" ? "text-emerald-300" : "text-slate-400")}>{fmtMoney(r.revenue)}</span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

function TeamPlayerBoardPanel({ lot }: { lot: string }) {
  const { data } = useTeamPlayers(lot);
  return (
    <Panel testId="team-player-panel">
      <Overline>Team player · {data ? MONTH_LONG(data.month) : ""}</Overline>
      <h3 className="mt-1 text-xl font-bold text-white">Who had their teammates' backs</h3>
      <p className="mb-4 text-xs text-slate-500">One team player badge for every callback a rep finished while covering for someone on the Shift calendar.</p>
      {!((data?.reps ?? []).length) ? (
        <p className="text-sm text-slate-500" data-testid="team-player-empty">No covered callbacks yet — pick a cover rep when you add time off on the Shift calendar.</p>
      ) : (
        <ol className="space-y-2">
          {(data?.reps ?? []).map((r, i) => (
            <li key={r.rep_id} data-testid={`team-player-${r.rep_id}`} className={cn("flex items-center gap-3 rounded-lg border px-4 py-2.5", i === 0 && r.handled ? "border-rose-400/50 bg-rose-500/[0.06]" : "border-border bg-surface")}>
              <span className="w-6 font-mono text-sm text-slate-500">{i + 1}</span>
              <HeartHandshake className="size-4 text-rose-300" />
              <span className="flex-1 text-white">{r.name}</span>
              <span className="font-mono text-sm text-rose-300">{r.handled} this month</span>
              <span className="w-28 text-right font-mono text-xs text-slate-500">×{r.all_time} badges</span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

function DeliveryBoard({ lot }: { lot: string }) {
  const { data } = useQuery({ queryKey: ["leaderboards", "delivery", lot], queryFn: () => apiGet<DeliveryLeaderboard>(`/leaderboards/delivery${lotQS(lot)}`) });
  return (
    <Panel testId="delivery-leaderboard-panel">
      <Overline>Delivery checklist · {data ? MONTH_LONG(data.month) : ""}</Overline>
      <h3 className="mt-1 text-xl font-bold text-white">Best delivery calls</h3>
      <p className="mb-4 text-xs text-slate-500">Average checklist score (date given, address confirmed, thanked) on this month's delivery calls. Winning the month takes 3+ checked calls.</p>
      {!((data?.reps ?? []).length) ? (
        <p className="text-sm text-slate-500" data-testid="delivery-leaderboard-empty">No delivery calls checked this month yet — tag a call as a delivery call and the checklist appears on it.</p>
      ) : (
        <ol className="space-y-2">
          {(data?.reps ?? []).map((r, i) => (
            <li key={r.rep_id} data-testid={`delivery-leader-${r.rep_id}`} className={cn("flex items-center gap-3 rounded-lg border px-4 py-2.5", i === 0 ? "border-sky-400/50 bg-sky-500/[0.06]" : "border-border bg-surface")}>
              <span className="w-6 font-mono text-sm text-slate-500">{i + 1}</span>
              {i === 0 && <Crown className="size-4 text-sky-300" />}
              <span className="flex-1 text-white">{r.name}</span>
              <span className="font-mono text-xs text-slate-500">{r.checked} call{r.checked === 1 ? "" : "s"}</span>
              <span className="w-16 text-right font-mono text-lg text-sky-300">{r.avg_score}</span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

function TagBoard({ lot }: { lot: string }) {
  const { data } = useQuery({ queryKey: ["tagging", "leaderboard", lot], queryFn: () => apiGet<TaggingLeaderboard>(`/tagging/leaderboard${lotQS(lot)}`) });
  return (
    <Panel testId="tag-leaderboard-panel">
      <Overline>Tagging · this week</Overline>
      <h3 className="mb-4 mt-1 text-xl font-bold text-white">Most vehicles tagged</h3>
      {!((data?.leaders ?? []).length) ? (
        <p className="text-sm text-slate-500">Nobody has tagged a vehicle this week yet.</p>
      ) : (
        <ol className="space-y-2">
          {(data?.leaders ?? []).map((r, i) => (
            <li key={r.user_id} data-testid={`tag-leader-${r.user_id}`} className="flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-2.5">
              <span className="w-6 font-mono text-sm text-slate-500">{i + 1}</span>
              <span className="flex-1 text-white">{r.name}</span>
              <span className="font-mono text-sm text-violet-300">{r.tagged} tagged</span>
              <span className="w-28 text-right font-mono text-xs text-slate-500">{r.skipped} no-vehicle</span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

export default function Leaderboards() {
  const [tab, setTab] = useState<TabId>("trophies");
  const [lot, setLot] = useLotParam();
  const byLot = LOT_TABS.includes(tab);
  return (
    <>
      <PageHeader overline="Leaderboards" title="Who's on top" />
      <div id="leaderboards-tabs" className="mb-6 flex flex-wrap gap-1 border-b border-border scroll-mt-6" data-testid="leaderboard-tabs">
        {TABS.map((t) => (
          <button key={t.id} type="button" data-testid={`leaderboard-tab-${t.id}`} onClick={() => setTab(t.id)}
            className={cn("-mb-px border-b-2 px-4 py-2 text-sm transition-colors duration-150", tab === t.id ? "border-amber-500 text-white" : "border-transparent text-slate-400 hover:text-white")}>
            {t.label}
          </button>
        ))}
      </div>
      <div id="leaderboard-main-view" className="scroll-mt-6">
        {tab === "trophies" && <TrophyCase lot={lot} />}
        {tab === "lists" && <ListBoard lot={lot} />}
        {byLot && (
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <LotSwitcher value={lot} onChange={setLot} testId="leaderboard-lot-switcher" allLabel="Whole yard" />
            {lot && <span data-testid="leaderboard-lot-note" className="text-xs text-slate-400">Only people working at this lot now — their own race for trophies and streaks.</span>}
          </div>
        )}
        {tab === "vehicles" && <PremiumGate feature="leaderboards"><TruckLeaderboard lot={lot} /></PremiumGate>}
        {tab === "winback" && <PremiumGate feature="leaderboards"><WinBackLeaderboardPanel lot={lot} /></PremiumGate>}
        {tab === "streaks" && (
          <PremiumGate feature="leaderboards">
            <StreakBreakBanner lot={lot} />
            <TrophyWallPanel lot={lot} />
          </PremiumGate>
        )}
        {tab === "tagging" && <TagBoard lot={lot} />}
        {tab === "delivery" && <DeliveryBoard lot={lot} />}
        {tab === "team" && <TeamPlayerBoardPanel lot={lot} />}
        {tab === "roleplay" && <RoleplayScoreboardPanel />}
      </div>
    </>
  );
}
