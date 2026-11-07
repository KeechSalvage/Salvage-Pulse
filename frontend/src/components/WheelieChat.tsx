import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, Plus, Send, X } from "lucide-react";
import { apiGet, apiPost, errorMessage } from "@/lib/api";
import type { User } from "@/lib/types";
import { cn } from "@/lib/utils";

interface AssistantContext {
  name: string;
  first_name: string;
  title: string;
  role: string;
  audience: string;
  org: string;
  greeting: string;
  suggestions: string[];
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const STORAGE_PREFIX = "wheelie-chat:v1";

function storageKey(me: User) {
  return `${STORAGE_PREFIX}:${me.org_id || "staff"}:${me.id || me.email}`;
}

function renderInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\((?:https?:\/\/|mailto:)[^)\s]+\)|https?:\/\/[^\s<)]+)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let index = 0;

  const add = (node: ReactNode) => nodes.push(<Fragment key={`${keyBase}-${index++}`}>{node}</Fragment>);

  while ((match = pattern.exec(text))) {
    if (match.index > last) add(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith("**") && token.endsWith("**")) {
      add(<strong className="font-semibold text-white">{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`") && token.endsWith("`")) {
      add(
        <code className="rounded bg-slate-800 px-1 py-0.5 font-mono text-[11px] text-slate-200">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("[")) {
      const link = token.match(/^\[([^\]]+)\]\((.+)\)$/);
      if (link) {
        add(
          <a href={link[2]} target="_blank" rel="noreferrer" className="text-sky-300 underline underline-offset-2">
            {link[1]}
          </a>,
        );
      } else {
        add(token);
      }
    } else {
      add(
        <a href={token} target="_blank" rel="noreferrer" className="text-sky-300 underline underline-offset-2">
          {token}
        </a>,
      );
    }
    last = match.index + token.length;
  }
  if (last < text.length) add(text.slice(last));
  return nodes;
}

function RichText({ text }: { text: string }) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let list: { type: "ul" | "ol"; items: string[] } | null = null;

  const flush = () => {
    if (!list) return;
    const Tag = list.type;
    const key = `list-${blocks.length}`;
    blocks.push(
      <Tag
        key={key}
        className={cn("space-y-1 pl-4", list.type === "ul" ? "list-disc" : "list-decimal")}
      >
        {list.items.map((item, i) => (
          <li key={`${key}-${i}`} className="text-sm leading-relaxed text-slate-200">
            {renderInline(item, `${key}-${i}`)}
          </li>
        ))}
      </Tag>,
    );
    list = null;
  };

  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) {
      flush();
      return;
    }
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    if (bullet) {
      if (!list || list.type !== "ul") {
        flush();
        list = { type: "ul", items: [] };
      }
      list.items.push(bullet[1]);
      return;
    }
    const numbered = line.match(/^\d+[.)]\s+(.*)$/);
    if (numbered) {
      if (!list || list.type !== "ol") {
        flush();
        list = { type: "ol", items: [] };
      }
      list.items.push(numbered[1]);
      return;
    }
    flush();
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    blocks.push(
      <p
        key={`p-${i}`}
        className={cn(
          "text-sm leading-relaxed text-slate-200",
          heading && "font-semibold text-white",
        )}
      >
        {renderInline(heading ? heading[1] : line, `p-${i}`)}
      </p>,
    );
  });
  flush();
  return <div className="space-y-2">{blocks}</div>;
}

