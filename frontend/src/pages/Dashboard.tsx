import { Link, useNavigate } from "react-router-dom";
import TileGrid from "@/components/TileGrid";
import LotCompare from "@/components/LotCompare";
import { LocationLeaderboard, LotSwitcher } from "@/components/Sites";
import { lotQS, useLotParam } from "@/lib/lot";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, MapPin, PhoneIncoming, PhoneMissed, PhoneOutgoing, Upload, Voicemail } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { CategoryBadge, Overline, PageHeader, Panel, ScoreBadge, StatCard, fmtDuration } from "@/components/common";
import { CategoryDonut, HourlyVolume, MetricBarChart, ScoreTrend, TopicList } from "@/components/Charts";
import { Avatar } from "@/components/AppShell";
import CustomerPanel from "@/components/CustomerPanel";
import WinnerBanner from "@/components/WinnerBanner";
import TrendAlerts from "@/components/TrendAlerts";
import PremiumGate from "@/components/PremiumGate";
import SampleDataBanner from "@/components/SampleDataBanner";
import LoginUsageAlert from "@/components/LoginUsageAlert";
import StreakBreakBanner from "@/components/StreakBreakBanner";
import TeamQueuePanel from "@/components/TeamQueue";
import MonthlyTrendsPanel from "@/components/MonthlyTrends";
import RepTrendsPanel from "@/components/RepTrends";
import SeasonalPartsPanel from "@/components/SeasonalParts";
import WinBackResultsPanel from "@/components/WinBackResults";
import WinBackLeaderboardPanel from "@/components/WinBackLeaderboard";
import { apiGet } from "@/lib/api";
import type { Overview } from "@/lib/types";

