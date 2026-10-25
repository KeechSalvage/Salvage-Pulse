import type { ReactNode } from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import type { MetricDef, Outcome } from "@/lib/types";

export const CATEGORY_COLORS: Record<string, string> = {
  "Part Inquiry/Quote": "#38BDF8",
  "Price Negotiation": "#FBBF24",
  "Order/Sale": "#34D399",
  "Shipping/Delivery": "#A78BFA",
  "Warranty/Return": "#F472B6",
  "Core Return": "#818CF8",
  Other: "#94A3B8",
};

export function scoreTier(score: number) {
  if (score >= 85) return { color: "#10B981", label: "Exceptional" };
  if (score >= 70) return { color: "#3B82F6", label: "Proficient" };
  if (score >= 50) return { color: "var(--color-amber-500)", label: "Needs Coaching" };
  return { color: "#EF4444", label: "Action Required" };
}

export function ScoreBadge({ score, testId, size = "sm" }: { score: number; testId?: string; size?: "sm" | "lg" }) {
  const t = scoreTier(score);
  return (
    <span
      data-testid={testId}
      className={cn(
        "inline-flex items-center justify-center rounded-md font-mono font-medium tabular-nums",
        size === "lg" ? "h-20 w-20 text-3xl" : "h-7 min-w-10 px-2 text-sm",
        score >= 90 && "score-glow",
      )}
      style={{ color: t.color, backgroundColor: `${t.color}1f`, border: `1px solid ${t.color}55` }}
      title={t.label}
    >
      {score}
    </span>
  );
}

export function CategoryBadge({ category, testId }: { category: string; testId?: string }) {
  const c = CATEGORY_COLORS[category] ?? CATEGORY_COLORS.Other;
  return (
    <span
      data-testid={testId}
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium"
      style={{ color: c, backgroundColor: `${c}18`, border: `1px solid ${c}40` }}
    >
      <span className="size-1.5 rounded-full" style={{ backgroundColor: c }} />
      {category}
    </span>
  );
}

const OUTCOME_STYLE: Record<Outcome, string> = {
  won: "text-emerald-400 bg-emerald-500/10 border-emerald-500/30",
  lost: "text-red-400 bg-red-500/10 border-red-500/30",
  pending: "text-amber-300 bg-amber-500/10 border-amber-500/30",
  "n/a": "text-slate-400 bg-slate-500/10 border-slate-500/30",
};

export function OutcomeBadge({ outcome, testId }: { outcome: Outcome; testId?: string }) {
  return (
    <span data-testid={testId} className={cn("rounded border px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider", OUTCOME_STYLE[outcome])}>
      {outcome}
    </span>
  );
}

export function Overline({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("font-mono text-[11px] uppercase tracking-[0.14em] text-amber-400/90", className)}>{children}</p>;
}

export function PageHeader({ overline, title, children }: { overline: string; title: string; children?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <Overline>{overline}</Overline>
        <h1 data-testid="page-title" className="mt-2 text-3xl font-bold text-white md:text-4xl">
          {title}
        </h1>
      </div>
      {children}
    </div>
  );
}

export function Panel({ children, className, testId }: { children: ReactNode; className?: string; testId?: string }) {
  return (
    <div data-testid={testId} className={cn("rounded-xl border border-border bg-card p-5 md:p-6", className)}>
      {children}
    </div>
  );
}

export function StatCard({
  label,
  value,
  sub,
  testId,
  accent,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  testId: string;
  accent?: boolean;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      className={cn(
        "relative overflow-hidden rounded-xl border bg-surface p-5 transition-transform duration-150 hover:-translate-y-0.5",
        accent ? "border-amber-500/40" : "border-border",
      )}
    >
      {accent && <div className="absolute inset-x-0 top-0 h-0.5 bg-amber-500" />}
      <Overline className="text-slate-400">{label}</Overline>
      <p data-testid={testId} className="mt-3 font-heading text-4xl font-bold tabular-nums text-white">
        {value}
      </p>
      {sub && <p className="mt-1 text-sm text-slate-400">{sub}</p>}
    </motion.div>
  );
}

export function MetricBars({
  metrics,
  defs,
  testPrefix,
}: {
  metrics: Record<string, number>;
  defs: MetricDef[];
  testPrefix: string;
}) {
  return (
    <div className="space-y-3.5">
      {defs.map((d, i) => {
        const v = metrics[d.key] ?? 0;
        const t = scoreTier(v * 10);
        return (
          <div key={d.key} title={d.description}>
            <div className="mb-1.5 flex items-center justify-between text-sm">
              <span className="text-slate-300">
                {d.name} <span className="font-mono text-[11px] text-slate-500">· {d.weight}%</span>
              </span>
              <span data-testid={`${testPrefix}-${d.key}`} className="font-mono tabular-nums" style={{ color: t.color }}>
                {v}/10
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
              <motion.div
                className="h-full rounded-full"
                style={{ backgroundColor: t.color }}
                initial={{ width: 0 }}
                animate={{ width: `${v * 10}%` }}
                transition={{ duration: 0.6, delay: i * 0.05, ease: "easeOut" }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function BulletList({ items, tone, testId }: { items: string[]; tone: "good" | "bad" | "info"; testId: string }) {
  const dot = tone === "good" ? "bg-emerald-400" : tone === "bad" ? "bg-amber-400" : "bg-sky-400";
  if (!items.length) return <p className="text-sm text-slate-500">Nothing noted.</p>;
  return (
    <ul data-testid={testId} className="space-y-2.5">
      {[...new Set(items)].map((it) => (
        <li key={it} className="flex gap-3 text-[15px] leading-relaxed text-slate-300">
          <span className={cn("mt-2 size-1.5 shrink-0 rounded-full", dot)} />
          {it}
        </li>
      ))}
    </ul>
  );
}

export function EmptyState({ title, body, testId }: { title: string; body: string; testId: string }) {
  return (
    <div data-testid={testId} className="rounded-xl border border-dashed border-slate-700 p-10 text-center">
      <p className="font-heading text-lg font-semibold text-white">{title}</p>
      <p className="mt-1 text-sm text-slate-400">{body}</p>
    </div>
  );
}

export function fmtDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function fmtDuration(sec: number) {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export const TAG_LABELS: Record<string, string> = {
  body_shop: "Body shop",
  mechanic: "Mechanic",
  fleet: "Fleet",
  retail: "Retail",
  untagged: "Untagged",
};
const TAG_COLORS: Record<string, string> = { body_shop: "#F472B6", mechanic: "#38BDF8", fleet: "#A78BFA", retail: "#34D399", untagged: "#94A3B8" };

export function TagBadge({ tag, auto, testId }: { tag: string; auto?: boolean; testId?: string }) {
  const t = tag || "untagged";
  const c = TAG_COLORS[t] ?? "#94A3B8";
  return (
    <span
      data-testid={testId}
      title={auto ? "Auto-suggested from the caller name — set it on the customer page" : undefined}
      className={cn("inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider", auto && "border-dashed")}
      style={{ color: c, border: `1px ${auto ? "dashed" : "solid"} ${c}66`, backgroundColor: `${c}14` }}
    >
      {TAG_LABELS[t] ?? t}
      {auto ? " ·auto" : ""}
    </span>
  );
}

export function fmtMoney(v: number) {
  return `$${Math.round(v).toLocaleString()}`;
}
