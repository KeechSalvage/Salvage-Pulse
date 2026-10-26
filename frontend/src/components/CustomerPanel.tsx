import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, DollarSign, List, MessageSquareQuote, PhoneCall, RotateCcw, ShoppingCart, Sparkles, Users } from "lucide-react";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";
import { CategoryBadge, Overline, Panel, TAG_LABELS, TagBadge, fmtDate, fmtMoney } from "@/components/common";
import { apiGet, apiPost, errorMessage } from "@/lib/api";
import { useMe } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { OUTCOMES } from "@/components/WinBackResults";
import type { BulkTagResult, BulkTagUpdate, CustomerInsights, CustomerStat, CustomerTag, SuggestedContact, WinBackMark, WinBackOutcome, WinBackResult } from "@/lib/types";
import { isManagerLike } from "@/lib/types";

type Tab = "suggested" | "value" | "calls" | "orders" | "winback" | "all";
const BULK_TAGS: CustomerTag[] = ["body_shop", "mechanic", "fleet", "retail"];

const TABS: { id: Tab; label: string; icon: typeof Users }[] = [
  { id: "suggested", label: "Suggested", icon: Sparkles },
  { id: "value", label: "Top value", icon: DollarSign },
  { id: "calls", label: "Most calls", icon: PhoneCall },
  { id: "orders", label: "Most orders", icon: ShoppingCart },
  { id: "winback", label: "Win-back", icon: RotateCcw },
  { id: "all", label: "All customers", icon: List },
];

const TAG_FILTERS = ["all", "body_shop", "mechanic", "fleet", "retail", "untagged"];

const PRIORITY: Record<SuggestedContact["priority"], string> = {
  high: "border-red-500/40 text-red-300 bg-red-500/10",
  medium: "border-amber-500/40 text-amber-300 bg-amber-500/10",
  low: "border-slate-600 text-slate-300 bg-slate-500/10",
};

const BASIS: Record<string, string> = { ai: "from AI-scored calls", mixed: "partly estimated", estimated: "estimated" };

function telHref(phone: string) {
  const d = phone.replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `tel:+1${d}` : undefined;
}

function WinBackActions({ c, rank }: { c: SuggestedContact; rank: number }) {
  const qc = useQueryClient();
  const mark = useMutation({
    mutationFn: (outcome: WinBackResult) => apiPost<WinBackOutcome>(`/customers/${encodeURIComponent(c.key)}/winback`, { outcome } satisfies WinBackMark),
    onSuccess: (m) => {
      toast.success(`${m.customer_name} marked ${OUTCOMES.find((o) => o.id === m.outcome)?.label.toLowerCase()} — back on the list in 14 days if still quiet`);
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["winback-results"] });
    },
    onError: (e) => toast.error(errorMessage(e, "Couldn't save the result")),
  });
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <span className="font-mono text-[11px] uppercase tracking-wider text-slate-500">Result</span>
      {OUTCOMES.map((o) => (
        <button
          key={o.id}
          data-testid={`winback-mark-${o.id}-${rank}`}
          disabled={mark.isPending}
          onClick={() => mark.mutate(o.id)}
          className={cn("rounded-full border px-3 py-1 text-xs font-medium transition-colors duration-150 disabled:opacity-50", o.cls)}
        >
          {o.label}
        </button>
      ))}
      {c.last_mark && <span data-testid={`winback-last-mark-${rank}`} className="text-xs text-slate-500">{c.last_mark}</span>}
    </div>
  );
}

type Contact = CustomerStat | SuggestedContact;
type RowProps = { c: Contact; rank: number; tab: Tab; team: boolean; selected?: boolean; onToggle?: () => void };

function Row({ c, rank, tab, team, selected, onToggle }: RowProps) {
  return (
    <div data-testid={`customer-row-${tab}-${rank}`} className={cn("flex flex-wrap items-center gap-4 py-3", selected && "bg-amber-500/[0.04]")}>
      {onToggle && <Checkbox data-testid={`customer-select-${tab}-${rank}`} checked={!!selected} onCheckedChange={onToggle} />}
      <span className="w-6 font-mono text-sm text-slate-500">{String(rank + 1).padStart(2, "0")}</span>
      <RowIdentity c={c} rank={rank} tab={tab} team={team} />
      <RowStats c={c} rank={rank} tab={tab} />
      <CallButton phone={c.phone} testId={`customer-call-${tab}-${rank}`} />
    </div>
  );
}

