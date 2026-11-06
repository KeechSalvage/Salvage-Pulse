import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  BellRing,
  ExternalLink,
  History,
  PhoneIncoming,
  PhoneOutgoing,
  StickyNote,
  UserRound,
  X,
} from "lucide-react";
import { ScoreBadge, TAG_LABELS, fmtDate, fmtDuration } from "@/components/common";
import { Button } from "@/components/ui/button";
import { apiGet } from "@/lib/api";
import { useMe } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import type { CallPopupData, CallPopupFeed, CallPopupMode, CallPopupSettings } from "@/lib/types";

const SEEN_KEY = "sp-call-popups-seen";
const SEEN_LIMIT = 200;

type CallPopupContextValue = {
  preview: () => void;
  show: (popup: CallPopupData) => void;
  mode: CallPopupMode;
};

const CallPopupContext = createContext<CallPopupContextValue>({
  preview: () => {},
  show: () => {},
  mode: "popup",
});

export const useCallPopups = () => useContext(CallPopupContext);

function formatPhone(value: string): string {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return value || "Unknown number";
}

function identity(popup: CallPopupData): string {
  return `${popup.provider || "unknown"}:${popup.external_id || popup.call_id || popup.event_id}`;
}

function loadSeen(): Set<string> {
  try {
    const raw = sessionStorage.getItem(SEEN_KEY);
    const values = raw ? (JSON.parse(raw) as string[]) : [];
    return new Set(Array.isArray(values) ? values : []);
  } catch {
    return new Set();
  }
}

function saveSeen(seen: Set<string>) {
  try {
    sessionStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-SEEN_LIMIT)));
  } catch {
    // Session storage can be unavailable in private/embedded browsers.
  }
}

function tagLabel(tag: string): string {
  return TAG_LABELS[tag] || tag.replace(/_/g, " ");
}

function previewPopup(): CallPopupData {
  const now = new Date().toISOString();
  return {
    event_id: "preview",
    call_id: "",
    external_id: "preview",
    provider: "preview",
    direction: "inbound",
    status: "waiting",
    number: "+15125550142",
    display_number: "+15125550142",
    other_number: "+15125550000",
    caller_name: "Ridgeline Collision",
    customer_name: "Ridgeline Collision",
    rep_id: "",
    rep_name: "Tyler Grant",
    started_at: now,
    known: true,
    customer: {
      key: "",
      name: "Ridgeline Collision",
      phone: "+15125550142",
      tag: "body_shop",
      email: "",
      alt_phones: ["+15125550199"],
    },
    notes: [
      {
        id: "preview-note",
        text: "Prefers OEM parts. Always ask for the VIN and confirm driver/passenger side before quoting.",
        author: "Marcus Reed",
        created_at: now,
      },
    ],
    prior_calls: [
      {
        id: "",
        created_at: now,
        rep_name: "Tyler Grant",
        direction: "inbound",
        category: "Sales Inquiry",
        outcome: "won",
        overall_score: 88,
        summary: "2019 Honda Civic headlight — quoted OEM LED assembly with warranty.",
        duration_sec: 164,
        has_audio: true,
        has_transcript: true,
        delivery_call: false,
      },
      {
        id: "",
        created_at: now,
        rep_name: "Cody Miller",
        direction: "inbound",
        category: "Warranty/Return",
        outcome: "pending",
        overall_score: 71,
        summary: "Called about a return credit on a previous order.",
        duration_sec: 92,
        has_audio: false,
        has_transcript: true,
        delivery_call: false,
      },
    ],
    line: { number: "+15125550000", label: "Main line", name: "" },
    has_audio: true,
  };
}

function QueueCard({ popup, onOpen, onDismiss }: { popup: CallPopupData; onOpen: () => void; onDismiss: () => void }) {
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);
  useEffect(() => {
    const timer = window.setTimeout(() => dismissRef.current(), 5 * 60 * 1000);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div
      data-testid="call-popup-queue-item"
      onClick={onOpen}
      className="group relative cursor-pointer rounded-xl border border-border bg-card p-3 shadow-xl transition-colors hover:border-amber-500/50"
    >
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onDismiss();
        }}
        className="absolute right-2 top-2 text-slate-500 opacity-0 transition-opacity hover:text-white group-hover:opacity-100"
        aria-label="Dismiss call popup"
      >
        <X className="size-3.5" />
      </button>
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.12em] text-amber-400/90">
        <BellRing className="size-3.5" /> {popup.direction === "outbound" ? "Outbound call" : "Incoming call"}
      </div>
      <p className="mt-1 font-mono text-lg font-semibold text-white">{formatPhone(popup.number)}</p>
      <p className="truncate text-sm text-slate-300">{popup.known ? popup.customer_name : "Unknown caller"}</p>
      {popup.line.label && <p className="mt-0.5 truncate text-[11px] text-slate-500">{popup.line.label}</p>}
    </div>
  );
}

