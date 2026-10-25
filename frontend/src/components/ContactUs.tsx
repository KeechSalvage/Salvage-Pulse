import { useState } from "react";
import { useLocation } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Inbox, LifeBuoy, Lightbulb, MessageSquare } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Panel } from "@/components/common";
import { apiGet, apiPatch, apiPost, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { ContactCreate, ContactKind, ContactMessage, ContactReplyCreate, ContactResult, ContactStatusUpdate } from "@/lib/types";

const KINDS: { id: ContactKind; label: string; icon: typeof LifeBuoy; hint: string; placeholder: string }[] = [
  { id: "support", label: "Get support", icon: LifeBuoy, hint: "Something not working, a billing question or need a hand? We reply by email.", placeholder: "What happened, and what did you expect?" },
  { id: "suggestion", label: "Suggest an idea", icon: Lightbulb, hint: "Tell us what would make Salvage Pulse more useful for your yard.", placeholder: "I wish Salvage Pulse could…" },
];

/** "Contact us" button + dialog with a support box and a suggestion box. */
export function ContactUsButton({ className = "", compact = false }: { className?: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<ContactKind>("support");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState<ContactKind | null>(null);
  const { pathname } = useLocation();
  const qc = useQueryClient();
  const [tab, setTab] = useState<"new" | "mine">("new");
  const mine = useQuery({ queryKey: ["contact", "mine"], queryFn: () => apiGet<ContactMessage[]>("/contact/mine"), refetchInterval: 120_000 });
  const unread = (mine.data ?? []).some((m) => m.reply_unread);
  const openMine = () => {
    setTab("mine");
    if (unread) apiPost<ContactResult>("/contact/mine/seen").then(() => qc.invalidateQueries({ queryKey: ["contact", "mine"] }));
  };
  const send = useMutation({
    mutationFn: () => apiPost<ContactResult>("/contact", { kind, subject, message, page: pathname } satisfies ContactCreate),
    onSuccess: () => {
      setSent(kind);
      qc.invalidateQueries({ queryKey: ["contact", "mine"] });
      setSubject("");
      setMessage("");
    },
    onError: (e) => toast.error(errorMessage(e, "Write at least a few words")),
  });
  const k = KINDS.find((x) => x.id === kind)!;
  const close = (o: boolean) => {
    setOpen(o);
    if (!o) setSent(null);
  };
  return (
    <>
      <button
        type="button"
        data-testid={compact ? "mobile-contact-us-button" : "contact-us-button"}
        onClick={() => setOpen(true)}
        className={cn(compact ? "shrink-0 text-slate-400 hover:text-white" : "flex w-full items-center justify-center gap-2 rounded-md border border-slate-700 py-1.5 text-xs text-slate-300 transition-colors duration-150 hover:border-sky-500/60 hover:text-white", className)}
        aria-label="Contact us"
      >
        <MessageSquare className={compact ? "size-4" : "size-3.5"} /> {!compact && "Contact us"}
        {unread && <span data-testid="contact-unread-dot" className="size-2 rounded-full bg-emerald-400" title="New reply" />}
      </button>
      <Dialog open={open} onOpenChange={close}>
        <DialogContent data-testid="contact-dialog" className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Contact us</DialogTitle>
            <DialogDescription>The Salvage Pulse team reads every message.</DialogDescription>
          </DialogHeader>
          <div className="flex gap-4 border-b border-border text-sm">
            <button type="button" data-testid="contact-tab-new" onClick={() => setTab("new")} className={cn("pb-2", tab === "new" ? "border-b-2 border-sky-400 text-white" : "text-slate-400")}>New message</button>
            <button type="button" data-testid="contact-tab-mine" onClick={openMine} className={cn("flex items-center gap-1.5 pb-2", tab === "mine" ? "border-b-2 border-sky-400 text-white" : "text-slate-400")}>
              Your messages {unread && <span className="size-2 rounded-full bg-emerald-400" />}
            </button>
          </div>
          {tab === "mine" ? (
            <ul className="max-h-[50vh] space-y-3 overflow-y-auto" data-testid="contact-mine-list">
              {mine.data?.length === 0 && <p className="text-sm text-slate-500">You haven't sent anything yet.</p>}
              {(mine.data ?? []).map((m) => (
                <li key={m.id} data-testid={`contact-mine-${m.id}`} className="rounded-lg border border-border p-3 text-sm">
                  <p className="font-mono text-[11px] uppercase text-slate-500">{m.kind} · {new Date(m.created_at).toLocaleDateString()} · {m.status === "resolved" ? "answered" : "waiting"}</p>
                  {m.subject && <p className="mt-1 font-medium text-white">{m.subject}</p>}
                  <p className="mt-1 whitespace-pre-wrap text-slate-300">{m.message}</p>
                  {m.replies.map((r, i) => (
                    <div key={`${r.at}-${r.by}`} data-testid={`contact-reply-${m.id}-${i}`} className="mt-2 rounded-md border-l-2 border-sky-400 bg-sky-500/[0.06] px-3 py-2">
                      <p className="text-[11px] text-sky-300">{r.by} · Salvage Pulse · {new Date(r.at).toLocaleString()}</p>
                      <p className="mt-0.5 whitespace-pre-wrap text-slate-200">{r.text}</p>
                    </div>
                  ))}
                </li>
              ))}
            </ul>
          ) : sent ? (
            <div data-testid="contact-sent" className="flex flex-col items-center gap-3 py-6 text-center">
              <CheckCircle2 className="size-10 text-emerald-400" />
              <p className="font-heading text-lg font-semibold text-white">{sent === "support" ? "Got it — we'll email you back" : "Thanks for the idea!"}</p>
              <p className="text-sm text-slate-400">{sent === "support" ? "Most requests get an answer within one business day." : "We review every suggestion when planning what to build next."}</p>
              <div className="mt-2 flex gap-2">
                <Button variant="outline" data-testid="contact-send-another" onClick={() => setSent(null)}>Send another</Button>
                <Button data-testid="contact-close" onClick={() => close(false)}>Done</Button>
              </div>
            </div>
          ) : (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                send.mutate();
              }}
            >
              <div className="grid grid-cols-2 gap-2" role="tablist">
                {KINDS.map((x) => (
                  <button
                    key={x.id}
                    type="button"
                    role="tab"
                    aria-selected={kind === x.id}
                    data-testid={`contact-kind-${x.id}`}
                    onClick={() => setKind(x.id)}
                    className={cn(
                      "flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition-[background-color,border-color,color] duration-150",
                      kind === x.id ? "border-sky-500 bg-sky-500/15 text-white" : "border-border text-slate-400 hover:text-white",
                    )}
                  >
                    <x.icon className="size-4" /> {x.label}
                  </button>
                ))}
              </div>
              <p className="text-xs text-slate-400">{k.hint}</p>
              {kind === "support" && (
                <Input data-testid="contact-subject-input" value={subject} onChange={(e) => setSubject(e.target.value.slice(0, 120))} placeholder="Subject (e.g. CSV upload failed)" />
              )}
              <Textarea
                data-testid={kind === "support" ? "contact-support-box" : "contact-suggestion-box"}
                value={message}
                onChange={(e) => setMessage(e.target.value.slice(0, 4000))}
                placeholder={k.placeholder}
                rows={6}
              />
              <div className="flex items-center justify-between">
                <span className="font-mono text-[11px] text-slate-500">{message.length}/4000</span>
                <Button type="submit" data-testid="contact-submit" disabled={message.trim().length < 5 || send.isPending}>
                  {send.isPending ? "Sending…" : kind === "support" ? "Send to support" : "Send suggestion"}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Platform console inbox: support requests and suggestions from every yard. */
export function MessagesPanel() {
  const qc = useQueryClient();
  const [kind, setKind] = useState<"" | ContactKind>("");
  const { data } = useQuery({ queryKey: ["admin", "messages", kind], queryFn: () => apiGet<ContactMessage[]>(`/admin/messages${kind ? `?kind=${kind}` : ""}`) });
  const mark = useMutation({
    mutationFn: ({ id, status }: { id: string; status: ContactStatusUpdate["status"] }) => apiPatch<ContactMessage>(`/admin/messages/${id}`, { status } satisfies ContactStatusUpdate),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "messages"] }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const open = (data ?? []).filter((m) => m.status === "new").length;
  return (
    <Panel testId="admin-messages-panel" className="mt-6">
      <div className="flex flex-wrap items-center gap-3">
        <Inbox className="size-5 text-sky-300" />
        <div className="mr-auto">
          <h3 className="text-xl font-bold text-white">Messages</h3>
          <p className="text-xs text-slate-500">Support requests and suggestions sent with "Contact us". Each also emails the master address.</p>
        </div>
        <span data-testid="admin-messages-open" className="rounded border border-sky-500/40 px-2 py-0.5 font-mono text-[11px] uppercase text-sky-300">{open} open</span>
        {(["", "support", "suggestion"] as const).map((k) => (
          <button key={k || "all"} type="button" data-testid={`admin-messages-filter-${k || "all"}`} onClick={() => setKind(k)} className={cn("rounded-full border px-3 py-1 text-xs transition-colors duration-150", kind === k ? "border-sky-500 bg-sky-500/15 text-white" : "border-border text-slate-400 hover:text-white")}>
            {k === "" ? "All" : k === "support" ? "Support" : "Suggestions"}
          </button>
        ))}
      </div>
      {data?.length === 0 && <p className="mt-4 text-sm text-slate-500" data-testid="admin-messages-empty">No messages yet.</p>}
      <ul className="mt-4 space-y-3">
        {(data ?? []).map((m) => (
          <li key={m.id} data-testid={`admin-message-${m.id}`} className={cn("rounded-lg border p-4", m.status === "new" ? "border-sky-500/40 bg-sky-500/[0.04]" : "border-border opacity-70")}>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className={cn("rounded px-1.5 py-0.5 font-mono uppercase", m.kind === "support" ? "bg-red-500/15 text-red-300" : "bg-amber-500/15 text-amber-300")}>{m.kind}</span>
              <span className="font-medium text-white">{m.user_name}</span>
              <a href={`mailto:${m.user_email}?subject=${encodeURIComponent(`Re: ${m.subject || "your Salvage Pulse message"}`)}`} className="text-sky-300 hover:underline">{m.user_email}</a>
              <span className="text-slate-500">{m.role} · {m.org_name || "—"} · {new Date(m.created_at).toLocaleString()}{m.page ? ` · from ${m.page}` : ""}</span>
              <Button size="sm" variant={m.status === "new" ? "default" : "ghost"} className="ml-auto" data-testid={`admin-message-toggle-${m.id}`} disabled={mark.isPending} onClick={() => mark.mutate({ id: m.id, status: m.status === "new" ? "resolved" : "new" })}>
                {m.status === "new" ? "Mark resolved" : "Reopen"}
              </Button>
            </div>
            {m.subject && <p className="mt-2 font-medium text-white">{m.subject}</p>}
            <p className="mt-1 whitespace-pre-wrap text-sm text-slate-300">{m.message}</p>
            {m.replies.map((r, i) => (
              <p key={`${r.at}-${r.by}`} data-testid={`admin-contact-reply-${m.id}-${i}`} className="mt-2 whitespace-pre-wrap rounded-md border-l-2 border-sky-400 bg-sky-500/[0.06] px-3 py-2 text-sm text-slate-200"><span className="block text-[11px] text-sky-300">{r.by} · {new Date(r.at).toLocaleString()}</span>{r.text}</p>
            ))}
            <ReplyBox id={m.id} />
            {m.status === "resolved" && <p className="mt-2 text-[11px] text-slate-500">Resolved by {m.resolved_by}{m.resolved_at ? ` · ${new Date(m.resolved_at).toLocaleDateString()}` : ""}</p>}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function ReplyBox({ id }: { id: string }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const send = useMutation({
    mutationFn: () => apiPost<ContactMessage>(`/admin/messages/${id}/reply`, { text, resolve: true } satisfies ContactReplyCreate),
    onSuccess: () => {
      setText("");
      toast.success("Reply sent — they'll see it in the app and by email");
      qc.invalidateQueries({ queryKey: ["admin", "messages"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <form className="mt-3 flex items-end gap-2" onSubmit={(e) => (e.preventDefault(), send.mutate())}>
      <Textarea data-testid={`admin-reply-input-${id}`} rows={2} value={text} onChange={(e) => setText(e.target.value.slice(0, 4000))} placeholder="Write a reply…" />
      <Button size="sm" type="submit" data-testid={`admin-reply-send-${id}`} disabled={text.trim().length < 2 || send.isPending}>Reply</Button>
    </form>
  );
}