function RowIdentity({ c, rank, tab, team }: Omit<RowProps, "selected" | "onToggle">) {
  const s = "reason" in c ? c : null;
  return (
    <div className="min-w-[200px] flex-1">
      <div className="flex flex-wrap items-center gap-2">
        <Link to={`/customers/${encodeURIComponent(c.key)}`} data-testid={`customer-name-${tab}-${rank}`} className="font-medium text-white hover:underline">
          {c.name}
        </Link>
        <TagBadge tag={c.tag} auto={c.tag_source === "auto"} testId={`customer-tag-${tab}-${rank}`} />
        {s ? (
          <span className={cn("rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider", PRIORITY[s.priority])}>{s.priority}</span>
        ) : (
          <CategoryBadge category={c.last_category} />
        )}
      </div>
      <p className="mt-1 text-sm text-slate-400">{s ? s.reason : c.top_topics.slice(0, 3).join(", ") || "—"}</p>
      {s?.opener && <OpenerLine opener={s.opener} testId={`customer-opener-${tab}-${rank}`} />}
      {s && tab === "winback" && <WinBackActions c={s} rank={rank} />}
      {team && c.rep_names.length > 0 && (
        <p data-testid={`customer-reps-${tab}-${rank}`} className="mt-0.5 font-mono text-[11px] text-slate-500">
          {c.rep_names.slice(0, 3).join(" · ")}
        </p>
      )}
    </div>
  );
}

function OpenerLine({ opener, testId }: { opener: string; testId: string }) {
  const copy = () => navigator.clipboard.writeText(opener).then(() => toast.success("Opening line copied"), () => toast.error("Couldn't copy"));
  return (
    <div data-testid={testId} className="mt-2 flex items-start gap-2 rounded-md border-l-2 border-amber-500/60 bg-amber-500/[0.05] py-2 pl-3 pr-2">
      <MessageSquareQuote className="mt-0.5 size-3.5 shrink-0 text-amber-400" />
      <p className="flex-1 text-sm italic text-slate-200">&ldquo;{opener}&rdquo;</p>
      <button data-testid={`${testId.replace("customer-opener-", "customer-opener-copy-")}`} title="Copy opening line" onClick={copy} className="rounded p-1 text-slate-400 transition-colors duration-150 hover:bg-slate-800 hover:text-white">
        <Copy className="size-3.5" />
      </button>
    </div>
  );
}

function Stat({ value, label, testId, highlight }: { value: ReactNode; label: string; testId: string; highlight?: string }) {
  return (
    <div className="text-right">
      <p data-testid={testId} className={cn("text-base", highlight ?? "text-slate-200")}>{value}</p>
      <p className="text-slate-500">{label}</p>
    </div>
  );
}

function RowStats({ c, rank, tab }: { c: Contact; rank: number; tab: Tab }) {
  return (
    <div className="flex gap-5 font-mono text-xs">
      <div className="w-20" title={BASIS[c.value_basis] ?? ""}>
        <Stat
          value={c.est_value ? fmtMoney(c.est_value) : "—"}
          label={c.value_basis === "ai" ? "value" : "est. value"}
          testId={`customer-value-${tab}-${rank}`}
          highlight={tab === "value" ? "text-amber-300" : undefined}
        />
      </div>
      <Stat value={c.calls} label="calls" testId={`customer-calls-${tab}-${rank}`} highlight={tab === "calls" ? "text-amber-300" : undefined} />
      <Stat value={c.orders} label="orders" testId={`customer-orders-${tab}-${rank}`} highlight={tab === "orders" ? "text-emerald-300" : undefined} />
      <div className="hidden w-24 text-right lg:block">
        <p className="text-slate-300">{fmtDate(c.last_call_at)}</p>
        <p className="text-slate-500">last call</p>
      </div>
    </div>
  );
}

function CallButton({ phone, testId }: { phone: string; testId: string }) {
  const href = telHref(phone);
  return (
    <a
      href={href}
      data-testid={testId}
      className={cn(
        "flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors duration-150",
        href ? "border-amber-500/40 text-amber-300 hover:bg-amber-500/10" : "pointer-events-none border-slate-800 text-slate-600",
      )}
    >
      <PhoneCall className="size-3.5" /> Call
    </a>
  );
}

const EMPTY_LISTS: Record<Tab, Contact[]> = { suggested: [], value: [], calls: [], orders: [], winback: [], all: [] };

