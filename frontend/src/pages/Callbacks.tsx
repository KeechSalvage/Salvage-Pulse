import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { CheckCircle2, PhoneCall, PhoneMissed, RotateCcw, ShoppingCart, Voicemail } from "lucide-react";
import { SaleForm } from "@/components/SaleFields";
import { NewListForm, useCallbackLists } from "@/components/AddToCallbacks";
import { ListPlus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeader, fmtDate } from "@/components/common";
import { apiDelete, apiGet, apiPatch, apiPost, errorMessage } from "@/lib/api";

const fmtDue = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
import { useMe } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import type { CallSummary, CallbackItem, CallbackList, CallbackListUpdate, CallbackUpdate, OverdueAlertResult } from "@/lib/types";
import { isManagerLike } from "@/lib/types";
import { Input } from "@/components/ui/input";

type Tab = "open" | "resolved";

function fmtPhone(p: string) {
  const d = p.replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p || "No number";
}

export default function Callbacks() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const [tab, setTab] = useState<Tab>("open");
  const [selling, setSelling] = useState<string | null>(null);
  const [source, setSource] = useState("");
  const [newList, setNewList] = useState(false);
  const isManager = isManagerLike(me?.role);
  const lists = useCallbackLists();
  const { data, isError } = useQuery({
    queryKey: ["callbacks", tab, source],
    queryFn: () => apiGet<CallbackItem[]>(`/callbacks?status=${tab}&source=${encodeURIComponent(source)}`),
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["callbacks"] });
    qc.invalidateQueries({ queryKey: ["callback-lists"] });
    qc.invalidateQueries({ queryKey: ["overview"] });
  };
  const unassign = useMutation({
    mutationFn: (id: string) => apiDelete(`/calls/${id}/assignment`),
    onSuccess: () => (toast.success("Removed from callbacks"), refresh()),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const dropList = useMutation({
    mutationFn: (id: string) => apiDelete(`/callback-lists/${id}`),
    onSuccess: () => (toast.success("List deleted — its calls came off the rep's callbacks"), setSource(""), refresh()),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const curList = lists.data?.find((l) => l.id === source);
  const setDue = useMutation({
    mutationFn: ({ id, due }: { id: string; due: string }) => apiPatch<CallbackList>(`/callback-lists/${id}`, { due_date: due || null } satisfies CallbackListUpdate),
    onSuccess: (l) => (toast.success(l.due_date ? `Call by ${fmtDue(l.due_date)}` : "Call-by date cleared"), refresh()),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const overdueLists = (lists.data ?? []).filter((l) => l.overdue);
  const alertNow = useMutation({
    mutationFn: () => apiPost<OverdueAlertResult>("/callback-lists/overdue-alerts/send-now"),
    onSuccess: (r) => toast.success(`Sent ${r.emails} email${r.emails === 1 ? "" : "s"} and ${r.texts} text${r.texts === 1 ? "" : "s"} for ${r.lists} overdue list${r.lists === 1 ? "" : "s"}`),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const items = isError ? [] : (data ?? []);

  const mark = useMutation({
    mutationFn: ({ id, ...b }: CallbackUpdate & { id: string }) => apiPatch<CallSummary>(`/calls/${id}/callback`, b satisfies CallbackUpdate),
    onSuccess: (_, v) => {
      toast.success(v.sold_price ? "Called back and sold — saved as an order" : v.done ? "Marked as called back" : "Moved back to open");
      setSelling(null);
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <>
      <PageHeader overline="Missed call alerts" title={isManagerLike(me?.role) ? "Callbacks queue" : "My callbacks"}>
        <div id="callbacks-status-tabs" className="grid grid-cols-2 gap-1 rounded-lg bg-surface p-1 scroll-mt-6">
          {(["open", "resolved"] as const).map((t) => (
            <button
              key={t}
              data-testid={`callbacks-tab-${t}`}
              onClick={() => setTab(t)}
              className={cn(
                "rounded-md px-4 py-2 text-sm font-medium capitalize transition-colors duration-150",
                tab === t ? "bg-amber-500 text-primary-foreground" : "text-slate-400 hover:text-white",
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </PageHeader>

      <p className="-mt-4 mb-6 max-w-2xl text-sm leading-relaxed text-slate-400">
        Inbound voicemails and calls under 30 seconds. A call auto-resolves when anyone connects with that number again (30s+, in or out);
        otherwise call them back and mark it done.
      </p>

      <div id="callbacks-sources-bar" className="mb-5 flex flex-wrap items-center gap-2 scroll-mt-6" data-testid="callbacks-sources">
        {[{ id: "", label: "Everything" }, { id: "missed", label: "Missed calls" }, { id: "assigned", label: "Added by manager" }, ...(lists.data ?? []).map((l) => ({ id: l.id, label: `${l.name}${isManager ? ` · ${l.rep_name}` : ""} (${l.open})${l.due_date ? ` · ${l.overdue ? "overdue" : "due"} ${fmtDue(l.due_date)}` : ""}`, overdue: l.overdue }))].map((o) => (
          <button key={o.id || "all"} type="button" data-testid={`callbacks-source-${o.id || "all"}`} onClick={() => setSource(o.id)}
            className={cn("rounded-full border px-3 py-1 text-xs transition-colors duration-150",
              source === o.id ? "border-amber-500 bg-amber-500/15 text-white" : "overdue" in o && o.overdue ? "border-red-500/60 text-red-300 hover:text-red-200" : "border-border text-slate-400 hover:text-white")}>
            {o.label}
          </button>
        ))}
        {isManager && (
          <button type="button" data-testid="callbacks-new-list" onClick={() => setNewList(!newList)} className="inline-flex items-center gap-1 rounded-full border border-dashed border-slate-600 px-3 py-1 text-xs text-sky-300 transition-colors duration-150 hover:border-sky-400">
            <ListPlus className="size-3.5" /> New list
          </button>
        )}
        {isManager && curList && (
          <label className="ml-auto inline-flex items-center gap-1.5 text-xs text-slate-400">
            Call by
            <Input key={curList.id + curList.due_date} type="date" data-testid="callbacks-list-due" defaultValue={curList.due_date} onChange={(e) => setDue.mutate({ id: curList.id, due: e.target.value })} className="h-8 w-40" />
          </label>
        )}
        {isManager && curList && (
          <button type="button" data-testid="callbacks-delete-list" onClick={() => window.confirm(`Delete the list "${curList.name}"? Its calls come off ${curList.rep_name}'s callbacks (the call logs stay).`) && dropList.mutate(curList.id)}
            className="inline-flex items-center gap-1 text-xs text-red-300 hover:text-red-200">
            <Trash2 className="size-3.5" /> Delete list
          </button>
        )}
      </div>
      {overdueLists.length > 0 && (
        <div data-testid="callbacks-overdue-banner" className="mb-5 rounded-xl border border-red-500/40 bg-red-500/[0.06] px-4 py-3 text-sm text-red-200">
          <strong>{overdueLists.length} list{overdueLists.length === 1 ? " is" : "s are"} overdue:</strong>{" "}
          {overdueLists.map((l, i) => (
            <button key={l.id} type="button" data-testid={`callbacks-overdue-${l.id}`} onClick={() => setSource(l.id)} className="underline-offset-2 hover:underline">
              {l.name} ({l.open} left{isManager ? `, ${l.rep_name}` : ""}, due {fmtDue(l.due_date)}){i < overdueLists.length - 1 ? ", " : ""}
            </button>
          ))}
        </div>
      )}
      {isManager && overdueLists.length > 0 && (
        <div className="-mt-3 mb-5 flex justify-end">
          <Button size="sm" variant="ghost" data-testid="callbacks-overdue-send-now" disabled={alertNow.isPending} onClick={() => alertNow.mutate()}>Email overdue alerts now</Button>
        </div>
      )}
      {isManager && newList && (
        <div className="mb-5 rounded-xl border border-sky-500/30 bg-card p-4" data-testid="callbacks-new-list-form">
          <p className="mb-2 text-sm text-slate-300">Name the list and pick the rep. Then tick calls in the Call Library (or open a call) and use <strong>Add to callbacks</strong>.</p>
          <NewListForm onCreated={(l) => (setNewList(false), setSource(l.id))} />
        </div>
      )}

      {items.length === 0 && (
        <EmptyState
          testId="callbacks-empty"
          title={tab === "open" ? "No customers waiting" : "Nothing resolved yet"}
          body={tab === "open" ? "Every missed caller has been reached. Nice." : "Resolved callbacks will show here."}
        />
      )}

      <div id="callbacks-queue-table" className="space-y-3 scroll-mt-6" data-testid="callbacks-list">
        {items.map((c, i) => {
          const resolvedBy = c.followed_up ? `Reconnected ${c.followed_up_at ? fmtDate(c.followed_up_at) : ""}` : c.callback_done ? `Called back by ${c.callback_by}` : "";
          return (
            <motion.div
              key={c.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, delay: Math.min(i * 0.02, 0.3) }}
              data-testid={`callback-row-${c.id}`}
              className={cn(
                "flex flex-wrap items-center gap-4 rounded-xl border bg-card p-4 transition-colors duration-150",
                tab === "open" ? "border-red-500/25 hover:border-red-500/50" : "border-border",
              )}
            >
              <div className={cn("flex size-10 shrink-0 items-center justify-center rounded-lg", tab === "open" ? "bg-red-500/10 text-red-400" : "bg-emerald-500/10 text-emerald-400")}>
                {tab === "resolved" ? <CheckCircle2 className="size-5" /> : c.reason === "Voicemail" ? <Voicemail className="size-5" /> : <PhoneMissed className="size-5" />}
              </div>
              <div className="min-w-[200px] flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link to={`/calls/${c.id}`} data-testid={`callback-customer-${c.id}`} className="font-medium text-white hover:underline">
                    {c.customer_name}
                  </Link>
                  <span className={cn("rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider", c.assigned_by ? "border-sky-500/50 text-sky-300" : "border-slate-700 text-slate-400")}>{c.reason}</span>
                </div>
                {c.list_overdue && (
                  <span data-testid={`callback-overdue-${c.id}`} className="mt-1 inline-block rounded bg-red-500/15 px-1.5 py-0.5 font-mono text-[10px] uppercase text-red-300">overdue · was due {fmtDue(c.list_due_date)}</span>
                )}
                {c.assigned_by && (
                  <p data-testid={`callback-assigned-${c.id}`} className="mt-1 text-xs text-sky-200/80">
                    Added by {c.assigned_by}{c.assigned_note ? ` — “${c.assigned_note}”` : ""}
                  </p>
                )}
                <p className="mt-1 font-mono text-xs text-slate-500">
                  {fmtDate(c.created_at)} · {isManagerLike(me?.role) ? `${c.rep_name} · ` : ""}
                  {resolvedBy && <span className="text-emerald-400">{resolvedBy}</span>}
                </p>
              </div>
              <a
                href={c.customer_phone ? `tel:+1${c.customer_phone.replace(/\D/g, "").slice(-10)}` : undefined}
                data-testid={`callback-phone-${c.id}`}
                className="flex items-center gap-2 font-mono text-sm text-amber-300 hover:text-amber-200"
              >
                <PhoneCall className="size-4" /> {fmtPhone(c.customer_phone)}
              </a>
              {tab === "open" ? (
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" data-testid={`callback-sold-${c.id}`} disabled={mark.isPending} onClick={() => setSelling(selling === c.id ? null : c.id)}
                    className={cn(selling === c.id && "border-emerald-500/60 text-emerald-300")}>
                    <ShoppingCart className="size-4" /> Sold
                  </Button>
                  <Button size="sm" data-testid={`callback-mark-done-${c.id}`} disabled={mark.isPending} onClick={() => mark.mutate({ id: c.id, done: true })}>
                    <CheckCircle2 className="size-4" /> Called back
                  </Button>
                  {isManager && c.assigned_by && (
                    <Button size="sm" variant="ghost" title="Remove from callbacks" data-testid={`callback-unassign-${c.id}`} disabled={unassign.isPending} onClick={() => unassign.mutate(c.id)}>
                      <X className="size-4" />
                    </Button>
                  )}
                </div>
              ) : (
                c.callback_done && !c.followed_up && (
                  <Button size="sm" variant="ghost" data-testid={`callback-reopen-${c.id}`} disabled={mark.isPending} onClick={() => mark.mutate({ id: c.id, done: false })}>
                    <RotateCcw className="size-4" /> Reopen
                  </Button>
                )
              )}
              {tab === "open" && selling === c.id && (
                <div className="w-full border-t border-border pt-3" data-testid={`callback-sale-${c.id}`}>
                  <p className="mb-2 text-xs text-slate-400">What did the parts sell for? This marks the callback done and records an order.</p>
                  <SaleForm price={null} parts={[]} requirePrice saving={mark.isPending} saveLabel="Save sale & mark done" testPrefix={`callback-sale-${c.id}`}
                    onCancel={() => setSelling(null)} onSave={(p, parts) => mark.mutate({ id: c.id, done: true, sold_price: p, parts_sold: parts })} />
                </div>
              )}
            </motion.div>
          );
        })}
      </div>
    </>
  );
}
