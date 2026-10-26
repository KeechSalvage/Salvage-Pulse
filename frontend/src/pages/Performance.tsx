import { Link, useParams } from "react-router-dom";
import TileGrid from "@/components/TileGrid";
import { PriceMissingReminder } from "@/components/PriceMissing";
import ChampionBadges from "@/components/ChampionBadges";
import { CoverRequestsCard } from "@/components/CoverRequests";
import { DeliveryCoaching, PosterButton } from "@/components/RepExtras";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Bot, PhoneMissed, Target } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { CategoryBadge, EmptyState, Overline, PageHeader, Panel, ScoreBadge, StatCard, fmtDate, fmtDuration } from "@/components/common";
import { CategoryDonut, MetricRadar, ScoreTrend, TopicList } from "@/components/Charts";
import { Avatar } from "@/components/AppShell";
import CustomerPanel from "@/components/CustomerPanel";
import WinnerBanner from "@/components/WinnerBanner";
import MonthlyTrendsPanel from "@/components/MonthlyTrends";
import PremiumGate from "@/components/PremiumGate";
import CallQueue from "@/components/CallQueue";
import StreakChaseNudge from "@/components/StreakChaseNudge";
import StreakBreakBanner from "@/components/StreakBreakBanner";
import RepTrophyCase from "@/components/RepTrophyCase";
import WinBackResultsPanel from "@/components/WinBackResults";
import WinBackLeaderboardPanel from "@/components/WinBackLeaderboard";
import { apiGet } from "@/lib/api";
import { useMe } from "@/lib/hooks";
import type { CallSummary, Overview, TeamBenchmark } from "@/lib/types";