/** Customer insights for this panel's scope + filters, bucketed by tab. */
function useCustomerLists(repId: string | undefined, team: boolean, tag: string, tab: Tab) {
  const params = new URLSearchParams();
  if (repId) params.set("rep_id", repId);
  if (tag !== "all") params.set("tag", tag);
  if (tab === "all") params.set("include_all", "true");
  const qs = params.toString();
  const { data, isError } = useQuery({
    queryKey: ["customers", team ? "team" : (repId ?? "me"), tag, tab === "all"],
    queryFn: () => apiGet<CustomerInsights>(`/analytics/customers${qs ? `?${qs}` : ""}`),
  });
  const ci = isError ? undefined : data;
  const lists: Record<Tab, Contact[]> = ci
    ? { suggested: ci.suggested, value: ci.top_value, calls: ci.most_calls, orders: ci.most_orders, winback: ci.win_back, all: ci.all_customers }
    : EMPTY_LISTS;
  return { ci, lists };
}

export default function CustomerPanel({ repId, team = false }: { repId?: string; team?: boolean }) {
  const [tab, setTab] = useState<Tab>("suggested");
  const [tag, setTag] = useState("all");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const { data: me } = useMe();
  const { ci, lists } = useCustomerLists(repId, team, tag, tab);
  const list = lists[tab];
  const pickTab = (t: Tab) => {
    setTab(t);
    setPicked(new Set());
  };
  const pickTag = (t: string) => {
    setTag(t);
    setPicked(new Set());
  };
  const toggle = (k: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const canBulk = isManagerLike(me?.role);

  return (
    <Panel className="xl:col-span-12" testId="customer-panel">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <PanelTitle ci={ci} team={team} />
        <TabBar tab={tab} lists={lists} onPick={pickTab} />
      </div>
      <TypeFilters tag={tag} onPick={pickTag} />
      {ci && tag === "all" && ci.type_breakdown.length > 0 && <TypeBreakdown ci={ci} onPick={pickTag} />}
      <TabHint tab={tab} />
      {canBulk && <BulkTagBar tab={tab} list={list} picked={picked} setPicked={setPicked} />}
      <div className={cn("divide-y divide-border", tab === "all" && "max-h-[640px] overflow-y-auto pr-1")} data-testid={`customer-list-${tab}`}>
        {list.map((c, i) => (
          <Row key={c.key} c={c} rank={i} tab={tab} team={team} selected={picked.has(c.key)} onToggle={canBulk ? () => toggle(c.key) : undefined} />
        ))}
        {ci && list.length === 0 && (
          <p data-testid="customer-list-empty" className="py-6 text-sm text-slate-500">
            {tab === "winback" ? "No repeat buyers have gone 30+ days without a call. Your call history only covers the last few days so far." : "Nothing here yet."}
          </p>
        )}
        {!ci && <p className="py-6 text-sm text-slate-500">Customer data unavailable.</p>}
      </div>
    </Panel>
  );
}

const AVG_BASIS: Record<string, string> = { ai: "(from AI-scored calls)", manager: "(set by manager)" };

function PanelTitle({ ci, team }: { ci?: CustomerInsights; team: boolean }) {
  return (
    <div>
      <Overline>Top customers</Overline>
      <h3 className="mt-1 text-xl font-bold text-white">{team ? "The yard's biggest accounts — and who to call next" : "Who you talk to — and who to call next"}</h3>
      {ci && (
        <p data-testid="customer-summary" className="mt-1 text-sm text-slate-400">
          {ci.total_customers} customers · {ci.repeat_customers} called more than once · avg order{" "}
          <span data-testid="customer-avg-order" className="text-slate-200">{fmtMoney(ci.avg_order_value)}</span>{" "}
          {AVG_BASIS[ci.avg_order_basis] ?? "(default — set yours on the Reps page)"}
        </p>
      )}
    </div>
  );
}

function TabBar({ tab, lists, onPick }: { tab: Tab; lists: Record<Tab, Contact[]>; onPick: (t: Tab) => void }) {
  return (
    <div className="flex flex-wrap gap-1 rounded-lg bg-surface p-1">
      {TABS.map((t) => {
        const count = t.id === "suggested" || t.id === "winback" ? lists[t.id].length : 0;
        return (
          <button
            key={t.id}
            data-testid={`customer-tab-${t.id}`}
            onClick={() => onPick(t.id)}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors duration-150",
              tab === t.id ? "bg-amber-500 text-primary-foreground" : "text-slate-400 hover:text-white",
            )}
          >
            <t.icon className="size-3.5" />
            {t.label}
            {count > 0 && <span className={cn("ml-1 rounded-full px-1.5 font-mono text-[10px]", tab === t.id ? "bg-background/20" : "bg-red-500 text-white")}>{count}</span>}
          </button>
        );
      })}
    </div>
  );
}

