import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, PhoneCall, PhoneIncoming, PhoneOutgoing, StickyNote } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CategoryBadge, Overline, Panel, ScoreBadge, StatCard, TAG_LABELS, TagBadge, fmtDate, fmtDuration, fmtMoney } from "@/components/common";
import { apiGet, apiPost, apiPut, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { CustomerNote, CustomerNoteCreate, CustomerProfile, CustomerStat, CustomerTag, CustomerTagUpdate } from "@/lib/types";

const TAG_OPTIONS: CustomerTag[] = ["body_shop", "mechanic", "fleet", "retail"];

function fmtPhone(p: string) {
  const d = p.replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p;
}

export default function CustomerProfilePage() {
  const { key = "" } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const { data, isError } = useQuery({
    queryKey: ["customer", key],
    queryFn: () => apiGet<CustomerProfile>(`/customers/${encodeURIComponent(key)}`),
  });

  const addNote = useMutation({
    mutationFn: () => apiPost<CustomerNote>(`/customers/${encodeURIComponent(key)}/notes`, { text: note } satisfies CustomerNoteCreate),
    onSuccess: () => {
      setNote("");
      toast.success("Note saved");
      qc.invalidateQueries({ queryKey: ["customer", key] });
    },
    onError: (e) => toast.error(errorMessage(e, "Could not save note")),
  });

  const setTag = useMutation({
    mutationFn: (tag: CustomerTag | null) => apiPut<CustomerStat>(`/customers/${encodeURIComponent(key)}/tag`, { tag } satisfies CustomerTagUpdate),
    onSuccess: (st) => {
      toast.success(st.tag_source === "manual" ? `Tagged as ${TAG_LABELS[st.tag]}` : "Tag cleared");
      qc.invalidateQueries({ queryKey: ["customer", key] });
      qc.invalidateQueries({ queryKey: ["customers"] });
    },
    onError: (e) => toast.error(errorMessage(e, "Could not save tag")),
  });

  const back = (
    <button data-testid="customer-back" onClick={() => nav(-1)} className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-white">
      <ArrowLeft className="size-4" /> Back
    </button>
  );
  if (isError) return <>{back}<Panel testId="customer-not-found">Customer not found.</Panel></>;
  if (!data) return <>{back}<div className="h-40 animate-pulse rounded-xl bg-card" /></>;

  const { stat, calls, notes } = data;
  const scored = calls.filter((c) => c.overall_score > 0);
  const avg = scored.length ? Math.round(scored.reduce((n, c) => n + c.overall_score, 0) / scored.length) : 0;
  const tel = stat.phone.replace(/\D/g, "").slice(-10);
  const reps = stat.rep_names.map((n) => ({ name: n, calls: calls.filter((c) => c.rep_name === n).length }));

  return (
    <>
      {back}
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <Overline>Customer profile</Overline>
          <h1 data-testid="customer-profile-name" className="mt-2 text-3xl font-bold text-white md:text-4xl">{stat.name}</h1>
          <p className="mt-2 font-mono text-sm text-slate-400">
            {stat.phone ? fmtPhone(stat.phone) : "No phone"} · last call {fmtDate(stat.last_call_at)}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="customer-tag-picker">
            <TagBadge tag={stat.tag} auto={stat.tag_source === "auto"} testId="customer-profile-tag" />
            <span className="mx-1 text-slate-600">|</span>
            {TAG_OPTIONS.map((t) => (
              <button
                key={t}
                data-testid={`customer-set-tag-${t}`}
                disabled={setTag.isPending}
                onClick={() => setTag.mutate(t)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs transition-colors duration-150",
                  stat.tag === t && stat.tag_source === "manual" ? "border-amber-500 bg-amber-500/15 text-amber-300" : "border-slate-700 text-slate-400 hover:text-white",
                )}
              >
                {TAG_LABELS[t]}
              </button>
            ))}
            {stat.tag_source === "manual" && (
              <button data-testid="customer-clear-tag" onClick={() => setTag.mutate(null)} className="text-xs text-slate-500 hover:text-red-300">
                clear
              </button>
            )}
          </div>
        </div>
        {tel.length === 10 && (
          <a href={`tel:+1${tel}`} data-testid="customer-profile-call" className="inline-flex h-11 items-center gap-2 rounded-lg bg-amber-500 px-5 font-semibold text-primary-foreground transition-colors duration-150 hover:bg-amber-400">
            <PhoneCall className="size-4" /> Call {fmtPhone(stat.phone)}
          </a>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Calls" value={stat.calls} testId="customer-stat-calls" />
        <StatCard label="Orders" value={stat.orders} sub={stat.calls ? `${Math.round((100 * stat.orders) / stat.calls)}% of calls` : ""} testId="customer-stat-orders" accent />
        <StatCard
          label="Account value"
          value={stat.est_value ? fmtMoney(stat.est_value) : "—"}
          sub={stat.value_basis === "ai" ? "from AI-scored calls" : stat.value_basis ? `est. · ${fmtDuration(stat.talk_sec)} talk time` : `${fmtDuration(stat.talk_sec)} talk time`}
          testId="customer-stat-value"
        />
        <StatCard label="Avg call score" value={avg || "—"} testId="customer-stat-score" />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-12">
        <Panel className="xl:col-span-8" testId="customer-calls-panel">
          <h3 className="mb-4 text-xl font-bold text-white">Call history</h3>
          <div className="divide-y divide-border">
            {calls.map((c) => (
              <Link key={c.id} to={`/calls/${c.id}`} data-testid={`customer-call-${c.id}`} className="flex flex-wrap items-center gap-4 py-3 transition-colors duration-150 hover:bg-slate-800/30">
                {c.direction === "outbound" ? <PhoneOutgoing className="size-4 text-sky-400" /> : <PhoneIncoming className="size-4 text-amber-400" />}
                <ScoreBadge score={c.overall_score} />
                <div className="min-w-[200px] flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <CategoryBadge category={c.category} />
                    {c.outcome === "won" && <span className="font-mono text-[10px] uppercase text-emerald-400">order{c.order_value ? ` · ${fmtMoney(c.order_value)}` : ""}</span>}
                  </div>
                  <p className="mt-1 text-sm text-slate-400">{c.topics.slice(0, 3).join(", ") || c.summary || "—"}</p>
                </div>
                <span className="text-sm text-slate-300">{c.rep_name}</span>
                <span className="w-12 text-right font-mono text-xs text-slate-400">{c.duration_sec ? fmtDuration(c.duration_sec) : "—"}</span>
                <span className="w-32 text-right font-mono text-xs text-slate-500">{fmtDate(c.created_at)}</span>
              </Link>
            ))}
          </div>
        </Panel>

        <div className="space-y-6 xl:col-span-4">
          <Panel testId="customer-reps-panel">
            <Overline>Reps they talk to</Overline>
            <ul className="mt-3 space-y-2">
              {reps.map((r) => (
                <li key={r.name} className="flex justify-between text-sm">
                  <span className="text-slate-200">{r.name}</span>
                  <span className="font-mono text-xs text-slate-400">{r.calls} calls</span>
                </li>
              ))}
            </ul>
            {stat.top_topics.length > 0 && (
              <>
                <Overline className="mb-2 mt-5">Topics</Overline>
                <div className="flex flex-wrap gap-1.5" data-testid="customer-topics">
                  {stat.top_topics.map((t) => (
                    <span key={t} className="rounded border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-xs text-sky-200">{t}</span>
                  ))}
                </div>
              </>
            )}
          </Panel>

          <Panel testId="customer-notes-panel">
            <div className="flex items-center gap-2">
              <StickyNote className="size-4 text-amber-400" />
              <h3 className="font-bold text-white">Notes</h3>
            </div>
            <Textarea
              data-testid="customer-note-input"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Prefers freight on Tuesdays, asks for Rich"
              className="mt-3 min-h-[80px] bg-surface"
            />
            <div className="mt-2 flex justify-end">
              <Button size="sm" data-testid="customer-note-save" disabled={!note.trim() || addNote.isPending} onClick={() => addNote.mutate()}>
                {addNote.isPending && <Loader2 className="size-4 animate-spin" />} Save note
              </Button>
            </div>
            <ul className="mt-4 space-y-3" data-testid="customer-notes-list">
              {notes.map((n) => (
                <li key={n.id} className="rounded-lg border border-border bg-surface p-3">
                  <p className="text-sm text-slate-200">{n.text}</p>
                  <p className="mt-1 font-mono text-[11px] text-slate-500">{n.author} · {fmtDate(n.created_at)}</p>
                </li>
              ))}
              {!notes.length && <p className="text-sm text-slate-500">No notes yet.</p>}
            </ul>
          </Panel>
        </div>
      </div>
    </>
  );
}
