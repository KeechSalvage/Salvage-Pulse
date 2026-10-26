import { Fragment, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, FileAudio, GraduationCap, Lightbulb, Loader2, Radio, RefreshCw, ThumbsUp, Trash2, TrendingUp } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  BulletList,
  CategoryBadge,
  MetricBars,
  OutcomeBadge,
  Overline,
  Panel,
  ScoreBadge,
  fmtDate,
  fmtDuration,
  scoreTier,
} from "@/components/common";
import { apiDelete, apiGet, apiPost, apiUpload, errorMessage } from "@/lib/api";
import { useKeywords, useMe, useMeta } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import VehicleEditor from "@/components/VehicleEditor";
import { CustomerCallsPanel, SaleBox } from "@/components/CustomerCalls";
import AddToCallbacks from "@/components/AddToCallbacks";
import { isManagerLike } from "@/lib/types";
import DeliveryScoreCard from "@/components/DeliveryScoreCard";
import { PriceMissingBadge, priceMissing } from "@/components/PriceMissing";
import type { Call, CallSummary } from "@/lib/types";

function AttachPanel({ callId }: { callId: string }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const attach = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      if (file) fd.append("file", file);
      else fd.append("transcript", text);
      return apiUpload<CallSummary>(`/calls/${callId}/attach`, fd);
    },
    onSuccess: () => {
      toast.success("Analysis started");
      qc.invalidateQueries({ queryKey: ["call", callId] });
      qc.invalidateQueries({ queryKey: ["calls"] });
    },
    onError: (e) => toast.error(errorMessage(e, "Could not attach")),
  });
  return (
    <Panel testId="call-attach-panel" className="border-sky-500/30">
      <Overline className="text-sky-400">Unlock full AI coaching</Overline>
      <p className="mt-2 text-sm leading-relaxed text-slate-300">
        RingCentral exports don't include the conversation. Attach the recording (download it from RingCentral) or paste the transcript, and Claude will
        re-categorize, score all 7 metrics and write coaching for this rep.
      </p>
      <input ref={ref} type="file" accept=".mp3,.mp4,.mpeg,.mpga,.m4a,.wav,.webm" className="hidden" data-testid="attach-file-input" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button variant="outline" data-testid="attach-file-button" onClick={() => ref.current?.click()}>
          <FileAudio className="size-4" /> {file ? file.name : "Choose recording"}
        </Button>
        <span className="text-xs text-slate-500">or paste transcript below</span>
      </div>
      <Textarea
        data-testid="attach-transcript-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={!!file}
        placeholder={"Rep: Thanks for calling Salvage Pulse Pro…\nCustomer: …"}
        className="mt-3 min-h-[140px] bg-surface font-mono text-sm"
      />
      <div className="mt-3 flex justify-end">
        <Button data-testid="attach-submit-button" disabled={attach.isPending || (!file && text.trim().length < 20)} onClick={() => attach.mutate()}>
          {attach.isPending && <Loader2 className="size-4 animate-spin" />} Analyze with AI
        </Button>
      </div>
    </Panel>
  );
}