export default function WheelieChat({ me }: { me: User }) {
  const [open, setOpen] = useState(false);
  const [context, setContext] = useState<AssistantContext | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [loadingContext, setLoadingContext] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const loadingRef = useRef(false);
  const key = storageKey(me);

  // Restore this user's transcript before the first greeting is seeded.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        setMessages(
          parsed.filter(
            (item): item is ChatMessage =>
              item &&
              (item.role === "user" || item.role === "assistant") &&
              typeof item.content === "string",
          ),
        );
      }
    } catch {
      /* ignore a corrupt saved transcript */
    }
  }, [key]);

  useEffect(() => {
    if (!messages.length) return;
    try {
      localStorage.setItem(key, JSON.stringify(messages.slice(-40)));
    } catch {
      /* storage may be unavailable */
    }
  }, [key, messages]);

  const loadContext = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoadingContext(true);
    setError("");
    try {
      const data = await apiGet<AssistantContext>("/assistant/context");
      setContext(data);
      setSuggestions(data.suggestions || []);
      setMessages((prev) => (prev.length ? prev : [{ role: "assistant", content: data.greeting }]));
    } catch (err) {
      setError(errorMessage(err, "Couldn't load your assistant profile."));
    } finally {
      loadingRef.current = false;
      setLoadingContext(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    if (!context) void loadContext();
    const timer = window.setTimeout(() => inputRef.current?.focus(), 80);
    return () => window.clearTimeout(timer);
  }, [open, context, loadContext]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    const host = scrollRef.current;
    if (host) host.scrollTop = host.scrollHeight;
  }, [messages, sending]);

  const send = async (value: string) => {
    const text = value.trim();
    if (!text || sending) return;
    setError("");
    const next: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setInput("");
    setSending(true);
    try {
      const data = await apiPost<{ reply: string; suggestions: string[] }>("/assistant/chat", {
        messages: next.slice(-20),
      });
      setMessages((prev) => [...prev, { role: "assistant", content: data.reply }]);
      setSuggestions(data.suggestions || []);
    } catch (err) {
      setError(errorMessage(err, "Wheelie couldn't answer that just now. Try again."));
    } finally {
      setSending(false);
    }
  };

  const newChat = () => {
    setError("");
    setInput("");
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
    if (context) {
      setMessages([{ role: "assistant", content: context.greeting }]);
      setSuggestions(context.suggestions || []);
    } else {
      setMessages([]);
      setSuggestions([]);
      void loadContext();
    }
    window.setTimeout(() => inputRef.current?.focus(), 50);
  };

  const subtitle = context
    ? `${context.title || me.title || "Team member"}${context.org ? ` · ${context.org}` : ""}`
    : `${me.title || "Team member"}${me.org_id ? "" : " · Platform"}`;

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open Wheelie assistant"
          className="fixed bottom-6 right-6 z-40 flex size-14 items-center justify-center rounded-full border border-amber-500/40 bg-card shadow-2xl transition-transform duration-150 hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
        >
          <img
            src="/wheelie-avatar.jpg"
            alt=""
            className="size-full rounded-full object-cover"
          />
          <span className="absolute bottom-1 right-1 size-3 rounded-full border-2 border-card bg-emerald-400" />
        </button>
      )}

      {open && (
        <section
          role="dialog"
          aria-label="Wheelie assistant"
          className="fixed bottom-3 left-3 right-3 z-40 flex h-[calc(100dvh-1.5rem)] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl sm:bottom-24 sm:left-auto sm:right-6 sm:h-[min(620px,calc(100vh-8rem))] sm:w-[380px]"
        >
          <header className="flex items-center gap-3 border-b border-border bg-surface px-4 py-3">
            <div className="relative shrink-0">
              <img
                src="/wheelie-avatar.jpg"
                alt=""
                className="size-9 rounded-full border border-border object-cover"
              />
              <span className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-surface bg-emerald-400" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h2 className="font-heading text-sm font-semibold text-white">Wheelie</h2>
                <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider text-amber-300 ring-1 ring-amber-500/30">
                  AI
                </span>
              </div>
              <p className="truncate text-[11px] text-slate-400">{subtitle}</p>
            </div>
            <button
              type="button"
              onClick={newChat}
              className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-muted hover:text-white"
              title="Start a new chat"
              aria-label="Start a new chat"
            >
              <Plus className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-muted hover:text-white"
              title="Close"
              aria-label="Close assistant"
            >
              <X className="size-4" />
            </button>
          </header>

          <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
            {messages.map((message, i) => (
              <div
                key={`${message.role}-${i}`}
                className={cn("flex gap-2.5", message.role === "user" && "justify-end")}
              >
                {message.role === "assistant" && (
                  <img
                    src="/wheelie-avatar.jpg"
                    alt=""
                    className="mt-0.5 size-7 shrink-0 rounded-full border border-border object-cover"
                  />
                )}
                <div className={cn("min-w-0 max-w-[85%]", message.role === "user" && "flex flex-col items-end")}>
                  <div
                    className={cn(
                      "text-[11px] font-medium",
                      message.role === "assistant" ? "mb-1 text-slate-400" : "mb-1 text-slate-500",
                    )}
                  >
                    {message.role === "assistant" ? "Wheelie" : "You"}
                  </div>
                  <div
                    className={cn(
                      "rounded-2xl px-3 py-2",
                      message.role === "assistant"
                        ? "rounded-tl-sm border border-border bg-surface text-slate-200"
                        : "rounded-tr-sm bg-primary text-primary-foreground",
                    )}
                  >
                    {message.role === "assistant" ? (
                      <RichText text={message.content} />
                    ) : (
                      <p className="whitespace-pre-wrap text-sm leading-relaxed">{message.content}</p>
                    )}
                  </div>
                </div>
              </div>
            ))}

            {loadingContext && !messages.length && (
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <Loader2 className="size-3.5 animate-spin" /> Loading your yard profile…
              </div>
            )}

            {sending && (
              <div className="flex items-center gap-2.5">
                <img
                  src="/wheelie-avatar.jpg"
                  alt=""
                  className="size-7 rounded-full border border-border object-cover"
                />
                <div className="rounded-2xl rounded-tl-sm border border-border bg-surface px-3 py-2 text-xs text-slate-400">
                  <span className="inline-flex items-center gap-1.5">
                    <Loader2 className="size-3.5 animate-spin" /> Wheelie is thinking…
                  </span>
                </div>
              </div>
            )}
          </div>

          {error && (
            <div className="mx-4 mb-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              {error}
            </div>
          )}

          {!!suggestions.length && !sending && (
            <div className="flex flex-wrap gap-1.5 px-4 pb-2">
              {suggestions.slice(0, 3).map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => void send(suggestion)}
                  className="rounded-full border border-border bg-surface px-2.5 py-1 text-[11px] text-slate-300 transition-colors hover:border-amber-500/50 hover:text-white"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          )}

          <form
            className="border-t border-border bg-surface px-3 py-3"
            onSubmit={(event) => {
              event.preventDefault();
              void send(input);
            }}
          >
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void send(input);
                  }
                }}
                rows={1}
                maxLength={4000}
                placeholder="Ask about your yard, team, calls…"
                className="max-h-28 min-h-10 w-full resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-amber-500 focus:outline-none"
              />
              <button
                type="submit"
                disabled={!input.trim() || sending}
                className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-colors hover:bg-primary/80 disabled:opacity-40"
                aria-label="Send message"
              >
                <Send className="size-4" />
              </button>
            </div>
            <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
              Wheelie uses your sign-in and only sees what your {context?.title || me.title || "role"} permits.
            </p>
          </form>
        </section>
      )}
    </>
  );
}