export default function Dashboard() {
  const nav = useNavigate();
  const [lot, setLot] = useLotParam(); // whole-yard managers: "" = all lots (location managers are locked to theirs server-side)
  const { data, isError } = useQuery({ queryKey: ["overview", "team", lot], queryFn: () => apiGet<Overview>(`/analytics/overview${lotQS(lot)}`), placeholderData: (prev) => prev });
  const ov = isError ? undefined : data;

  return (
    <>
      <PageHeader overline={ov?.lot_name ? `${ov.lot_name} · ${lot ? "one lot" : "your location"}` : "Manager telemetry"} title={ov?.lot_name ? `${ov.lot_name} call performance` : "Team call performance"}>
        <LotSwitcher value={lot} onChange={setLot} testId="dashboard-lot-switcher" hideForLotManager />
        <Link to="/upload" data-testid="dashboard-upload-link" className={buttonVariants({ size: "lg" })}>
          <Upload className="size-4" /> Upload call
        </Link>
      </PageHeader>
      {ov?.lot_name && (
        <p data-testid="dashboard-lot-scope" className="mb-6 inline-flex items-center gap-2 rounded-full border border-sky-500/40 bg-sky-500/10 px-3 py-1 font-mono text-[11px] text-sky-200">
          <MapPin className="size-3.5" /> Showing {ov.lot_name} only — calls, reps and callbacks from {lot ? "this" : "your"} lot
        </p>
      )}
      <SampleDataBanner empty={ov?.total_calls === 0} />
      <LoginUsageAlert className="mb-6" />
      <PremiumGate feature="leaderboards" hidden><StreakBreakBanner lot={lot} /></PremiumGate>
      <PremiumGate feature="vehicle_arrivals" hidden><TeamQueuePanel lot={lot} /></PremiumGate>
      <PremiumGate feature="trend_alerts" hidden>
        <TrendAlerts />
      </PremiumGate>

      {ov && ov.open_callbacks > 0 && (
        <Link
          to="/callbacks"
          data-testid="dashboard-callbacks-alert"
          className="mb-6 flex items-center gap-3 rounded-xl border border-red-500/40 bg-red-500/[0.07] px-5 py-3.5 text-sm transition-colors duration-150 hover:border-red-500/70"
        >
          <PhoneMissed className="size-4 text-red-400" />
          <span className="text-slate-200">
            <span className="font-semibold text-white">{ov.open_callbacks} missed callers</span> haven't been reached yet — voicemails and short calls with no follow-up.
          </span>
          <span className="ml-auto flex items-center gap-1 text-red-300">Open queue <ArrowRight className="size-4" /></span>
        </Link>
      )}

      <PremiumGate feature="leaderboards" hidden><WinnerBanner lot={lot} /></PremiumGate>
      <LocationLeaderboard lot={lot} />
      {!lot && <PremiumGate feature="monthly_trends" hidden><LotCompare /></PremiumGate>}

      <div id="dashboard-stats" className="scroll-mt-6">
        <TileGrid
          page="dashboard-stats"
          label="stat tiles"
          className="grid grid-cols-2 gap-4 lg:grid-cols-5"
          tiles={[
            { id: "total-calls", label: "Calls tracked", span: "", node: (
              <StatCard label="Calls tracked" value={ov?.total_calls ?? "—"} testId="stat-total-calls" />
            ) },
            { id: "avg-score", label: "Avg QA score", span: "", node: (
              <StatCard label="Avg QA score" value={ov?.avg_score ?? "—"} sub="out of 100" testId="stat-avg-score" accent />
            ) },
            { id: "handle-time", label: "Avg handle time", span: "", node: (
              <StatCard label="Avg handle time" value={ov ? fmtDuration(ov.avg_duration_sec) : "—"} sub="minutes per call" testId="stat-avg-duration" />
            ) },
            { id: "warranty", label: "Warranty pitched", span: "", node: (
              <StatCard label="Warranty pitched" value={ov ? `${ov.warranty_pitch_rate}%` : "—"} sub="of connected calls" testId="stat-warranty-rate" />
            ) },
            { id: "close-rate", label: "Close rate", span: "", node: (
              <StatCard
                label="Close rate"
                value={ov ? `${ov.conversion_rate}%` : "—"}
                sub={ov ? `${ov.won ?? 0} won of ${(ov.won ?? 0) + (ov.lost ?? 0) + (ov.pending ?? 0)} sales calls` : ""}
                testId="stat-conversion"
              />
            ) },
          ]}
        />
      </div>

      <TileGrid
        page="dashboard"
        label="tiles"
        className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-12"
        tiles={[
          { id: "monthly-trends", label: "Monthly trends", span: "xl:col-span-12", node: (
            <PremiumGate feature="monthly_trends" className="xl:col-span-12">
              <MonthlyTrendsPanel lot={lot} />
            </PremiumGate>
          ) },
          { id: "rep-trends", label: "Rep comparison", span: "xl:col-span-12", node: (
            <PremiumGate feature="rep_trends" className="xl:col-span-12">
              <RepTrendsPanel lot={lot} />
            </PremiumGate>
          ) },
          { id: "seasonal-parts", label: "Seasonal parts", span: "xl:col-span-12", node: (
            <PremiumGate feature="parts_insights" className="xl:col-span-12">
              <SeasonalPartsPanel lot={lot} />
            </PremiumGate>
          ) },
          { id: "leaderboard", label: "Rep rankings", span: "xl:col-span-7", node: (
            <Panel className="xl:col-span-7" testId="leaderboard-panel">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <Overline>Leaderboard</Overline>
                  <h3 className="mt-1 text-xl font-bold text-white">Rep rankings</h3>
                </div>
                <Link to="/team" className="text-sm text-sky-400 hover:underline" data-testid="leaderboard-view-team">
                  Manage reps
                </Link>
              </div>
              <div className="divide-y divide-border">
                {(ov?.leaderboard ?? []).map((r, i) => (
                  <button
                    key={r.rep_id}
                    data-testid={`leaderboard-row-${r.rep_id}`}
                    onClick={() => nav(`/reps/${r.rep_id}`)}
                    className="group flex w-full items-center gap-4 py-3 text-left transition-colors duration-150 hover:bg-slate-800/30"
                  >
                    <span className="w-6 font-mono text-sm text-slate-500">{String(i + 1).padStart(2, "0")}</span>
                    <Avatar name={r.name} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-white">{r.name}</p>
                      <p className="text-xs text-slate-500">{r.title}</p>
                    </div>
                    <div className="hidden w-28 text-right md:block">
                      <p className="font-mono text-[10px] uppercase tracking-wider text-slate-500">Warranty</p>
                      <div className="mt-1 flex items-center justify-end gap-2">
                        <div className="h-1 w-14 overflow-hidden rounded-full bg-slate-800">
                          <div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.min(100, r.warranty_pitch_rate)}%` }} />
                        </div>
                        <span data-testid={`leaderboard-warranty-${r.rep_id}`} className="font-mono text-xs text-emerald-300">{r.warranty_pitch_rate}%</span>
                      </div>
                    </div>
                    <div className="hidden text-right sm:block">
                      <p className="font-mono text-xs text-slate-400">{r.calls} calls</p>
                      <p className="font-mono text-xs text-slate-500">{r.conversion_rate}% close</p>
                    </div>
                    <ScoreBadge score={Math.round(r.avg_score)} />
                    <ArrowRight className="size-4 text-slate-600 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-amber-400" />
                  </button>
                ))}
                {!ov && <p className="py-6 text-sm text-slate-500">Leaderboard unavailable.</p>}
              </div>
            </Panel>
          ) },
          { id: "call-mix", label: "Call categories", span: "xl:col-span-5", node: (
            <Panel className="xl:col-span-5" testId="category-panel">
              <Overline>Call mix</Overline>
              <h3 className="mb-4 mt-1 text-xl font-bold text-white">Incoming call categories</h3>
              {ov ? <CategoryDonut data={ov.category_breakdown ?? []} /> : <p className="text-sm text-slate-500">No data.</p>}
            </Panel>
          ) },
          { id: "customers", label: "Customers", span: "xl:col-span-12", node: (
            <CustomerPanel team />
          ) },
          { id: "winback-results", label: "Win-back results", span: "xl:col-span-12", node: (
            <WinBackResultsPanel />
          ) },
          { id: "winback-leaderboard", label: "Win-back leaderboard", span: "xl:col-span-12", node: (
            <PremiumGate feature="leaderboards"><WinBackLeaderboardPanel /></PremiumGate>
          ) },
          { id: "call-volume", label: "Calls by hour", span: "xl:col-span-7", node: (
            <Panel className="xl:col-span-7" testId="volume-panel">
              <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <Overline>Call volume</Overline>
                  <h3 className="mt-1 text-xl font-bold text-white">Calls by hour of day</h3>
                </div>
                <div className="flex gap-4 font-mono text-xs">
                  <span data-testid="volume-inbound" className="flex items-center gap-1.5 text-amber-300"><PhoneIncoming className="size-3.5" />{ov?.inbound ?? 0} in</span>
                  <span data-testid="volume-outbound" className="flex items-center gap-1.5 text-slate-300"><PhoneOutgoing className="size-3.5" />{ov?.outbound ?? 0} out</span>
                  <span data-testid="volume-voicemail" className="flex items-center gap-1.5 text-slate-400"><Voicemail className="size-3.5" />{ov?.voicemails ?? 0} vm</span>
                </div>
              </div>
              {ov && <HourlyVolume data={ov.hourly ?? []} />}
            </Panel>
          ) },
          { id: "topics", label: "Caller topics", span: "xl:col-span-5", node: (
            <Panel className="xl:col-span-5" testId="topics-panel">
              <Overline>Insights</Overline>
              <h3 className="mb-4 mt-1 text-xl font-bold text-white">What callers talk about</h3>
              {ov && <TopicList data={(ov.topic_stats ?? []).slice(0, 10)} testId="topic-list" />}
            </Panel>
          ) },
          { id: "score-trend", label: "QA score by day", span: "xl:col-span-7", node: (
            <Panel className="xl:col-span-7" testId="trend-panel">
              <Overline>Trend</Overline>
              <h3 className="mb-4 mt-1 text-xl font-bold text-white">QA score by day</h3>
              {ov && <ScoreTrend data={ov.trend ?? []} />}
            </Panel>
          ) },
          { id: "metrics", label: "Metric averages", span: "xl:col-span-5", node: (
            <Panel className="xl:col-span-5" testId="metric-panel">
              <Overline>Skill gaps</Overline>
              <h3 className="mb-2 mt-1 text-xl font-bold text-white">Team metric averages</h3>
              {ov && ov.scored_calls > 0 ? (
                <MetricBarChart data={ov.metric_averages ?? []} />
              ) : (
                <p data-testid="metric-panel-empty" className="mt-4 text-sm leading-relaxed text-slate-400">
                  The 7-metric breakdown needs a transcript or recording. Open any imported call and attach one to unlock AI coaching.
                </p>
              )}
            </Panel>
          ) },
          { id: "coaching-flags", label: "Coaching flags", span: "xl:col-span-7", node: (
            <Panel className="xl:col-span-7" testId="coaching-flags-panel">
              <div className="mb-4 flex items-center gap-2">
                <AlertTriangle className="size-4 text-amber-400" />
                <h3 className="text-xl font-bold text-white">Coaching flags</h3>
                <span className="font-mono text-xs text-slate-500">score &lt; 60</span>
              </div>
              <div className="space-y-3">
                {(ov?.coaching_flags ?? []).map((f) => (
                  <Link
                    key={f.call_id}
                    to={`/calls/${f.call_id}`}
                    data-testid={`coaching-flag-${f.call_id}`}
                    className="flex items-start gap-4 rounded-lg border border-border bg-surface p-4 transition-colors duration-150 hover:border-amber-500/40"
                  >
                    <ScoreBadge score={f.overall_score} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-white">{f.rep_name}</span>
                        <span className="text-xs text-slate-500">with {f.customer_name}</span>
                        <CategoryBadge category={f.category} />
                      </div>
                      <p className="mt-1.5 text-sm text-slate-400">{f.top_improvement}</p>
                    </div>
                  </Link>
                ))}
                {ov && !(ov.coaching_flags ?? []).length && <p className="text-sm text-slate-500">No low-scoring calls. Nice work, team.</p>}
              </div>
            </Panel>
          ) },
          { id: "keywords", label: "Keyword tracker", span: "xl:col-span-5", node: (
            <Panel className="xl:col-span-5" testId="keyword-panel">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <Overline>Keyword tracker</Overline>
                  <h3 className="mt-1 text-xl font-bold text-white">Top mentions</h3>
                </div>
                <Link to="/keywords" className="text-sm text-sky-400 hover:underline" data-testid="keyword-panel-manage">
                  Manage
                </Link>
              </div>
              <div className="space-y-2.5">
                {(ov?.keyword_stats ?? []).slice(0, 8).map((k) => {
                  const max = Math.max(1, ...(ov?.keyword_stats ?? []).map((x) => x.count));
                  return (
                    <div key={k.keyword} data-testid={`keyword-stat-${k.keyword}`}>
                      <div className="flex justify-between text-sm">
                        <span className="font-mono text-emerald-300">{k.keyword}</span>
                        <span className="font-mono text-xs text-slate-400">
                          {k.count} hits · {k.calls} calls
                        </span>
                      </div>
                      <div className="mt-1 h-1 rounded-full bg-slate-800">
                        <div className="h-full rounded-full bg-emerald-500/70 transition-[width] duration-500" style={{ width: `${(k.count / max) * 100}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </Panel>
          ) },
        ]}
      />
    </>
  );
}