export default function Performance() {
  const { repId } = useParams();
  const { data: me } = useMe();
  const targetId = repId ?? me?.id;
  const qs = repId ? `?rep_id=${repId}` : "";

  const { data, isError } = useQuery({
    queryKey: ["overview", targetId],
    queryFn: () => apiGet<Overview>(`/analytics/overview${qs}`),
    enabled: !!targetId,
  });
  const team = useQuery({
    queryKey: ["overview", "team-benchmark"],
    queryFn: () => apiGet<TeamBenchmark>("/analytics/team-benchmark"),
    enabled: !!me,
  });
  const calls = useQuery({
    queryKey: ["calls", { rep_id: targetId }],
    queryFn: () => apiGet<CallSummary[]>(`/calls${repId ? `?rep_id=${repId}` : ""}`),
    enabled: !!targetId,
  });
  const ov = isError ? undefined : data;
  const name = ov?.rep?.name ?? me?.name ?? "";
  const isSelf = !repId;

  const metricList = ov?.metric_averages ?? [];
  const weakest = metricList.length ? [...metricList].sort((a, b) => a.avg - b.avg)[0] : undefined;
  const strongest = metricList.length ? [...metricList].sort((a, b) => b.avg - a.avg)[0] : undefined;

  return (
    <>
      {repId && (
        <Link to="/dashboard" data-testid="back-to-dashboard" className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-white">
          <ArrowLeft className="size-4" /> Team dashboard
        </Link>
      )}
      <PageHeader overline={isSelf ? "Your call makeup" : "Rep profile"} title={isSelf ? `Hey ${name.split(" ")[0]}, here's your game` : name}>
        <div className="flex items-center gap-3">
          {ov?.rep && <Avatar name={ov.rep.name} url={ov.rep.avatar_url} size={44} />}
          <Link to="/roleplay" data-testid="performance-roleplay-link" className={buttonVariants({ size: "lg" })}>
            <Bot className="size-4" /> Practice with AI
          </Link>
        </div>
      </PageHeader>
      <div className="-mt-4 mb-6 flex flex-wrap items-center gap-3">
        <ChampionBadges repId={targetId} testId="performance-champions" />
        {targetId && <PosterButton repId={targetId} />}
      </div>
      {!repId && <CoverRequestsCard />}
      <PriceMissingReminder repId={repId} />

      {isSelf && <PremiumGate feature="leaderboards" hidden><StreakBreakBanner /></PremiumGate>}
      {isSelf && me?.role === "rep" && <PremiumGate feature="leaderboards" hidden><StreakChaseNudge /></PremiumGate>}
      {isSelf && me?.role === "rep" && <PremiumGate feature="vehicle_arrivals" hidden><CallQueue /></PremiumGate>}
      {isSelf && ov && ov.open_callbacks > 0 && (
        <Link
          to="/callbacks"
          data-testid="rep-callbacks-alert"
          className="mb-6 flex items-center gap-3 rounded-xl border border-red-500/40 bg-red-500/[0.07] px-5 py-3.5 text-sm transition-colors duration-150 hover:border-red-500/70"
        >
          <PhoneMissed className="size-4 text-red-400" />
          <span className="text-slate-200">
            You have <span className="font-semibold text-white">{ov.open_callbacks} missed callers</span> to call back.
          </span>
          <span className="ml-auto flex items-center gap-1 text-red-300">
            Call them <ArrowRight className="size-4" />
          </span>
        </Link>
      )}

      <PremiumGate feature="leaderboards" hidden><WinnerBanner testId="rep-winner-banner" /></PremiumGate>

      <TileGrid
        page="performance-stats"
        selfArrange
        label="stat tiles"
        className="grid grid-cols-2 gap-4 lg:grid-cols-4"
        tiles={[
          { id: "calls", label: "My calls", span: "", node: (
            <StatCard label="My calls" value={ov?.total_calls ?? "—"} sub={ov ? `avg ${fmtDuration(ov.avg_duration_sec)} · ${ov.inbound} in / ${ov.outbound} out` : ""} testId="rep-stat-calls" />
          ) },
          { id: "avg-score", label: "Avg QA score", span: "", node: (
            <StatCard label="Avg QA score" value={ov?.avg_score ?? "—"} sub={team.data ? `team ${team.data.avg_score}` : "out of 100"} testId="rep-stat-avg-score" accent />
          ) },
          { id: "close-rate", label: "Close rate", span: "", node: (
            <StatCard
              label="Close rate"
              value={ov ? `${ov.conversion_rate}%` : "—"}
              sub={ov ? `${ov.won ?? 0} won of ${(ov.won ?? 0) + (ov.lost ?? 0) + (ov.pending ?? 0)} sales calls${team.data ? ` · team ${team.data.conversion_rate}%` : ""}` : ""}
              testId="rep-stat-conversion"
            />
          ) },
          { id: "warranty", label: "Warranty pitched", span: "", node: (
            <StatCard
              label="Warranty pitched"
              value={ov ? `${ov.warranty_pitch_rate}%` : "—"}
              sub={team.data ? `team ${team.data.warranty_pitch_rate}% · ${ov?.roleplay_sessions ?? 0} role-plays` : `${ov?.roleplay_sessions ?? 0} role-plays`}
              testId="rep-stat-warranty"
            />
          ) },
        ]}
      />

      <PremiumGate feature="leaderboards" hidden><RepTrophyCase repId={targetId} isSelf={isSelf} /></PremiumGate>

      <TileGrid
        page="performance"
        selfArrange
        label="tiles"
        className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-12"
        tiles={[
          { id: "monthly-trends", label: "Monthly trends", span: "xl:col-span-12", node: (
            <PremiumGate feature="monthly_trends" className="xl:col-span-12">
              <MonthlyTrendsPanel repId={repId} testId="rep-monthly-trends-panel" />
            </PremiumGate>
          ) },
          { id: "customers", label: "Customers", span: "xl:col-span-12", node: (
            <CustomerPanel repId={repId} />
          ) },
          { id: "delivery-coaching", label: "Delivery calls", span: "xl:col-span-12", node: <DeliveryCoaching repId={repId} /> },
          { id: "winback-results", label: "Win-back results", span: "xl:col-span-12", node: (
            <WinBackResultsPanel repId={repId} testId="rep-winback-results-panel" />
          ) },
          { id: "winback-leaderboard", label: "Win-back leaderboard", span: "xl:col-span-12", node: (
            <PremiumGate feature="leaderboards" hidden><WinBackLeaderboardPanel testId="rep-winback-leaderboard-panel" /></PremiumGate>
          ) },
          { id: "skills-radar", label: "Skills radar", span: "xl:col-span-5", node: (
            <Panel className="xl:col-span-5" testId="rep-radar-panel">
              <Overline>Skill profile</Overline>
              <h3 className="mt-1 text-xl font-bold text-white">7-metric radar</h3>
              {ov && ov.scored_calls === 0 && (
                <p data-testid="rep-radar-empty" className="mt-4 text-sm leading-relaxed text-slate-400">
                  No AI-coached calls yet. Attach a transcript or recording to any of your calls to build your skill profile.
                </p>
              )}
              {ov && ov.scored_calls > 0 && <MetricRadar data={ov.metric_averages} compare={team.data?.metric_averages} drill={repId ? { rep_id: repId } : {}} />}
              {ov && ov.scored_calls > 0 && (
                <div className="mt-2 grid grid-cols-2 gap-3 text-sm">
                  <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3">
                    <p className="font-mono text-[10px] uppercase tracking-wider text-emerald-400">Strongest</p>
                    <p data-testid="rep-strongest-metric" className="mt-1 text-white">
                      {strongest?.name} · {strongest?.avg}
                    </p>
                  </div>
                  <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-3">
                    <p className="font-mono text-[10px] uppercase tracking-wider text-amber-400">Biggest gap</p>
                    <p data-testid="rep-weakest-metric" className="mt-1 text-white">
                      {weakest?.name} · {weakest?.avg}
                    </p>
                  </div>
                </div>
              )}
            </Panel>
          ) },
          { id: "focus", label: "Focus areas", span: "xl:col-span-7", node: (
            <Panel className="xl:col-span-7" testId="rep-focus-panel">
              <div className="flex items-center gap-2">
                <Target className="size-4 text-amber-400" />
                <h3 className="text-xl font-bold text-white">Coaching focus areas</h3>
              </div>
              <p className="mt-1 text-sm text-slate-400">Pulled from the AI feedback on your most recent calls.</p>
              <ol className="mt-5 space-y-3" data-testid="rep-focus-list">
                {(ov?.focus_areas ?? []).map((f, i) => (
                  <li key={f} className="flex gap-4 rounded-lg border border-border bg-surface p-4">
                    <span className="font-mono text-sm text-amber-400">{String(i + 1).padStart(2, "0")}</span>
                    <span className="text-[15px] leading-relaxed text-slate-200">{f}</span>
                  </li>
                ))}
                {ov && !(ov.focus_areas ?? []).length && <p className="text-sm text-slate-500">No AI focus areas yet — attach transcripts or recordings to calls.</p>}
              </ol>
              {ov && (ov.topic_stats ?? []).length > 0 && (
                <div className="mt-6">
                  <Overline className="mb-3">Top topics on your calls</Overline>
                  <TopicList data={(ov.topic_stats ?? []).slice(0, 6)} testId="rep-topic-list" drill={repId ? { rep_id: repId } : {}} />
                </div>
              )}
            </Panel>
          ) },
          { id: "call-mix", label: "Call categories", span: "xl:col-span-5", node: (
            <Panel className="xl:col-span-5" testId="rep-category-panel">
              <Overline>Call makeup</Overline>
              <h3 className="mb-4 mt-1 text-xl font-bold text-white">What you handle</h3>
              {ov && (ov.category_breakdown ?? []).length ? <CategoryDonut data={ov.category_breakdown ?? []} drill={repId ? { rep_id: repId } : {}} /> : <p className="text-sm text-slate-500">No calls yet.</p>}
            </Panel>
          ) },
          { id: "score-trend", label: "QA score by day", span: "xl:col-span-7", node: (
            <Panel className="xl:col-span-7" testId="rep-trend-panel">
              <Overline>Trend</Overline>
              <h3 className="mb-4 mt-1 text-xl font-bold text-white">Score over time</h3>
              {ov && <ScoreTrend data={ov.trend ?? []} drill={repId ? { rep_id: repId } : {}} />}
            </Panel>
          ) },
          { id: "recent-calls", label: "Recent calls", span: "xl:col-span-12", node: (
            <Panel className="xl:col-span-12" testId="rep-recent-calls-panel">
              <h3 className="mb-4 text-xl font-bold text-white">Recent calls</h3>
              {calls.data && calls.data.length === 0 && <EmptyState title="No calls yet" body="Upload a call recording or transcript to get scored." testId="rep-calls-empty" />}
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {(calls.data ?? []).slice(0, 6).map((c) => (
                  <Link
                    key={c.id}
                    to={`/calls/${c.id}`}
                    data-testid={`rep-recent-call-${c.id}`}
                    className="flex items-start gap-4 rounded-lg border border-border bg-surface p-4 transition-[border-color,transform] duration-150 hover:-translate-y-0.5 hover:border-amber-500/40"
                  >
                    <ScoreBadge score={c.overall_score} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-medium text-white">{c.customer_name}</span>
                        <CategoryBadge category={c.category} />
                      </div>
                      <p className="mt-1 line-clamp-2 text-sm text-slate-400">{c.summary || "Processing…"}</p>
                      <p className="mt-1 font-mono text-[11px] text-slate-500">{fmtDate(c.created_at)}</p>
                    </div>
                  </Link>
                ))}
              </div>
            </Panel>
          ) },
        ]}
      />
    </>
  );
}
