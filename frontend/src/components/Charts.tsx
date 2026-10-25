import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CATEGORY_COLORS } from "@/components/common";
import { CHART, axisTick } from "@/lib/chartColors";

/** Metric bars: great = green, good = brand blue, needs work = amber, low = red. */
const scoreBand = (avg: number) => (avg >= 8.5 ? CHART.good : avg >= 7 ? CHART.brand : avg >= 5 ? CHART.warn : CHART.bad);
import type { CategoryStat, DrillQuery, HourStat, MetricStat, TopicStat, TrendPoint } from "@/lib/types";
import { chartIndex, useDrill } from "@/components/CallsDrill";

const hourLabel = (h: number) => `${((h + 11) % 12) + 1}${h < 12 ? "am" : "pm"}`;
const clickable = "cursor-pointer [&_.recharts-surface]:cursor-pointer";

const tooltipStyle = {
  contentStyle: { background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 },
  labelStyle: { color: "var(--popover-foreground)" },
  itemStyle: { color: "var(--muted-foreground)" },
};

export function CategoryDonut({ data, drill = {} }: { data: CategoryStat[]; drill?: DrillQuery }) {
  const total = data.reduce((s, d) => s + d.count, 0);
  const open = useDrill();
  const pick = (category: string) => open({ title: `${category} calls`, query: { ...drill, category } });
  return (
    <div className="grid grid-cols-1 items-center gap-4 sm:grid-cols-[180px_1fr]">
      <div className="relative h-[180px]">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="count" nameKey="category" innerRadius={58} outerRadius={84} paddingAngle={2} stroke="none" className="cursor-pointer" onClick={(d) => pick(String((d as { category?: string }).category ?? (d as { name?: string }).name))}>
              {data.map((d) => (
                <Cell key={d.category} fill={CATEGORY_COLORS[d.category] ?? "#94A3B8"} />
              ))}
            </Pie>
            <Tooltip {...tooltipStyle} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-heading text-3xl font-bold text-white">{total}</span>
          <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">calls</span>
        </div>
      </div>
      <ul className="space-y-2" data-testid="category-breakdown-list">
        {data.map((d) => (
          <li key={d.category}>
            <button type="button" data-testid={`category-drill-${d.category.replace(/[^a-z]+/gi, "-").toLowerCase()}`} onClick={() => pick(d.category)} className="flex w-full items-center justify-between gap-3 rounded px-1 text-sm transition-colors duration-150 hover:bg-slate-800/50">
            <span className="flex items-center gap-2 text-slate-300">
              <span className="size-2.5 rounded-sm" style={{ backgroundColor: CATEGORY_COLORS[d.category] }} />
              {d.category}
            </span>
            <span className="font-mono text-xs text-slate-400">
              {d.count} · <span className="text-slate-200">{d.avg_score}</span> avg
            </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ScoreTrend({ data, drill = {} }: { data: TrendPoint[]; drill?: DrillQuery }) {
  const open = useDrill();
  const onClick = (e: unknown) => {
    const p = data[chartIndex(e) ?? -1];
    if (p) open({ title: `Calls on ${new Date(`${p.date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}`, subtitle: `avg score ${p.avg_score}`, query: { ...drill, date: p.date } });
  };
  return (
    <div className={`h-[220px] ${clickable}`} data-testid="score-trend-chart">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, left: -20, bottom: 0 }} onClick={onClick}>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis dataKey="date" tick={axisTick} tickFormatter={(d: string) => d.slice(5)} axisLine={false} tickLine={false} />
          <YAxis domain={[0, 100]} tick={axisTick} axisLine={false} tickLine={false} />
          <Tooltip {...tooltipStyle} />
          <Line type="monotone" dataKey="avg_score" name="Avg score" stroke={CHART.brand} strokeWidth={2.5} dot={{ r: 3, fill: CHART.brand }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function MetricRadar({ data, compare, drill = {} }: { data: MetricStat[]; compare?: MetricStat[]; drill?: DrillQuery }) {
  const rows = data.map((m, i) => ({ name: m.name.split(" ")[0], value: m.avg, team: compare?.[i]?.avg }));
  const open = useDrill();
  const onClick = (e: unknown) => {
    const m = data[chartIndex(e) ?? -1];
    if (m) open({ title: `${m.name}: scored calls`, subtitle: "weakest first", query: { ...drill, metric: m.key } });
  };
  return (
    <div className={`h-[280px] ${clickable}`} data-testid="metric-radar-chart">
      <ResponsiveContainer width="100%" height="100%">
        <RadarChart data={rows} outerRadius="72%" onClick={onClick}>
          <PolarGrid stroke={CHART.grid} />
          <PolarAngleAxis dataKey="name" tick={axisTick} />
          <PolarRadiusAxis domain={[0, 10]} tick={false} axisLine={false} />
          {compare && <Radar name="Team" dataKey="team" stroke={CHART.silver} fill={CHART.silver} fillOpacity={0.1} strokeDasharray="4 3" />}
          <Radar name="Score" dataKey="value" stroke={CHART.brand} fill={CHART.brand} fillOpacity={0.3} />
          <Tooltip {...tooltipStyle} />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function MetricBarChart({ data, drill = {} }: { data: MetricStat[]; drill?: DrillQuery }) {
  const open = useDrill();
  const onClick = (e: unknown) => {
    const m = data[chartIndex(e) ?? -1];
    if (m) open({ title: `${m.name}: scored calls`, subtitle: "weakest first", query: { ...drill, metric: m.key } });
  };
  return (
    <div className={`h-[240px] ${clickable}`} data-testid="metric-bar-chart">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ left: 20, right: 12 }} onClick={onClick}>
          <XAxis type="number" domain={[0, 10]} hide />
          <YAxis type="category" dataKey="name" width={150} tick={{ ...axisTick, fontSize: 12 }} axisLine={false} tickLine={false} />
          <Tooltip {...tooltipStyle} cursor={{ fill: CHART.cursor }} />
          <Bar dataKey="avg" name="Team avg" radius={[0, 4, 4, 0]} barSize={14}>
            {data.map((d) => (
              <Cell key={d.key} fill={scoreBand(d.avg)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function HourlyVolume({ data, drill = {} }: { data: HourStat[]; drill?: DrillQuery }) {
  const rows = data.map((h) => ({ ...h, label: `${((h.hour + 11) % 12) + 1}${h.hour < 12 ? "a" : "p"}` }));
  const open = useDrill();
  const onClick = (e: unknown) => {
    const h = data[chartIndex(e) ?? -1];
    if (h) open({ title: `Calls from ${hourLabel(h.hour)} to ${hourLabel((h.hour + 1) % 24)}`, subtitle: `${h.inbound} in · ${h.outbound} out`, query: { ...drill, hour: h.hour } });
  };
  return (
    <div className={`h-[220px] ${clickable}`} data-testid="hourly-volume-chart">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 8, left: -20, bottom: 0 }} onClick={onClick}>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis dataKey="label" tick={axisTick} axisLine={false} tickLine={false} />
          <YAxis tick={axisTick} axisLine={false} tickLine={false} />
          <Tooltip {...tooltipStyle} cursor={{ fill: CHART.cursor }} />
          <Bar dataKey="inbound" name="Inbound" stackId="v" fill={CHART.brand} />
          <Bar dataKey="outbound" name="Outbound" stackId="v" fill={CHART.silver} radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function TopicList({ data, testId, drill = {} }: { data: TopicStat[]; testId: string; drill?: DrillQuery }) {
  const max = Math.max(1, ...data.map((t) => t.count));
  const open = useDrill();
  if (!data.length) return <p className="text-sm text-slate-500">No topics yet.</p>;
  return (
    <div className="space-y-2.5" data-testid={testId}>
      {data.map((t) => (
        <button
          type="button"
          key={t.topic}
          data-testid={`${testId}-drill-${t.topic.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`}
          onClick={() => open({ title: `Calls about "${t.topic}"`, query: { ...drill, topic: t.topic } })}
          className="block w-full rounded px-1 py-0.5 text-left transition-colors duration-150 hover:bg-slate-800/50"
        >
          <div className="flex justify-between text-sm">
            <span className="text-slate-200">{t.topic}</span>
            <span className="font-mono text-xs text-slate-400">{t.count}</span>
          </div>
          <div className="mt-1 h-1 rounded-full bg-slate-800">
            <div className="h-full rounded-full bg-amber-500/80 transition-[width] duration-500" style={{ width: `${(t.count / max) * 100}%` }} />
          </div>
        </button>
      ))}
    </div>
  );
}
