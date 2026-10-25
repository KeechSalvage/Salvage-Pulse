import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Check, Handshake, Send, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Overline, Panel } from "@/components/common";
import { apiDelete, apiGet, apiPost, errorMessage } from "@/lib/api";
import { useMe, useReps } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import type { CoverBlock, CoverRequest, CoverRequestCreate } from "@/lib/types";

const fmt = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
const span = (r: { start: string; end: string }) => (r.start === r.end ? fmt(r.start) : `${fmt(r.start)} – ${fmt(r.end)}`);
const nDays = (r: { start: string; end: string }) => Math.round((Date.parse(r.end) - Date.parse(r.start)) / 864e5) + 1;
const sel = "h-9 rounded-md border border-border bg-surface px-2 text-sm text-white";
const STATUS: Record<CoverRequest["status"], [string, string]> = {
  pending: ["Asked", "bg-amber-500/15 text-amber-200"],
  accepted: ["Waiting for manager", "bg-sky-500/15 text-sky-200"],
  approved: ["On the calendar", "bg-emerald-500/15 text-emerald-300"],
  declined: ["Declined", "bg-red-500/15 text-red-300"],
  blocked: ["Not approved", "bg-red-500/15 text-red-300"],
  cancelled: ["Withdrawn", "bg-slate-500/15 text-slate-400"],
};

export const useCoverRequests = () => useQuery({ queryKey: ["cover-requests"], queryFn: () => apiGet<CoverRequest[]>("/cover-requests") });

function StatusPill({ r }: { r: CoverRequest }) {
  const [label, cls] = STATUS[r.status];
  return <span data-testid={`cover-status-${r.id}`} title={r.block_reason || undefined} className={cn("rounded px-2 py-0.5 text-[11px] font-medium", cls)}>{label}{r.status === "blocked" && r.block_reason ? `: ${r.block_reason}` : ""}</span>;
}

const useRefresh = () => {
  const qc = useQueryClient();
  return () => (qc.invalidateQueries({ queryKey: ["cover-requests"] }), qc.invalidateQueries({ queryKey: ["time-off"] }), qc.invalidateQueries({ queryKey: ["callbacks"] }));
};

