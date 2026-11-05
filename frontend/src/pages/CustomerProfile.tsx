import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, PhoneCall, PhoneIncoming, PhoneOutgoing, Save, StickyNote } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CategoryBadge, Overline, Panel, ScoreBadge, StatCard, TAG_LABELS, TagBadge, fmtDate, fmtDuration, fmtMoney } from "@/components/common";
import { apiGet, apiPost, apiPut, errorMessage } from "@/lib/api";
import { useMe } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import type { CustomerNote, CustomerNoteCreate, CustomerProfile, CustomerProfileUpdate, CustomerStat, CustomerTag, CustomerTagUpdate } from "@/lib/types";

const TAG_OPTIONS: CustomerTag[] = ["body_shop", "mechanic", "fleet", "retail", "dealership", "driver", "adjuster", "other"];

function fmtPhone(p: string) {
  const raw = String(p ?? "");
  const d = raw.replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : raw;
}

export default function CustomerProfilePage() {
  const { key = "" } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { data: me } = useMe();
  // Reps add or correct customer details while they are on the call, not just managers.
  const canEdit = Boolean(me);
  const [note, setNote] = useState("");
  const [details, setDetails] = useState<CustomerProfileUpdate>({ name: "", email: "", alt_phones: [], alt_emails: [], text_ok: null });
  const { data, isError } = useQuery({
    queryKey: ["customer", key],
    queryFn: () => apiGet<CustomerProfile>(`/customers/${encodeURIComponent(key)}`),
  });

  useEffect(() => {
    if (!data) return;
    setDetails({
      name: data.stat.name ?? "",
      email: data.stat.email ?? "",
      alt_phones: data.stat.alt_phones ?? [],
      alt_emails: data.stat.alt_emails ?? [],
      text_ok: data.stat.text_ok ?? null,
    });
  }, [
    data?.stat.key,
    data?.stat.name,
    data?.stat.email,
    data?.stat.alt_phones,
    data?.stat.alt_emails,
    data?.stat.text_ok,
  ]);

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
      qc.invalidateQueries({ queryKey: ["customers"], refetchType: "all" });
    },
    onError: (e) => toast.error(errorMessage(e, "Could not save tag")),
  });

  const saveDetails = useMutation({
    mutationFn: () => apiPut<CustomerStat>(`/customers/${encodeURIComponent(key)}/profile`, details),
    onSuccess: () => {
      toast.success("Customer details saved");
      qc.invalidateQueries({ queryKey: ["customer", key] });
      qc.invalidateQueries({ queryKey: ["customers"], refetchType: "all" });
    },
    onError: (e) => toast.error(errorMessage(e, "Could not save customer details")),
  });

  const back = (
    <button data-testid="customer-back" onClick={() => nav(-1)} className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-white">
      <ArrowLeft className="size-4" /> Back
    </button>
  );
  if (isError) return <>{back}<Panel testId="customer-not-found">Customer not found.</Panel></>;
  if (!data) return <>{back}<div className="h-40 animate-pulse rounded-xl bg-card" /></>;

  const { stat, calls, notes } = data;
  const scored = calls.filter((c) => (c.overall_score ?? 0) > 0);
  const avg = scored.length ? Math.round(scored.reduce((n, c) => n + (c.overall_score ?? 0), 0) / scored.length) : 0;
  const tel = String(stat.phone ?? "").replace(/\D/g, "").slice(-10);
  const reps = (stat.rep_names ?? []).map((n) => ({ name: n, calls: (calls ?? []).filter((c) => c.rep_name === n).length }));

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
          {(stat.email || stat.text_ok === false) && (
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-400">
              {stat.email && <span data-testid="customer-profile-email">{stat.email}</span>}
              {stat.text_ok === false && (
                <span className="rounded border border-red-500/40 bg-red-500/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-red-300">
                  No text
                </span>
              )}
            </p>
          )}
          {((stat.alt_phones ?? []).length > 0 || (stat.alt_emails ?? []).length > 0) && (
            <p data-testid="customer-profile-alternates" className="mt-1 text-sm text-slate-400">
              Also: {[...(stat.alt_phones ?? []), ...(stat.alt_emails ?? [])].join(" · ")}
            </p>
          )}
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
                  <p className="mt-1 text-sm text-slate-400">{(c.topics ?? []).slice(0, 3).join(", ") || c.summary || "—"}</p>
                </div>
                <span className="text-sm text-slate-300">{c.rep_name}</span>
                <span className="w-12 text-right font-mono text-xs text-slate-400">{c.duration_sec ? fmtDuration(c.duration_sec) : "—"}</span>
                <span className="w-32 text-right font-mono text-xs text-slate-500">{fmtDate(c.created_at)}</span>
              </Link>
            ))}
          </div>
        </Panel>

        <div className="space-y-6 xl:col-span-4">
          {canEdit && (
            <Panel testId="customer-details-panel">
              <Overline>Customer details</Overline>
              <p className="mt-1 text-sm text-slate-400">Add a name, email, and whether this number can receive texts.</p>
              <div className="mt-4 space-y-3">
                <label className="block text-sm">
                  <span className="mb-1 block text-slate-300">Name</span>
                  <Input
                    data-testid="customer-detail-name"
                    value={details.name}
                    onChange={(e) => setDetails((d) => ({ ...d, name: e.target.value }))}
                    placeholder="Customer or business name"
                    className="bg-surface"
                  />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-slate-300">Email</span>
                  <Input
                    data-testid="customer-detail-email"
                    type="email"
                    value={details.email}
                    onChange={(e) => setDetails((d) => ({ ...d, email: e.target.value }))}
                    placeholder="name@company.com"
                    className="bg-surface"
                  />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-slate-300">Alternate phone numbers</span>
                  <Textarea
                    data-testid="customer-detail-alt-phones"
                    value={details.alt_phones.join("\n")}
                    onChange={(e) => setDetails((d) => ({ ...d, alt_phones: e.target.value.split(/[\n,]+/) }))}
                    placeholder={"One number per line\n(555) 123-4567"}
                    className="min-h-[70px] bg-surface font-mono text-sm"
                  />
                  <span className="mt-1 block text-xs text-slate-500">Calls from these numbers will be grouped into this profile.</span>
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-slate-300">Alternate emails</span>
                  <Textarea
                    data-testid="customer-detail-alt-emails"
                    value={details.alt_emails.join("\n")}
                    onChange={(e) => setDetails((d) => ({ ...d, alt_emails: e.target.value.split(/[\n,]+/) }))}
                    placeholder={"One email per line\nparts@company.com"}
                    className="min-h-[70px] bg-surface font-mono text-sm"
                  />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-slate-300">Texting</span>
                  <select
                    data-testid="customer-detail-text-ok"
                    value={details.text_ok === null ? "unknown" : details.text_ok ? "yes" : "no"}
                    onChange={(e) =>
                      setDetails((d) => ({
                        ...d,
                        text_ok: e.target.value === "unknown" ? null : e.target.value === "yes",
                      }))
                    }
                    className="h-9 w-full rounded-md border border-border bg-surface px-2 text-sm text-slate-200"
                  >
                    <option value="unknown">Not set — do not text</option>
                    <option value="yes">Can text this number</option>
                    <option value="no">Cannot text this number</option>
                  </select>
                </label>
              </div>
              <div className="mt-4 flex justify-end">
                <Button size="sm" data-testid="customer-detail-save" disabled={saveDetails.isPending} onClick={() => saveDetails.mutate()}>
                  {saveDetails.isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Save details
                </Button>
              </div>
            </Panel>
          )}

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
            {(stat.top_topics ?? []).length > 0 && (
              <>
                <Overline className="mb-2 mt-5">Topics</Overline>
                <div className="flex flex-wrap gap-1.5" data-testid="customer-topics">
                  {(stat.top_topics ?? []).map((t) => (
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
