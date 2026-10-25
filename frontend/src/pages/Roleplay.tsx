import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { fadeUp, fadeUpSm, quick } from "@/lib/motion";
import { Bot, CheckCircle2, Flag, Loader2, Pencil, PhoneCall, Plus, RotateCcw, Send, Trash2 } from "lucide-react";
import ScenarioEditor from "@/components/ScenarioEditor";
import RoleplayAssignments from "@/components/RoleplayAssignments";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { BulletList, MetricBars, Overline, PageHeader, Panel, ScoreBadge, fmtDate } from "@/components/common";
import { apiDelete, apiGet, apiPost, apiStream, errorMessage } from "@/lib/api";
import { useMe, useMeta, useOrg } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import type { RoleplaySession, Scenario } from "@/lib/types";

const DIFF: Record<string, string> = {
  Easy: "text-emerald-400 border-emerald-500/30",
  Medium: "text-amber-300 border-amber-500/30",
  Hard: "text-red-400 border-red-500/30",
};

export default function Roleplay() {
  const qc = useQueryClient();
  const meta = useMeta();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingRep, setPendingRep] = useState<string | null>(null);
  const [streamText, setStreamText] = useState("");
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { data: me } = useMe();
  const isManager = me?.role === "manager";
  const org = useOrg();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Scenario | null>(null);
  const openEditor = (sc: Scenario | null) => {
    setEditing(sc);
    setEditorOpen(true);
  };

  const scenarios = useQuery({ queryKey: ["scenarios"], queryFn: () => apiGet<Scenario[]>("/roleplay/scenarios") });
  const sessions = useQuery({ queryKey: ["roleplay-sessions"], queryFn: () => apiGet<RoleplaySession[]>("/roleplay/sessions") });
  const session = useQuery({
    queryKey: ["roleplay-session", activeId],
    queryFn: () => apiGet<RoleplaySession>(`/roleplay/sessions/${activeId}`),
    enabled: !!activeId,
  });
  const s = session.data;
  const scenario = scenarios.data?.find((x) => x.id === s?.scenario_id);

  // Re-runs only to follow new chat content; scrollRef is a stable ref so it isn't a dependency.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [s?.messages.length, streamText, pendingRep]);

  const start = useMutation({
    mutationFn: (scenario_id: string) => apiPost<RoleplaySession>("/roleplay/sessions", { scenario_id }),
    onSuccess: (sess) => {
      qc.setQueryData(["roleplay-session", sess.id], sess);
      qc.invalidateQueries({ queryKey: ["roleplay-sessions"] });
      setActiveId(sess.id);
      toast.success("Phone's ringing — you're live");
    },
    onError: (e) => toast.error(errorMessage(e, "Could not start session")),
  });

  const removeScenario = useMutation({
    mutationFn: (id: string) => apiDelete(`/roleplay/scenarios/${id}`),
    onSuccess: () => {
      toast.success("Role-play deleted");
      qc.invalidateQueries({ queryKey: ["scenarios"] });
      qc.invalidateQueries({ queryKey: ["roleplay-scoreboard"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const grade = useMutation({
    mutationFn: () => apiPost<RoleplaySession>(`/roleplay/sessions/${activeId}/grade`),
    onSuccess: (sess) => {
      qc.setQueryData(["roleplay-session", sess.id], sess);
      qc.invalidateQueries({ queryKey: ["roleplay-sessions"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
      qc.invalidateQueries({ queryKey: ["roleplay-assignments"] });
    },
    onError: (e) => toast.error(errorMessage(e, "Grading failed")),
  });

  const send = async () => {
    const text = draft.trim();
    if (!text || !activeId || streaming) return;
    setDraft("");
    setPendingRep(text);
    setStreamText("");
    setStreaming(true);
    try {
      let failed = false;
      let failMsg = "";
      await apiStream(`/roleplay/sessions/${activeId}/message`, { text }, (ev) => {
        if (typeof ev.delta === "string") setStreamText((t) => t + ev.delta);
        if (typeof ev.error === "string") { failed = true; failMsg = ev.error; }
      });
      if (failed) toast.error(failMsg || "The AI customer dropped the call — try again");
      await qc.invalidateQueries({ queryKey: ["roleplay-session", activeId] });
    } catch (e) {
      toast.error(errorMessage(e, "Message failed"));
    } finally {
      setPendingRep(null);
      setStreamText("");
      setStreaming(false);
    }
  };

  const repTurns = s?.messages.filter((m) => m.role === "rep").length ?? 0;

  return (
    <>
      <PageHeader overline="AI sales sparring" title="Role-play trainer">
        {activeId && (
          <Button variant="outline" data-testid="roleplay-new-session-button" onClick={() => setActiveId(null)}>
            <RotateCcw className="size-4" /> New scenario
          </Button>
        )}
        {!activeId && isManager && (
          <Button data-testid="roleplay-create-scenario-button" onClick={() => openEditor(null)}>
            <Plus className="size-4" /> Create role-play
          </Button>
        )}
      </PageHeader>

      {!activeId ? (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
          <div className="xl:col-span-8">
            {!!org.data?.roleplay_daily_cap && (
              <p data-testid="roleplay-trial-cap" className="mb-4 rounded-lg border border-orange-500/40 bg-orange-500/10 px-4 py-2 text-sm text-orange-100">
                Free-trial limit: {org.data.roleplay_daily_cap} role-play call per person per day for the rest of your trial. Upgrade on the Billing page for unlimited practice.
              </p>
            )}
            <RoleplayAssignments isManager={isManager} scenarios={scenarios.data ?? []} onStart={(id) => start.mutate(id)} />
            <Overline className="mb-3">Pick a caller</Overline>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {(scenarios.data ?? []).map((sc, i) => (
                <div key={sc.id} className="group/card relative">
                <motion.button
                  {...fadeUp}
                  transition={{ duration: 0.2, delay: i * 0.05 }}
                  data-testid={`scenario-card-${sc.id}`}
                  disabled={start.isPending}
                  onClick={() => start.mutate(sc.id)}
                  className="group flex h-full w-full flex-col rounded-xl border border-border bg-card p-5 text-left transition-[border-color,transform] duration-150 hover:-translate-y-0.5 hover:border-amber-500/50 disabled:opacity-60"
                >
                  <div className="flex items-center justify-between">
                    <span className={cn("rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider", DIFF[sc.difficulty])}>{sc.difficulty}</span>
                    {start.isPending && start.variables === sc.id ? (
                      <Loader2 className="size-4 animate-spin text-amber-400" />
                    ) : (
                      <PhoneCall className="size-4 text-slate-600 transition-colors duration-150 group-hover:text-amber-400" />
                    )}
                  </div>
                  <h3 className="mt-4 font-heading text-lg font-bold text-white">{sc.title}</h3>
                  <p className="mt-1 text-sm text-sky-300">{sc.persona}</p>
                  <p className="mt-3 text-sm leading-relaxed text-slate-400">
                    <span className="font-mono text-[10px] uppercase tracking-wider text-amber-400/80">Your goal · </span>
                    {sc.objective}
                  </p>
                  {sc.custom && <span data-testid={`scenario-custom-badge-${sc.id}`} className="mt-3 self-start rounded bg-sky-500/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-sky-300">Your yard's role-play</span>}
                </motion.button>
                {sc.custom && isManager && (
                  <div className="absolute right-12 top-4 flex gap-2 opacity-60 transition-opacity duration-150 group-hover/card:opacity-100">
                    <button data-testid={`scenario-edit-${sc.id}`} title="Edit" onClick={() => openEditor(sc)} className="text-slate-400 transition-colors duration-150 hover:text-amber-300">
                      <Pencil className="size-4" />
                    </button>
                    <button
                      data-testid={`scenario-delete-${sc.id}`}
                      title="Delete"
                      onClick={() => window.confirm(`Delete "${sc.title}"? Past sessions stay in history.`) && removeScenario.mutate(sc.id)}
                      className="text-slate-500 transition-colors duration-150 hover:text-red-400"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                )}
                </div>
              ))}
            </div>
          </div>
          <Panel className="xl:col-span-4" testId="roleplay-history-panel">
            <Overline>Past sessions</Overline>
            <div className="mt-4 space-y-2">
              {(sessions.data ?? []).slice(0, 10).map((ps) => (
                <button
                  key={ps.id}
                  data-testid={`roleplay-history-${ps.id}`}
                  onClick={() => setActiveId(ps.id)}
                  className="flex w-full items-center gap-3 rounded-lg border border-border bg-surface p-3 text-left transition-colors duration-150 hover:border-amber-500/40"
                >
                  {ps.grade ? <ScoreBadge score={ps.grade.overall_score} /> : <span className="font-mono text-[10px] uppercase text-amber-300">live</span>}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-white">{ps.scenario_title}</p>
                    <p className="font-mono text-[11px] text-slate-500">
                      {ps.user_name} · {fmtDate(ps.created_at)}
                    </p>
                  </div>
                </button>
              ))}
              {sessions.data && !sessions.data.length && <p className="text-sm text-slate-500">No sessions yet. Pick a caller to start.</p>}
            </div>
          </Panel>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          <div className="space-y-4 lg:col-span-4">
            <Panel testId="roleplay-brief">
              <Overline>Scenario brief</Overline>
              <h3 className="mt-2 font-heading text-xl font-bold text-white">{scenario?.title ?? s?.scenario_title}</h3>
              <p className="mt-1 text-sm text-sky-300">{scenario?.persona}</p>
              <p className="mt-4 text-sm leading-relaxed text-slate-300">{scenario?.objective}</p>
              <div className="mt-5 rounded-lg border border-border bg-surface p-3 text-xs leading-relaxed text-slate-400">
                Tip: greet with the yard name, ask for year/make/model or VIN, explain condition + warranty, offer add-ons, and ask for the sale.
              </div>
            </Panel>
            {s?.status === "active" && (
              <Button
                data-testid="roleplay-grade-button"
                className="h-11 w-full"
                disabled={grade.isPending || streaming || repTurns === 0}
                onClick={() => grade.mutate()}
              >
                {grade.isPending ? <Loader2 className="size-4 animate-spin" /> : <Flag className="size-4" />}
                {grade.isPending ? "Grading your call…" : "Finish & grade call"}
              </Button>
            )}
            {s?.grade && (
              <Panel testId="roleplay-scorecard" className="border-amber-500/30">
                <div className="flex items-center gap-4">
                  <ScoreBadge score={s.grade.overall_score} size="lg" testId="roleplay-overall-score" />
                  <div>
                    <Overline>Practice score</Overline>
                    <p className="mt-1 text-sm text-slate-300">{s.grade.summary}</p>
                  </div>
                </div>
                <div className="mt-5">
                  <MetricBars metrics={s.grade.metrics} defs={meta.data?.metrics ?? []} testPrefix="roleplay-metric" />
                </div>
              </Panel>
            )}
          </div>

          <div className="flex h-[calc(100vh-180px)] min-h-[520px] flex-col overflow-hidden rounded-xl border border-border bg-card lg:col-span-8">
            <div className="flex items-center justify-between border-b border-border px-5 py-3">
              <div className="flex items-center gap-3">
                <span className="relative flex size-2.5">
                  {s?.status === "active" && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />}
                  <span className={cn("relative inline-flex size-2.5 rounded-full", s?.status === "active" ? "bg-emerald-400" : "bg-slate-500")} />
                </span>
                <span className="text-sm font-medium text-white">{scenario?.persona.split(",")[0] ?? "Customer"}</span>
              </div>
              <span className="font-mono text-[11px] uppercase tracking-wider text-slate-500">{s?.status === "graded" ? "Call ended" : "On the line"}</span>
            </div>

            <div ref={scrollRef} data-testid="roleplay-messages" className="flex-1 space-y-4 overflow-y-auto p-5">
              {/* Messages are append-only with no ids, so their position is a stable key. */}
              {(s?.messages ?? []).map((m, i) => (
                <Bubble key={i} role={m.role} text={m.text} testId={`roleplay-message-${i}`} />
              ))}
              {pendingRep && <Bubble role="rep" text={pendingRep} testId="roleplay-pending-rep" />}
              {streaming && <Bubble role="customer" text={streamText} streaming testId="roleplay-streaming-reply" />}

              {s?.grade && (
                <motion.div {...fadeUp} className="space-y-4 rounded-xl border border-amber-500/30 bg-amber-500/[0.04] p-5" data-testid="roleplay-feedback">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="size-5 text-amber-400" />
                    <h4 className="font-heading text-lg font-bold text-white">Coach's debrief</h4>
                  </div>
                  <p className="text-[15px] leading-relaxed text-slate-200">{s.grade.coaching_feedback}</p>
                  <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                    <div>
                      <Overline className="mb-2 text-emerald-400">Strengths</Overline>
                      <BulletList items={s.grade.strengths} tone="good" testId="roleplay-strengths" />
                    </div>
                    <div>
                      <Overline className="mb-2">Work on</Overline>
                      <BulletList items={s.grade.improvements} tone="bad" testId="roleplay-improvements" />
                    </div>
                  </div>
                </motion.div>
              )}
            </div>

            {s?.status === "active" && (
              <form
                className="flex items-end gap-3 border-t border-border bg-surface p-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  send();
                }}
              >
                <Textarea
                  data-testid="roleplay-input"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  placeholder="Respond like you're on the phone… (Enter to send)"
                  className="max-h-32 min-h-[48px] flex-1 resize-none bg-card"
                  disabled={streaming || grade.isPending}
                />
                <Button data-testid="roleplay-send-button" type="submit" size="icon-lg" disabled={!draft.trim() || streaming || grade.isPending}>
                  {streaming ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                </Button>
              </form>
            )}
          </div>
        </div>
      )}
      <ScenarioEditor open={editorOpen} editing={editing} onClose={() => setEditorOpen(false)} />
    </>
  );
}

function Bubble({ role, text, streaming, testId }: { role: "customer" | "rep"; text: string; streaming?: boolean; testId: string }) {
  const isRep = role === "rep";
  return (
    <motion.div {...fadeUpSm} transition={quick} className={cn("flex gap-3", isRep && "flex-row-reverse")} data-testid={testId}>
      {!isRep && (
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-slate-800 ring-1 ring-slate-700">
          <Bot className="size-4 text-sky-400" />
        </div>
      )}
      <div className={cn("max-w-[78%] rounded-2xl px-4 py-3 text-[15px] leading-relaxed", isRep ? "rounded-tr-sm bg-amber-700 text-white" : "rounded-tl-sm bg-surface-2 text-slate-100")}>
        {text}
        {streaming && <span className="caret ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 bg-sky-300" />}
      </div>
    </motion.div>
  );
}