/** Rep's My Performance: ask a teammate to cover a day or a stretch, and answer teammates' asks with one tap. */
export function CoverRequestsCard() {
  const me = useMe().data;
  const reps = useReps();
  const { data } = useCoverRequests();
  const done = useRefresh();
  const today = new Date().toLocaleDateString("en-CA");
  const blank: CoverRequestCreate = { to_rep_id: "", start: "", end: "", note: "" };
  const [f, setF] = useState<CoverRequestCreate>(blank);
  const ask = useMutation({
    mutationFn: () => apiPost<CoverRequest>("/cover-requests", { ...f, end: f.end || f.start }),
    onSuccess: (r) => (toast.success(`Asked ${r.to_rep_name} to cover ${span(r)}${r.texted ? " — they got a text" : ""}`), setF(blank), done()),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const answer = useMutation({
    mutationFn: ({ id, yes }: { id: string; yes: boolean }) => apiPost<CoverRequest>(`/cover-requests/${id}/${yes ? "accept" : "decline"}`),
    onSuccess: (r) => (r.status === "accepted" ? toast.success(`Thanks! Covering ${r.from_rep_name.split(" ")[0]} ${span(r)} once a manager approves`) : toast(`${r.from_rep_name.split(" ")[0]} will see you can't cover`), done()),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const cancel = useMutation({ mutationFn: (id: string) => apiDelete(`/cover-requests/${id}`), onSuccess: () => (toast("Request withdrawn"), done()), onError: (e) => toast.error(errorMessage(e)) });
  if (!me || me.role !== "rep") return null;
  const incoming = (data ?? []).filter((r) => r.to_rep_id === me.id && r.status === "pending");
  const covering = (data ?? []).filter((r) => r.to_rep_id === me.id && (r.status === "accepted" || r.status === "approved"));
  const sent = (data ?? []).filter((r) => r.from_rep_id === me.id && r.status !== "cancelled");
  const mates = (reps.data ?? []).filter((r) => r.id !== me.id);
  return (
    <Panel testId="cover-requests-card" className="mb-6">
      <div className="flex items-center gap-2">
        <Handshake className="size-4 text-emerald-300" />
        <Overline>Cover swaps</Overline>
      </div>
      {incoming.length > 0 && (
        <ul className="mt-3 space-y-2" data-testid="cover-incoming-list">
          {incoming.map((r) => (
            <li key={r.id} data-testid={`cover-incoming-${r.id}`} className="flex flex-wrap items-center gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/[0.06] px-3 py-2 text-sm">
              <span className="text-white"><strong>{r.from_rep_name}</strong> asks you to cover <strong>{span(r)}</strong>{nDays(r) > 1 && <span className="text-slate-400"> ({nDays(r)} days)</span>}</span>
              {r.note && <span className="text-xs text-slate-400">“{r.note}”</span>}
              <div className="ml-auto flex gap-2">
                <Button size="sm" data-testid={`cover-accept-${r.id}`} disabled={answer.isPending} onClick={() => answer.mutate({ id: r.id, yes: true })}><Check className="size-3.5" /> Accept</Button>
                <Button size="sm" variant="ghost" data-testid={`cover-decline-${r.id}`} disabled={answer.isPending} onClick={() => answer.mutate({ id: r.id, yes: false })}><X className="size-3.5" /> Can't</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {covering.length > 0 && (
        <ul className="mt-3 space-y-1" data-testid="cover-covering-list">
          {covering.map((r) => (
            <li key={r.id} data-testid={`cover-covering-${r.id}`} className="flex items-center gap-3 text-sm text-slate-300">
              <span>You're covering <strong className="text-white">{r.from_rep_name}</strong> {span(r)}</span>
              <StatusPill r={r} />
            </li>
          ))}
        </ul>
      )}
      <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(e) => (e.preventDefault(), ask.mutate())}>
        <span className="pb-2 text-sm text-slate-300">Ask</span>
        <select data-testid="cover-teammate" value={f.to_rep_id} onChange={(e) => setF({ ...f, to_rep_id: e.target.value })} className={sel}>
          <option value="">a teammate…</option>
          {mates.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <span className="pb-2 text-sm text-slate-300">to cover</span>
        <Input type="date" data-testid="cover-start" aria-label="First day to cover" min={today} value={f.start} onChange={(e) => setF({ ...f, start: e.target.value, end: f.end && f.end < e.target.value ? "" : f.end })} className="h-9 w-40" />
        <span className="pb-2 text-sm text-slate-500">to</span>
        <Input type="date" data-testid="cover-end" aria-label="Last day to cover (leave empty for one day)" min={f.start || today} value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} className="h-9 w-40" />
        <Input data-testid="cover-note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value.slice(0, 120) })} placeholder="Why (optional)" className="h-9 w-44" />
        <Button size="sm" type="submit" data-testid="cover-send" disabled={!f.to_rep_id || !f.start || ask.isPending}><Send className="size-3.5" /> Send request</Button>
      </form>
      <p className="mt-2 text-xs text-slate-500">Leave the last day empty for a single day. Once they accept and a manager approves, you're marked off on the shift calendar and your open callbacks go to them the morning it starts. They get a reminder text at 6pm the night before.</p>
      {sent.length > 0 && (
        <ul className="mt-3 divide-y divide-border" data-testid="cover-sent-list">
          {sent.map((r) => (
            <li key={r.id} data-testid={`cover-sent-${r.id}`} className="flex items-center gap-3 py-1.5 text-sm">
              <span className="font-mono text-xs text-slate-400">{span(r)}</span>
              <span className="text-slate-200">{r.to_rep_name}</span>
              <StatusPill r={r} />
              {(r.status === "pending" || r.status === "accepted") && <Button size="sm" variant="ghost" className="ml-auto" data-testid={`cover-cancel-${r.id}`} onClick={() => cancel.mutate(r.id)}>Withdraw</Button>}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** Manager's Shift calendar: approve or block swaps teammates agreed to, and see every upcoming one. */
export function CoverRequestsOverview() {
  const { data } = useCoverRequests();
  const done = useRefresh();
  const [blocking, setBlocking] = useState<{ id: string; reason: string } | null>(null);
  const approve = useMutation({
    mutationFn: (id: string) => apiPost<CoverRequest>(`/cover-requests/${id}/approve`),
    onSuccess: (r) => (toast.success(`Approved — ${r.from_rep_name} is off ${span(r)}, ${r.to_rep_name} covers`), done()),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const block = useMutation({
    mutationFn: (b: { id: string; reason: string }) => apiPost<CoverRequest>(`/cover-requests/${b.id}/block`, { reason: b.reason } satisfies CoverBlock),
    onSuccess: (r) => (toast(`Swap for ${span(r)} not approved`), setBlocking(null), done()),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const rows = (data ?? []).filter((r) => r.status !== "cancelled");
  if (!rows.length) return null;
  const waiting = rows.filter((r) => r.status === "accepted").length;
  return (
    <Panel testId="cover-requests-overview" className="mb-6">
      <div className="flex items-center gap-2">
        <Handshake className="size-4 text-emerald-300" /><Overline>Cover swaps between reps</Overline>
        {waiting > 0 && <span data-testid="cover-waiting-count" className="ml-auto rounded bg-sky-500/15 px-2 py-0.5 text-xs text-sky-200">{waiting} waiting for your OK</span>}
      </div>
      <ul className="mt-3 divide-y divide-border">
        {rows.map((r) => (
          <li key={r.id} data-testid={`cover-overview-${r.id}`} className="flex flex-wrap items-center gap-3 py-2 text-sm">
            <span className="font-mono text-xs text-slate-400">{span(r)}</span>
            <span className="text-slate-200">{r.from_rep_name} → {r.to_rep_name}</span>
            {r.note && <span className="text-xs text-slate-500">{r.note}</span>}
            <span className="ml-auto flex items-center gap-2">
              <StatusPill r={r} />
              {r.status === "accepted" && blocking?.id !== r.id && (
                <>
                  <Button size="sm" data-testid={`cover-approve-${r.id}`} disabled={approve.isPending} onClick={() => approve.mutate(r.id)}><Check className="size-3.5" /> Approve</Button>
                  <Button size="sm" variant="ghost" data-testid={`cover-block-${r.id}`} onClick={() => setBlocking({ id: r.id, reason: "" })}><Ban className="size-3.5" /> Block</Button>
                </>
              )}
            </span>
            {blocking?.id === r.id && (
              <form className="flex w-full items-center gap-2" onSubmit={(e) => (e.preventDefault(), block.mutate(blocking))}>
                <Input autoFocus data-testid={`cover-block-reason-${r.id}`} value={blocking.reason} onChange={(e) => setBlocking({ ...blocking, reason: e.target.value.slice(0, 120) })} placeholder="Reason (optional) — e.g. inventory count that weekend" className="h-8 flex-1" />
                <Button size="sm" type="submit" variant="destructive" data-testid={`cover-block-confirm-${r.id}`} disabled={block.isPending}>Block swap</Button>
                <Button size="sm" type="button" variant="ghost" data-testid={`cover-block-cancel-${r.id}`} onClick={() => setBlocking(null)}>Keep</Button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