function TypeFilters({ tag, onPick }: { tag: string; onPick: (t: string) => void }) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2" data-testid="customer-type-filters">
      <span className="font-mono text-[11px] uppercase tracking-wider text-slate-500">Type</span>
      {TAG_FILTERS.map((t) => (
        <button
          key={t}
          data-testid={`customer-type-filter-${t}`}
          onClick={() => onPick(t)}
          className={cn(
            "rounded-full border px-3 py-1 text-xs font-medium transition-colors duration-150",
            tag === t ? "border-amber-500 bg-amber-500/15 text-amber-300" : "border-slate-700 text-slate-400 hover:text-white",
          )}
        >
          {t === "all" ? "All types" : TAG_LABELS[t]}
        </button>
      ))}
    </div>
  );
}

function TypeBreakdown({ ci, onPick }: { ci: CustomerInsights; onPick: (t: string) => void }) {
  return (
    <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-5" data-testid="customer-type-breakdown">
      {ci.type_breakdown.map((t) => (
        <button
          key={t.tag}
          data-testid={`customer-type-card-${t.tag}`}
          onClick={() => onPick(t.tag)}
          className="rounded-lg border border-border bg-surface p-3 text-left transition-colors duration-150 hover:border-amber-500/40"
        >
          <TagBadge tag={t.tag === "untagged" ? "" : t.tag} />
          <p className="mt-2 font-heading text-xl font-bold text-white">{fmtMoney(t.est_value)}</p>
          <p className="font-mono text-[11px] text-slate-500">
            {t.customers} cust · {t.orders} orders
          </p>
        </button>
      ))}
    </div>
  );
}

const TAB_HINTS: Partial<Record<Tab, string>> = {
  suggested: "Ranked by urgency, then account value: unreturned missed calls and fresh quotes with no order first, then frequent callers who haven't bought.",
  winback:
    "Repeat buyers (2+ orders) with no call in 30+ days. Each has a suggested opening line based on what they bought before (also in the daily follow-up email). Mark the result after calling — they drop off for 14 days, then come back if still quiet.",
  value: "Order value comes from AI-scored calls; orders without a transcript use the average order value.",
};

function TabHint({ tab }: { tab: Tab }) {
  const hint = TAB_HINTS[tab];
  return hint ? <p className="mb-2 text-xs text-slate-500">{hint}</p> : null;
}

function BulkTagBar({ tab, list, picked, setPicked }: { tab: Tab; list: Contact[]; picked: Set<string>; setPicked: (s: Set<string>) => void }) {
  const qc = useQueryClient();
  const bulk = useMutation({
    mutationFn: (t: CustomerTag | null) => apiPost<BulkTagResult>("/customers/bulk-tag", { keys: [...picked], tag: t } satisfies BulkTagUpdate),
    onSuccess: (r, t) => {
      toast.success(t ? `Tagged ${r.updated} customers as ${TAG_LABELS[t]}` : `Cleared tags on ${r.updated} customers`);
      setPicked(new Set());
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["customer"] });
    },
    onError: (e) => toast.error(errorMessage(e, "Bulk tag failed")),
  });
  const allPicked = picked.size === list.length && list.length > 0;
  return (
    <div data-testid="bulk-tag-bar" className="sticky top-0 z-10 mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface/95 px-3 py-2 backdrop-blur">
      <button
        data-testid="bulk-select-all"
        onClick={() => setPicked(picked.size === list.length ? new Set() : new Set(list.map((c) => c.key)))}
        className="text-xs text-sky-400 hover:underline"
      >
        {allPicked ? "Clear selection" : `Select all ${list.length} shown`}
      </button>
      <span data-testid="bulk-selected-count" className="font-mono text-xs text-slate-400">{picked.size} selected</span>
      {picked.size > 0 && (
        <>
          <span className="ml-2 text-xs text-slate-500">Tag as</span>
          {BULK_TAGS.map((t) => (
            <button
              key={t}
              data-testid={`bulk-tag-${t}`}
              disabled={bulk.isPending}
              onClick={() => bulk.mutate(t)}
              className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-200 transition-colors duration-150 hover:border-amber-500 hover:text-amber-300"
            >
              {TAG_LABELS[t]}
            </button>
          ))}
          <button data-testid="bulk-tag-clear" disabled={bulk.isPending} onClick={() => bulk.mutate(null)} className="text-xs text-slate-500 hover:text-red-300">
            Clear tags
          </button>
        </>
      )}
      {tab !== "all" && <span className="ml-auto text-[11px] text-slate-500">Tip: use "All customers" + a type filter (e.g. Untagged) to tag in bulk</span>}
    </div>
  );
}