function CallPopupModal({ popup, onClose }: { popup: CallPopupData; onClose: () => void }) {
  const navigate = useNavigate();
  const incoming = popup.direction !== "outbound";
  const statusLabel =
    popup.status === "waiting" || popup.status === "queued" || popup.status === "processing"
      ? "Call in progress"
      : popup.status === "completed"
        ? "Call completed"
        : popup.status;

  const openCall = () => {
    if (!popup.call_id) return;
    onClose();
    navigate(`/calls/${popup.call_id}`);
  };
  const openCustomer = () => {
    if (!popup.customer.key) return;
    onClose();
    navigate(`/customers/${encodeURIComponent(popup.customer.key)}`);
  };

  return (
    <div
      data-testid="call-popup"
      className="fixed inset-0 z-[100] flex justify-end bg-black/45 backdrop-blur-[2px]"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex h-full w-full max-w-[540px] flex-col overflow-hidden border-l border-border bg-card shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Call popup"
      >
        <header className="bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800 px-5 py-4 text-white">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-emerald-300">
              {incoming ? <PhoneIncoming className="size-4" /> : <PhoneOutgoing className="size-4" />}
              {incoming ? "Incoming call" : "Outbound call"}
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded-full border border-white/15 bg-white/10 px-2 py-0.5 text-[10px] font-medium text-slate-200">
                {statusLabel}
              </span>
              <button
                type="button"
                data-testid="call-popup-close"
                onClick={onClose}
                className="rounded-md p-1 text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
                aria-label="Close call popup"
              >
                <X className="size-4" />
              </button>
            </div>
          </div>
          <p data-testid="call-popup-number" className="mt-3 font-mono text-3xl font-bold tracking-tight">
            {formatPhone(popup.number)}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <p className="text-lg font-semibold">
              {popup.known ? popup.customer_name || "Known caller" : "Unknown caller"}
            </p>
            {popup.customer.tag && (
              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium capitalize text-amber-200">
                {tagLabel(popup.customer.tag)}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-slate-400">
            {popup.line.label ? `${incoming ? "Called" : "Calling from"} ${popup.line.label}` : "Line not identified"}
            {popup.rep_name ? ` · Rep: ${popup.rep_name}` : ""}
          </p>
          {popup.customer.alt_phones.length > 0 && (
            <p className="mt-1 text-xs text-slate-500">
              Other numbers: {popup.customer.alt_phones.map(formatPhone).join(" · ")}
            </p>
          )}
        </header>

        <div className="flex-1 space-y-4 overflow-auto p-5">
          {!popup.known && (
            <section className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
              <p className="flex items-center gap-2 text-sm font-medium text-amber-200">
                <UserRound className="size-4" /> No matching customer yet
              </p>
              <p className="mt-1 text-xs text-amber-100/70">
                This number has not been seen in the call library. The call will still be recorded and scored.
              </p>
            </section>
          )}

          {popup.notes.length > 0 && (
            <section>
              <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
                <StickyNote className="size-4 text-sky-300" /> Customer notes
              </h3>
              <div className="mt-2 space-y-2">
                {popup.notes.map((note) => (
                  <div key={note.id} className="rounded-lg border border-border bg-surface px-3 py-2">
                    <p className="text-sm text-slate-200">{note.text}</p>
                    <p className="mt-1 text-[11px] text-slate-500">
                      {note.author || "Team"} {note.created_at ? `· ${fmtDate(note.created_at)}` : ""}
                    </p>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
              <History className="size-4 text-sky-300" /> Previous calls
              <span className="font-mono text-[11px] font-normal text-slate-500">{popup.prior_calls.length}</span>
            </h3>
            <div className="mt-2 space-y-2" data-testid="call-popup-prior">
              {popup.prior_calls.length === 0 && (
                <p className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-slate-500">
                  No previous calls from this customer's numbers.
                </p>
              )}
              {popup.prior_calls.map((call, index) => (
                <button
                  key={call.id || `${call.created_at}-${index}`}
                  type="button"
                  onClick={() => {
                    if (!call.id) return;
                    onClose();
                    navigate(`/calls/${call.id}`);
                  }}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-lg border border-border bg-surface px-3 py-2.5 text-left transition-colors",
                    call.id && "hover:border-sky-500/40",
                  )}
                >
                  {call.overall_score > 0 ? <ScoreBadge score={call.overall_score} /> : <span className="mt-0.5 size-7 shrink-0 rounded-md bg-slate-800" />}
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="text-xs font-medium text-slate-200">{fmtDate(call.created_at)}</span>
                      <span className="text-[11px] text-slate-500">{call.rep_name || "Unassigned"}</span>
                      <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">{call.category || "Call"}</span>
                      {call.outcome && (
                        <span className={cn("text-[10px] uppercase tracking-wider", call.outcome === "won" ? "text-emerald-300" : call.outcome === "lost" ? "text-red-300" : "text-amber-300")}>
                          {call.outcome}
                        </span>
                      )}
                      {call.duration_sec > 0 && <span className="font-mono text-[10px] text-slate-500">{fmtDuration(call.duration_sec)}</span>}
                    </span>
                    {call.summary && <span className="mt-0.5 line-clamp-2 block text-xs text-slate-400">{call.summary}</span>}
                    <span className="mt-1 flex gap-2 text-[10px] text-slate-500">
                      {call.has_transcript && <span>transcript</span>}
                      {call.has_audio && <span>recording</span>}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        </div>

        <footer className="flex flex-wrap items-center gap-2 border-t border-border bg-surface/60 px-5 py-3">
          {popup.call_id && (
            <Button size="sm" data-testid="call-popup-open-call" onClick={openCall}>
              <ExternalLink className="size-3.5" /> Open call
            </Button>
          )}
          {popup.known && popup.customer.key && (
            <Button size="sm" variant="outline" onClick={openCustomer}>
              <UserRound className="size-3.5" /> Customer profile
            </Button>
          )}
          <span className="flex-1" />
          <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
        </footer>
      </div>
    </div>
  );
}

export function CallPopupProvider({ children }: { children: ReactNode }) {
  const me = useMe();
  const qc = useQueryClient();
  const [current, setCurrent] = useState<CallPopupData | null>(null);
  const [queue, setQueue] = useState<CallPopupData[]>([]);
  const currentRef = useRef<CallPopupData | null>(null);
  const seenRef = useRef<Set<string>>(loadSeen());
  const sinceRef = useRef(new Date(Date.now() - 2000).toISOString());
  const modeRef = useRef<CallPopupMode>("popup");
  const previousModeRef = useRef<CallPopupMode>("popup");
  const feedStartedRef = useRef(false);

  const prefs = useQuery({
    queryKey: ["call-popups", "prefs"],
    queryFn: () => apiGet<CallPopupSettings>("/me/call-popups"),
    enabled: !!me.data,
    staleTime: 30_000,
  });
  const mode = prefs.data?.mode ?? "popup";

  useEffect(() => {
    currentRef.current = current;
  }, [current]);

  useEffect(() => {
    if (previousModeRef.current === "off" && mode !== "off") {
      sinceRef.current = new Date(Date.now() - 2000).toISOString();
      // Drop the feed snapshot taken before popups were turned back on.
      qc.removeQueries({ queryKey: ["call-popups", "feed"] });
    }
    if (mode === "off") {
      setQueue([]);
      setCurrent(null);
    }
    previousModeRef.current = mode;
    modeRef.current = mode;
  }, [mode, qc]);

  const feed = useQuery({
    queryKey: ["call-popups", "feed"],
    queryFn: () => apiGet<CallPopupFeed>(`/call-popups/feed?limit=25&since=${encodeURIComponent(sinceRef.current)}`),
    enabled: !!me.data && prefs.isSuccess && mode !== "off",
    refetchInterval: 4000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  useEffect(() => {
    if (!feed.data || mode === "off") return;
    if (!feedStartedRef.current) {
      feedStartedRef.current = true;
      // First successful poll establishes the cursor. Do not replay calls that
      // happened before this tab opened.
      sinceRef.current = new Date(Date.now() - 8000).toISOString();
    }
    let changed = false;
    for (const popup of feed.data.popups ?? []) {
      const key = identity(popup);
      if (!key || seenRef.current.has(key)) continue;
      seenRef.current.add(key);
      changed = true;
      if (modeRef.current === "popup" && !currentRef.current) {
        currentRef.current = popup;
        setCurrent(popup);
      } else if (modeRef.current !== "off") {
        setQueue((items) => [...items, popup]);
      }
    }
    if (changed) saveSeen(seenRef.current);
    sinceRef.current = new Date(Date.now() - 8000).toISOString();
  }, [feed.data, mode]);

  // Popup mode: after one card is closed, show the next queued call.
  useEffect(() => {
    if (current || mode !== "popup" || queue.length === 0) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    currentRef.current = next;
    setCurrent(next);
  }, [current, mode, queue]);

  const closeCurrent = () => {
    currentRef.current = null;
    setCurrent(null);
  };

  const openFromQueue = (popup: CallPopupData) => {
    setQueue((items) => items.filter((item) => identity(item) !== identity(popup)));
    currentRef.current = popup;
    setCurrent(popup);
  };

  return (
    <CallPopupContext.Provider
      value={{
        preview: () => setCurrent(previewPopup()),
        show: (popup) => {
          currentRef.current = popup;
          setCurrent(popup);
        },
        mode,
      }}
    >
      {children}
      {queue.length > 0 && (
        <div className="fixed bottom-4 right-4 z-[90] flex w-[310px] flex-col gap-2" data-testid="call-popup-queue">
          {queue.slice(0, 4).map((popup) => (
            <QueueCard
              key={identity(popup)}
              popup={popup}
              onOpen={() => openFromQueue(popup)}
              onDismiss={() => setQueue((items) => items.filter((item) => identity(item) !== identity(popup)))}
            />
          ))}
          {queue.length > 4 && (
            <div className="rounded-lg border border-border bg-card px-3 py-2 text-center text-xs text-slate-400">
              +{queue.length - 4} more incoming calls
            </div>
          )}
        </div>
      )}
      {current && <CallPopupModal popup={current} onClose={closeCurrent} />}
    </CallPopupContext.Provider>
  );
}