function RingCentralPanel({ call }: { call: Call }) {
  return (
    <Panel testId="call-ringcentral-panel">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Radio className="size-4 text-amber-400" />
          <h3 className="text-xl font-bold text-white">RingCentral call record</h3>
        </div>
        {call.external_url && (
          <a href={call.external_url} target="_blank" rel="noreferrer" data-testid="call-ringcentral-link" className="inline-flex items-center gap-1.5 text-sm text-sky-400 hover:underline">
            Open in RingCentral <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>
      <dl className="mt-5 grid grid-cols-2 gap-4 md:grid-cols-4">
        {[
          ["Direction", call.direction || "—"],
          ["Duration", call.duration_sec ? fmtDuration(call.duration_sec) : "—"],
          ["RC category", call.source_category || "—"],
          ["Phone", call.customer_phone || "—"],
        ].map(([k, v]) => (
          <div key={k}>
            <dt className="font-mono text-[10px] uppercase tracking-wider text-slate-500">{k}</dt>
            <dd data-testid={`call-rc-${k.toLowerCase().replace(/ /g, "-")}`} className="mt-1 capitalize text-slate-200">{v}</dd>
          </div>
        ))}
      </dl>
      {call.topics.length > 0 && (
        <div className="mt-5">
          <Overline className="mb-2 text-slate-400">Topics</Overline>
          <div className="flex flex-wrap gap-1.5" data-testid="call-topics">
            {call.topics.map((t) => (
              <span key={t} className="rounded border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-xs text-sky-200">{t}</span>
            ))}
          </div>
        </div>
      )}
      {call.trackers.length > 0 && (
        <div className="mt-4">
          <Overline className="mb-2 text-slate-400">Trackers</Overline>
          <div className="flex flex-wrap gap-1.5" data-testid="call-trackers">
            {call.trackers.map((t) => (
              <span key={t} className="rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 font-mono text-[11px] text-emerald-300">{t}</span>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}

function escapeRx(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function Highlighted({ text, rx }: { text: string; rx: RegExp | null }) {
  if (!rx) return <>{text}</>;
  const parts = text.split(rx);
  return (
    <>
      {/* Pieces of one immutable string, re-split on every render: position is the identity. */}
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded bg-emerald-500/20 px-0.5 text-emerald-300">
            {p}
          </mark>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

export default function CallDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const meta = useMeta();
  const keywords = useKeywords();

  const { data: call, isError } = useQuery({
    queryKey: ["call", id],
    queryFn: () => apiGet<Call>(`/calls/${id}`),
    refetchInterval: (q) => (q.state.data?.status === "processing" ? 3000 : false),
  });

  const rx = useMemo(() => {
    const alts = (keywords.data ?? []).flatMap((k) => k.keyword.split("/").map((v) => v.trim())).filter(Boolean);
    return alts.length ? new RegExp(`\\b(${alts.map(escapeRx).join("|")})\\b`, "gi") : null;
  }, [keywords.data]);

  const reanalyze = useMutation({
    mutationFn: () => apiPost(`/calls/${id}/reanalyze`),
    onSuccess: () => {
      toast.info("Re-analyzing call…");
      qc.invalidateQueries({ queryKey: ["call", id] });
      qc.invalidateQueries({ queryKey: ["calls"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: () => apiDelete(`/calls/${id}`),
    onSuccess: () => {
      toast.success("Call deleted — undo it from Clean up → Recently deleted for 7 days");
      qc.invalidateQueries({ queryKey: ["calls"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
      nav("/calls");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const back = (
    <Link to="/calls" data-testid="back-to-calls" className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-white">
      <ArrowLeft className="size-4" /> Call library
    </Link>
  );

  if (isError) return <>{back}<Panel testId="call-not-found">Call not found or unavailable.</Panel></>;
  if (!call) return <>{back}<div className="h-40 animate-pulse rounded-xl bg-card" /></>;

  const processing = call.status === "processing";
  const tier = scoreTier(call.overall_score);

  return (
    <>
      {back}
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <Overline>
            {call.source === "audio" ? "Audio call · Whisper transcript" : "Transcript"} · {fmtDate(call.created_at)}
          </Overline>
          <h1 data-testid="call-customer-name" className="mt-2 text-3xl font-bold text-white md:text-4xl">
            {call.customer_name}
          </h1>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-slate-400">
            <span data-testid="call-rep-name">Rep: <span className="text-slate-200">{call.rep_name}</span></span>
            {(call.status === "analyzed" || call.status === "imported") && (
              <>
                <CategoryBadge category={call.category} testId="call-category" />
                <OutcomeBadge outcome={call.outcome} testId="call-outcome" />
                {priceMissing(call) && <PriceMissingBadge testId="call-price-missing" />}
                {call.delivery_kind && (
                  <span data-testid="call-delivery-kind" className="rounded border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-sky-300">
                    {call.delivery_kind === "confirmation" ? "delivery confirmation" : "delivery question"}
                  </span>
                )}
                <VehicleEditor call={call} />
              </>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          {(call.transcript || call.has_audio) && (
            <Button variant="outline" data-testid="call-reanalyze-button" onClick={() => reanalyze.mutate()} disabled={processing || reanalyze.isPending}>
              <RefreshCw className={cn("size-4", processing && "animate-spin")} /> Re-analyze
            </Button>
          )}
          {isManagerLike(me?.role) && <AddToCallbacks callIds={[call.id]} size="default" />}
          {isManagerLike(me?.role) && (
            <Button
              variant="destructive"
              data-testid="call-delete-button"
              onClick={() => confirm("Delete this call?") && remove.mutate()}
              disabled={remove.isPending}
            >
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>
      </div>

      {processing && (
        <Panel testId="call-processing" className="mb-6 border-amber-500/30">
          <p className="font-heading text-lg font-semibold text-white">
            {call.source === "audio" && !call.transcript ? "Transcribing audio with Whisper…" : "Claude is scoring this call…"}
          </p>
          <p className="mt-1 text-sm text-slate-400">Categorizing, scoring 7 metrics and writing coaching feedback. Usually 15–40 seconds.</p>
          <div className="relative mt-4 h-1 overflow-hidden rounded bg-slate-800">
            <div className="scan-bar absolute inset-y-0 w-1/3 bg-amber-500" />
          </div>
        </Panel>
      )}
      {call.status === "failed" && (
        <Panel testId="call-failed" className="mb-6 border-red-500/40">
          <p className="font-semibold text-red-300">Analysis failed</p>
          <p className="mt-1 text-sm text-slate-400">{call.error || "Try re-analyzing."}</p>
        </Panel>
      )}

      {(call.status === "analyzed" || call.status === "imported") && <SaleBox call={call} />}
      {!!call.delivery_kind && <DeliveryScoreCard call={call} />}
      <CustomerCallsPanel call={call} />
      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-12">
        <div className="space-y-6 xl:col-span-7">
          {call.source === "ringcentral" && <RingCentralPanel call={call} />}
          {call.has_audio && (
            <Panel testId="call-audio-panel">
              <Overline className="mb-3">Recording</Overline>
              <audio data-testid="call-audio-player" controls src={`/api/calls/${call.id}/audio`} className="w-full" />
            </Panel>
          )}
          {call.summary && (
            <Panel testId="call-summary-panel">
              <Overline>AI summary</Overline>
              <p data-testid="call-summary" className="mt-2 text-[15px] leading-relaxed text-slate-200">{call.summary}</p>
            </Panel>
          )}
          {!call.transcript && !call.has_audio && !processing && <AttachPanel callId={call.id} />}
          {(call.transcript || call.turns.length > 0 || processing) && (
          <Panel testId="call-transcript-panel">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-xl font-bold text-white">Transcript</h3>
              <div className="flex flex-wrap gap-1.5" data-testid="call-keyword-hits">
                {call.keyword_hits.map((k) => (
                  <span key={k.keyword} className="rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 font-mono text-[11px] text-emerald-300">
                    {k.keyword} ×{k.count}
                  </span>
                ))}
              </div>
            </div>
            <div className="max-h-[640px] space-y-3 overflow-y-auto pr-1">
              {call.turns.length > 0
                ? call.turns.map((t, i) => {
                    const isRep = /rep|agent|sales/i.test(t.speaker);
                    return (
                      <div key={`${i}-${t.speaker}`} data-testid={`transcript-turn-${i}`} className={cn("flex", isRep ? "justify-start" : "justify-end")}>
                        <div className={cn("max-w-[85%] rounded-xl px-4 py-3", isRep ? "bg-secondary" : "border border-slate-800 bg-surface-2")}>
                          <p className={cn("mb-1 font-mono text-[10px] uppercase tracking-wider", isRep ? "text-amber-400" : "text-sky-400")}>{t.speaker}</p>
                          <p className="text-[15px] leading-relaxed text-slate-200">
                            <Highlighted text={t.text} rx={rx} />
                          </p>
                        </div>
                      </div>
                    );
                  })
                : <p className="whitespace-pre-wrap text-sm text-slate-400"><Highlighted text={call.transcript || "Transcript pending…"} rx={rx} /></p>}
            </div>
          </Panel>
          )}
        </div>

        {call.status === "imported" && (
          <div className="space-y-6 xl:col-span-5">
            <Panel testId="call-rc-scorecard">
              <div className="flex items-center gap-5">
                <ScoreBadge score={call.overall_score} size="lg" testId="call-overall-score" />
                <div>
                  <Overline>RingCentral AI score</Overline>
                  <p className="mt-1 font-heading text-2xl font-bold" style={{ color: tier.color }}>{tier.label}</p>
                  <p className="text-sm text-slate-400">{call.overall_score / 10}/10 from RingCentral ACE, scaled to 100</p>
                </div>
              </div>
              {call.keyword_hits.length > 0 && (
                <div className="mt-5 flex flex-wrap gap-1.5" data-testid="call-keyword-hits">
                  {call.keyword_hits.map((k) => (
                    <span key={k.keyword} className="rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 font-mono text-[11px] text-emerald-300">
                      {k.keyword} ×{k.count}
                    </span>
                  ))}
                </div>
              )}
            </Panel>
          </div>
        )}

        {call.status === "analyzed" && (
          <div className="space-y-6 xl:sticky xl:top-6 xl:col-span-5">
            {!call.delivery_kind && <Panel testId="call-scorecard">
              <div className="flex items-center gap-5">
                <ScoreBadge score={call.overall_score} size="lg" testId="call-overall-score" />
                <div>
                  <Overline>Overall QA score</Overline>
                  <p className="mt-1 font-heading text-2xl font-bold" style={{ color: tier.color }}>{tier.label}</p>
                  <p className="text-sm text-slate-400">Weighted across 7 metrics</p>
                </div>
              </div>
              {(call.order_value > 0 || call.quoted_value > 0) && (
                <div className="mt-5 grid grid-cols-2 gap-3" data-testid="call-values">
                  <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3">
                    <p className="font-mono text-[10px] uppercase tracking-wider text-emerald-400">Order value</p>
                    <p data-testid="call-order-value" className="mt-1 font-heading text-xl font-bold text-white">${Math.round(call.order_value).toLocaleString()}</p>
                  </div>
                  <div className="rounded-lg border border-sky-500/25 bg-sky-500/5 p-3">
                    <p className="font-mono text-[10px] uppercase tracking-wider text-sky-400">Quoted</p>
                    <p data-testid="call-quoted-value" className="mt-1 font-heading text-xl font-bold text-white">${Math.round(call.quoted_value).toLocaleString()}</p>
                  </div>
                </div>
              )}
              <div className="mt-6">
                <MetricBars metrics={call.metrics} defs={meta.data?.metrics ?? []} testPrefix="metric-score" />
              </div>
            </Panel>}
            <Panel testId="call-coaching-panel" className="border-amber-500/30 bg-gradient-to-b from-amber-500/[0.06] to-card">
              <div className="flex items-center gap-2">
                <GraduationCap className="size-5 text-amber-400" />
                <h3 className="text-xl font-bold text-white">Coaching feedback</h3>
              </div>
              <p data-testid="call-coaching-feedback" className="mt-3 text-[15px] leading-relaxed text-slate-200">{call.coaching_feedback}</p>
            </Panel>
            <Panel testId="call-strengths-panel">
              <div className="mb-3 flex items-center gap-2"><ThumbsUp className="size-4 text-emerald-400" /><h4 className="font-bold text-white">What went well</h4></div>
              <BulletList items={call.strengths} tone="good" testId="call-strengths" />
              <div className="mb-3 mt-6 flex items-center gap-2"><TrendingUp className="size-4 text-amber-400" /><h4 className="font-bold text-white">Improve next time</h4></div>
              <BulletList items={call.improvements} tone="bad" testId="call-improvements" />
            </Panel>
            <Panel testId="call-insights-panel">
              <div className="mb-3 flex items-center gap-2"><Lightbulb className="size-4 text-sky-400" /><h4 className="font-bold text-white">Key insights</h4></div>
              <BulletList items={call.insights} tone="info" testId="call-insights" />
            </Panel>
          </div>
        )}
      </div>
    </>
  );
}
