import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  ExternalLink,
  Loader2,
  Phone,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Trash2,
  UploadCloud,
  Webhook,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Overline, PageHeader, Panel, fmtDate } from "@/components/common";
import { apiDelete, apiGet, apiPost, apiPut, errorMessage } from "@/lib/api";
import type { AuthUrl, ConnectorStatus, IngestEvent, IngestSettings, SyncResult, User } from "@/lib/types";
import { cn } from "@/lib/utils";

const GENERIC_SAMPLE = `{
  "call_id": "abc-123",
  "start_time": "2026-10-23T14:05:00Z",
  "direction": "inbound",
  "from": "+18605550123",
  "to": "+18605550199",
  "agent_email": "tyler@yourdomain.com",
  "caller_name": "Ridgeline Collision",
  "duration": 184,
  "status": "completed",
  "recording_url": "https://provider.example/recording.mp3",
  "transcript": "optional — skip AI transcription by sending text"
}`;

const PROVIDER_LABEL: Record<string, string> = {
  generic: "Generic",
  twilio: "Twilio",
  ringcentral: "RingCentral",
  telnyx: "Telnyx",
  vonage: "Vonage",
};

const PROVIDER_COPY: Record<string, { title: string; body: string; hint: string }> = {
  generic: {
    title: "Generic / any provider",
    body: "Point any PBX, Zapier/Make flow or custom integration at this URL. Common field names are recognised automatically; recordings can also be pushed as files.",
    hint: "Use the /generic path when your sender does not identify itself with an X-Call-Provider header.",
  },
  twilio: {
    title: "Twilio",
    body: "Set this as the Voice status callback URL and/or the Recording status callback URL in Twilio. Status and recording callbacks are merged by CallSid.",
    hint: "If your Twilio recording URL requires authentication, add the Account SID and Auth Token under Provider authentication.",
  },
  ringcentral: {
    title: "RingCentral",
    body: "Create a webhook subscription for telephony sessions and point it here. The validation-token handshake is handled automatically; add a verification token below if you set one in RingCentral.",
    hint: "RingCentral's end event does not include audio. Add a JWT app credential below and the adapter will find the call's recording in the RingCentral call log.",
  },
  telnyx: {
    title: "Telnyx",
    body: "Point your Call Control webhook at this URL. Telnyx's call_control_id is used as the dedupe key and state events are normalised automatically.",
    hint: "Add a signing secret below if you want the shared-secret header check enabled.",
  },
  vonage: {
    title: "Vonage / Nexmo",
    body: "Use this URL in the Voice API answer/event webhook. call_id is the dedupe key; recording URLs are downloaded and transcribed.",
    hint: "Add a signing secret below if you want the shared-secret header check enabled.",
  },
};

function statusIcon(status: IngestEvent["status"]) {
  if (status === "completed") return <CheckCircle2 className="size-4 text-emerald-400" />;
  if (status === "failed") return <XCircle className="size-4 text-red-400" />;
  if (status === "duplicate") return <ShieldCheck className="size-4 text-sky-400" />;
  if (status === "waiting") return <AlertTriangle className="size-4 text-amber-300" />;
  return <Loader2 className="size-4 animate-spin text-amber-300" />;
}

const STATUS_STYLE: Record<string, string> = {
  completed: "text-emerald-300",
  failed: "text-red-300",
  duplicate: "text-sky-300",
  waiting: "text-amber-200",
  queued: "text-amber-200",
  processing: "text-amber-200",
};

export default function Connectors() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const reps = useQuery({ queryKey: ["reps", { ingest: true }], queryFn: () => apiGet<User[]>("/users/reps?include_managers=true") });
  const settings = useQuery({ queryKey: ["ingest-settings"], queryFn: () => apiGet<IngestSettings>("/ingest/settings") });
  const events = useQuery({
    queryKey: ["ingest-events"],
    queryFn: () => apiGet<IngestEvent[]>("/ingest/events?limit=30"),
    refetchInterval: 5000,
  });
  const connector = useQuery({ queryKey: ["connectors"], queryFn: () => apiGet<ConnectorStatus>("/connect/status") });

  const [provider, setProvider] = useState("generic");
  const [stt, setStt] = useState<IngestSettings["stt_provider"]>("auto");
  const [defaultRep, setDefaultRep] = useState("");
  const [autoCreate, setAutoCreate] = useState(false);
  const [secrets, setSecrets] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!settings.data) return;
    setStt(settings.data.stt_provider);
    setDefaultRep(settings.data.default_rep_id);
    setAutoCreate(settings.data.auto_create_reps);
  }, [settings.data?.updated_at]);

  useEffect(() => {
    const r = params.get("ringcentral");
    if (r) {
      if (r === "connected") toast.success("RingCentral connected — click Sync now to pull the last 30 days");
      else toast.error("RingCentral connection was cancelled");
      setParams({}, { replace: true });
    }
  }, [params, setParams]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["ingest-settings"] });
    qc.invalidateQueries({ queryKey: ["ingest-events"] });
  };

  const save = useMutation({
    mutationFn: () => {
      const providers: Record<string, Record<string, string>> = {};
      const put = (name: string, field: string, value: string | undefined) => {
        const trimmed = (value ?? "").trim();
        if (!trimmed) return;
        providers[name] = { ...(providers[name] ?? {}), [field]: trimmed };
      };
      put("generic", "signing_secret", secrets.genericSigning);
      put("generic", "media_bearer_token", secrets.genericMedia);
      put("twilio", "signing_secret", secrets.twilioSigning);
      put("twilio", "account_sid", secrets.twilioSid);
      put("twilio", "auth_token", secrets.twilioToken);
      put("telnyx", "signing_secret", secrets.telnyxSigning);
      put("vonage", "signing_secret", secrets.vonageSigning);
      put("ringcentral", "signing_secret", secrets.ringcentralSigning);
      put("ringcentral", "client_id", secrets.ringcentralClientId);
      put("ringcentral", "client_secret", secrets.ringcentralSecret);
      put("ringcentral", "jwt", secrets.ringcentralJwt);
      return apiPut<IngestSettings>("/ingest/settings", {
        stt_provider: stt,
        default_rep_id: defaultRep,
        auto_create_reps: autoCreate,
        providers,
      });
    },
    onSuccess: () => {
      setSecrets({});
      toast.success("Ingestion settings saved");
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e, "Could not save ingestion settings")),
  });

  const rotate = useMutation({
    mutationFn: () => apiPost<IngestSettings>("/ingest/rotate"),
    onSuccess: () => {
      toast.success("New webhook URL created — the old one stops working");
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e, "Could not rotate the webhook URL")),
  });

  const retry = useMutation({
    mutationFn: (id: string) => apiPost<IngestEvent>(`/ingest/events/${id}/retry`),
    onSuccess: () => {
      toast.success("Retry queued");
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e, "Could not retry this call")),
  });

  const clearEvents = useMutation({
    mutationFn: () => apiDelete<{ ok: boolean }>("/ingest/events"),
    onSuccess: () => {
      toast.success("Ingestion log cleared");
      refresh();
    },
  });

  const connect = useMutation({
    mutationFn: () => apiGet<AuthUrl>("/connect/ringcentral/start"),
    onSuccess: (r) => window.location.assign(r.authorize_url),
    onError: (e) => toast.error(errorMessage(e, "Couldn't start RingCentral sign-in")),
  });
  const sync = useMutation({
    mutationFn: () => apiPost<SyncResult>("/connect/ringcentral/sync"),
    onSuccess: (r) => {
      toast.success(`Synced: ${r.imported} new calls, ${r.updated} updated`);
      qc.invalidateQueries({ queryKey: ["connectors"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
    },
    onError: (e) => toast.error(errorMessage(e, "Sync failed")),
  });
  const disconnect = useMutation({
    mutationFn: () => apiDelete<ConnectorStatus>("/connect/ringcentral"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["connectors"] }),
  });

  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => toast.success("Copied"));
  const endpoint = settings.data?.provider_urls?.[provider] ?? settings.data?.webhook_url ?? "";
  const providerCopy = PROVIDER_COPY[provider] ?? PROVIDER_COPY.generic;
  const configured = settings.data?.providers ?? {};
  const sttReady = settings.data?.stt_available ?? {};
  const rc = connector.data?.ringcentral;
  const repOptions = useMemo(() => reps.data ?? [], [reps.data]);
  const active = (events.data ?? []).filter((event) => event.status === "queued" || event.status === "processing").length;

  return (
    <>
      <PageHeader overline="Integrations" title="Call ingestion" />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        <Panel className="xl:col-span-8" testId="ingest-panel">
          <Overline>VoIP agnostic</Overline>
          <h3 className="mt-1 flex items-center gap-2 text-xl font-bold text-white">
            <Webhook className="size-5 text-sky-400" /> One webhook for any phone system
          </h3>
          <p className="mt-2 max-w-3xl text-sm text-slate-400">
            Every provider sends the same thing: who called, who answered, when, and (optionally) a recording or transcript.
            Point any PBX at this endpoint. We normalise the event, download the recording, transcribe it with your chosen AI
            provider, and score it with your yard rubric. No vendor lock-in.
          </p>

          {settings.isLoading ? (
            <div className="mt-6 flex items-center gap-2 text-sm text-slate-400"><Loader2 className="size-4 animate-spin" /> Loading ingestion settings…</div>
          ) : settings.isError ? (
            <p className="mt-5 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
              {errorMessage(settings.error, "Could not load ingestion settings")}
            </p>
          ) : (
            <>
              <div className="mt-5 flex flex-wrap gap-2" data-testid="ingest-provider-tabs">
                {Object.keys(PROVIDER_COPY).map((name) => (
                  <button
                    key={name}
                    onClick={() => setProvider(name)}
                    className={cn(
                      "rounded-md border px-3 py-1.5 text-xs font-medium capitalize transition-colors",
                      provider === name ? "border-amber-400/60 bg-amber-500/15 text-amber-200" : "border-border text-slate-400 hover:text-white",
                    )}
                  >
                    {PROVIDER_LABEL[name] ?? name}
                  </button>
                ))}
              </div>

              <div className="mt-4 rounded-xl border border-border bg-surface p-4">
                <p className="font-heading text-base font-semibold text-white">{providerCopy.title}</p>
                <p className="mt-1 text-sm text-slate-400">{providerCopy.body}</p>
                <div className="mt-3 flex items-center gap-2 rounded-lg border border-border bg-black/20 px-3 py-2">
                  <code data-testid="ingest-webhook-url" className="flex-1 truncate font-mono text-xs text-slate-200">{endpoint}</code>
                  <button onClick={() => copy(endpoint)} className="text-slate-400 hover:text-white" title="Copy webhook URL">
                    <Copy className="size-4" />
                  </button>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <Button variant="ghost" size="sm" data-testid="ingest-rotate-button" onClick={() => rotate.mutate()} disabled={rotate.isPending}>
                    {rotate.isPending ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />} Create a new URL
                  </Button>
                  <span className="text-xs text-slate-500">{providerCopy.hint}</span>
                </div>
              </div>

              <div className="mt-6 grid gap-5 md:grid-cols-2">
                <div>
                  <Label htmlFor="ingest-stt">AI transcription</Label>
                  <Select value={stt} onValueChange={(value) => setStt(value as IngestSettings["stt_provider"])}>
                    <SelectTrigger id="ingest-stt" className="mt-2" data-testid="ingest-stt-select">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">Automatic (best configured provider)</SelectItem>
                      <SelectItem value="gemini">Google Gemini {sttReady.gemini ? "" : "(no key)"}</SelectItem>
                      <SelectItem value="deepgram">Deepgram {sttReady.deepgram ? "" : "(no key)"}</SelectItem>
                      <SelectItem value="assemblyai">AssemblyAI {sttReady.assemblyai ? "" : "(no key)"}</SelectItem>
                      <SelectItem value="openai">OpenAI Whisper {sttReady.openai ? "" : "(no key)"}</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="mt-1 text-xs text-slate-500">
                    Gemini also scores the call in one pass. If the provider sends a transcript, no STT key is needed.
                  </p>
                </div>
                <div>
                  <Label htmlFor="ingest-default-rep">Default rep</Label>
                  <Select value={defaultRep || "none"} onValueChange={(value) => setDefaultRep(value === "none" ? "" : value)}>
                    <SelectTrigger id="ingest-default-rep" className="mt-2" data-testid="ingest-default-rep">
                      <SelectValue placeholder="Match from the payload" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Match from the payload</SelectItem>
                      {repOptions.map((rep) => (
                        <SelectItem key={rep.id} value={rep.id}>{rep.name}{rep.title ? ` · ${rep.title}` : ""}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="mt-1 text-xs text-slate-500">
                    Used when a provider omits the agent email or extension. Otherwise calls are attributed to the yard owner.
                  </p>
                </div>
              </div>

              <label className="mt-4 flex items-center gap-3 text-sm text-slate-300">
                <Checkbox data-testid="ingest-auto-create-reps" checked={autoCreate} onCheckedChange={(value) => setAutoCreate(!!value)} />
                Create a rep login automatically when an unknown agent email appears
              </label>

              <details className="mt-5 rounded-xl border border-border bg-surface/60 p-4">
                <summary className="cursor-pointer select-none text-sm font-semibold text-white">
                  {PROVIDER_LABEL[provider] ?? "Provider"} authentication (optional)
                </summary>
                <p className="mt-2 text-xs text-slate-500">
                  Secrets are stored server-side and never returned by the API. Leave a secret blank to keep the saved value.
                </p>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  {provider === "generic" && (
                    <>
                      <div>
                        <Label htmlFor="ingest-generic-signing">Signing secret {configured.generic?.signing_configured ? "· saved" : ""}</Label>
                        <Input id="ingest-generic-signing" data-testid="ingest-generic-signing" type="password" autoComplete="off" placeholder={configured.generic?.signing_configured ? "••••••••" : "HMAC-SHA256 secret"} value={secrets.genericSigning ?? ""} onChange={(e) => setSecrets((s) => ({ ...s, genericSigning: e.target.value }))} className="mt-2" />
                      </div>
                      <div>
                        <Label htmlFor="ingest-generic-media">Recording bearer token {configured.generic?.media_auth_configured ? "· saved" : ""}</Label>
                        <Input id="ingest-generic-media" type="password" autoComplete="off" placeholder="Only if recordings need auth" value={secrets.genericMedia ?? ""} onChange={(e) => setSecrets((s) => ({ ...s, genericMedia: e.target.value }))} className="mt-2" />
                      </div>
                    </>
                  )}
                  {provider === "twilio" && (
                    <>
                      <div>
                        <Label htmlFor="ingest-twilio-signing">Auth Token / signing secret {configured.twilio?.signing_configured ? "· saved" : ""}</Label>
                        <Input id="ingest-twilio-signing" type="password" autoComplete="off" placeholder={configured.twilio?.signing_configured ? "••••••••" : "Auth Token"} value={secrets.twilioSigning ?? ""} onChange={(e) => setSecrets((s) => ({ ...s, twilioSigning: e.target.value }))} className="mt-2" />
                      </div>
                      <div>
                        <Label htmlFor="ingest-twilio-sid">Account SID</Label>
                        <Input id="ingest-twilio-sid" autoComplete="off" placeholder={configured.twilio?.account_sid || "AC…"} value={secrets.twilioSid ?? ""} onChange={(e) => setSecrets((s) => ({ ...s, twilioSid: e.target.value }))} className="mt-2" />
                      </div>
                      <div className="md:col-span-2">
                        <Label htmlFor="ingest-twilio-token">Optional separate recording token {configured.twilio?.media_auth_configured ? "· saved" : ""}</Label>
                        <Input id="ingest-twilio-token" type="password" autoComplete="off" placeholder="Defaults to the Auth Token above" value={secrets.twilioToken ?? ""} onChange={(e) => setSecrets((s) => ({ ...s, twilioToken: e.target.value }))} className="mt-2" />
                      </div>
                    </>
                  )}
                  {provider === "ringcentral" && (
                    <>
                      <div>
                        <Label htmlFor="ingest-rc-signing">Verification token {configured.ringcentral?.signing_configured ? "· saved" : ""}</Label>
                        <Input id="ingest-rc-signing" type="password" autoComplete="off" placeholder={configured.ringcentral?.signing_configured ? "••••••••" : "Optional verification token"} value={secrets.ringcentralSigning ?? ""} onChange={(e) => setSecrets((s) => ({ ...s, ringcentralSigning: e.target.value }))} className="mt-2" />
                      </div>
                      <div>
                        <Label htmlFor="ingest-rc-client">Client ID {configured.ringcentral?.client_id ? "· saved" : ""}</Label>
                        <Input id="ingest-rc-client" autoComplete="off" placeholder={configured.ringcentral?.client_id || "JWT app client id"} value={secrets.ringcentralClientId ?? ""} onChange={(e) => setSecrets((s) => ({ ...s, ringcentralClientId: e.target.value }))} className="mt-2" />
                      </div>
                      <div>
                        <Label htmlFor="ingest-rc-secret">Client Secret {configured.ringcentral?.media_auth_configured ? "· saved" : ""}</Label>
                        <Input id="ingest-rc-secret" type="password" autoComplete="off" placeholder="JWT app client secret" value={secrets.ringcentralSecret ?? ""} onChange={(e) => setSecrets((s) => ({ ...s, ringcentralSecret: e.target.value }))} className="mt-2" />
                      </div>
                      <div>
                        <Label htmlFor="ingest-rc-jwt">JWT</Label>
                        <Input id="ingest-rc-jwt" type="password" autoComplete="off" placeholder="Only needed to fetch RingCentral recordings" value={secrets.ringcentralJwt ?? ""} onChange={(e) => setSecrets((s) => ({ ...s, ringcentralJwt: e.target.value }))} className="mt-2" />
                      </div>
                    </>
                  )}
                  {provider === "telnyx" && (
                    <div className="md:col-span-2">
                      <Label htmlFor="ingest-telnyx-signing">Shared secret {configured.telnyx?.signing_configured ? "· saved" : ""}</Label>
                      <Input id="ingest-telnyx-signing" type="password" autoComplete="off" placeholder={configured.telnyx?.signing_configured ? "••••••••" : "Optional X-Ingest-Secret value"} value={secrets.telnyxSigning ?? ""} onChange={(e) => setSecrets((s) => ({ ...s, telnyxSigning: e.target.value }))} className="mt-2" />
                      <p className="mt-1 text-xs text-slate-500">Recording downloads can also use the server-level TELNYX_API_KEY.</p>
                    </div>
                  )}
                  {provider === "vonage" && (
                    <div className="md:col-span-2">
                      <Label htmlFor="ingest-vonage-signing">Shared secret {configured.vonage?.signing_configured ? "· saved" : ""}</Label>
                      <Input id="ingest-vonage-signing" type="password" autoComplete="off" placeholder={configured.vonage?.signing_configured ? "••••••••" : "Optional X-Ingest-Secret value"} value={secrets.vonageSigning ?? ""} onChange={(e) => setSecrets((s) => ({ ...s, vonageSigning: e.target.value }))} className="mt-2" />
                    </div>
                  )}
                </div>
              </details>

              <div className="mt-5 flex items-center justify-between gap-3">
                <p className="text-xs text-slate-500">Changes apply to new calls. Existing calls are never re-scored automatically.</p>
                <Button data-testid="ingest-save-button" onClick={() => save.mutate()} disabled={save.isPending}>
                  {save.isPending && <Loader2 className="size-4 animate-spin" />} Save ingestion settings
                </Button>
              </div>
            </>
          )}
        </Panel>

        <Panel className="xl:col-span-4" testId="ingest-events-panel">
          <div className="flex items-center justify-between gap-2">
            <div>
              <Overline>Live log</Overline>
              <h3 className="mt-1 text-xl font-bold text-white">Recent ingestions</h3>
            </div>
            {active > 0 && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-amber-300">{active} working</span>}
          </div>
          <div className="mt-4 space-y-2">
            {(events.data ?? []).length === 0 && (
              <div className="rounded-lg border border-dashed border-slate-700 p-6 text-center" data-testid="ingest-events-empty">
                <p className="text-sm font-medium text-slate-200">No calls yet</p>
                <p className="mt-1 text-xs text-slate-500">Send a test call or point your phone system at the webhook above.</p>
              </div>
            )}
            {(events.data ?? []).map((event) => (
              <div key={event.id} className="rounded-lg border border-border bg-surface px-3 py-2.5" data-testid={`ingest-event-${event.id}`}>
                <div className="flex items-start gap-2">
                  <span className="mt-0.5">{statusIcon(event.status)}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-medium text-white">{event.customer_name || event.external_id || "Call event"}</p>
                      <span className={cn("font-mono text-[10px] uppercase tracking-wider", STATUS_STYLE[event.status] ?? "text-slate-400")}>{event.status}</span>
                    </div>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-slate-500">
                      {event.provider} · {event.rep_name || "unmatched rep"} · {fmtDate(event.created_at)}
                    </p>
                    {event.message && <p className="mt-1 line-clamp-2 text-xs text-slate-400">{event.message}</p>}
                    <div className="mt-1.5 flex items-center gap-3">
                      {event.call_id && (
                        <a href={`/calls/${event.call_id}`} className="inline-flex items-center gap-1 text-xs text-sky-400 hover:underline">
                          Open call <ExternalLink className="size-3" />
                        </a>
                      )}
                      {event.status === "failed" && (
                        <button onClick={() => retry.mutate(event.id)} disabled={retry.isPending} className="inline-flex items-center gap-1 text-xs text-amber-300 hover:underline">
                          <RefreshCw className="size-3" /> Retry
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
          {(events.data ?? []).length > 0 && (
            <button onClick={() => clearEvents.mutate()} className="mt-3 inline-flex items-center gap-1 text-xs text-slate-500 hover:text-red-300">
              <Trash2 className="size-3" /> Clear log
            </button>
          )}
        </Panel>

        <Panel className="xl:col-span-12" testId="ingest-quickstart-panel">
          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <Overline>Quick start</Overline>
              <h3 className="mt-1 flex items-center gap-2 text-lg font-bold text-white"><Sparkles className="size-4 text-amber-400" /> Send a call with a transcript</h3>
              <p className="mt-1 text-sm text-slate-400">No STT key needed. Send the finished transcript and the platform scores it immediately.</p>
              <pre className="mt-3 max-h-72 overflow-auto rounded-lg bg-surface p-3 font-mono text-[11px] text-slate-300">
{`curl -X POST "${settings.data?.webhook_url ?? "https://your-app/api/ingest/webhook/TOKEN"}?wait=1" \\
  -H "Content-Type: application/json" \\
  -d '${GENERIC_SAMPLE.replace(/\n/g, "\n     ")}'`}
              </pre>
            </div>
            <div>
              <Overline>Or push a recording</Overline>
              <h3 className="mt-1 flex items-center gap-2 text-lg font-bold text-white"><UploadCloud className="size-4 text-sky-400" /> Audio upload endpoint</h3>
              <p className="mt-1 text-sm text-slate-400">Any system that can POST a file can use the same pipeline. The recording is stored and transcribed with your selected AI provider.</p>
              <pre className="mt-3 overflow-auto rounded-lg bg-surface p-3 font-mono text-[11px] text-slate-300">
{`curl -X POST "${settings.data?.audio_upload_url ?? "https://your-app/api/ingest/audio/TOKEN"}" \\
  -F "file=@call.mp3" \\
  -F "external_id=call-123" \\
  -F "agent_email=tyler@yourdomain.com" \\
  -F "customer_name=Ridgeline Collision" \\
  -F "direction=inbound"`}
              </pre>
              <div className="mt-3 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-100">
                <p className="font-semibold">Where the AI keys live</p>
                <p className="mt-1 text-sky-200/80">
                  Server environment only, never in the browser: GEMINI_API_KEY (recommended), DEEPGRAM_API_KEY, ASSEMBLYAI_API_KEY or OPENAI_API_KEY.
                  Set INGEST_STT_PROVIDER to force one provider.
                </p>
              </div>
            </div>
          </div>
        </Panel>

        {provider === "ringcentral" && (
          <Panel className="xl:col-span-12" testId="ringcentral-panel">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <Overline>Optional legacy sync</Overline>
                <h3 className="mt-1 flex items-center gap-2 text-xl font-bold text-white">
                  <Phone className="size-5 text-sky-400" /> RingCentral call-log sync
                </h3>
                <p className="mt-2 max-w-3xl text-sm text-slate-400">
                  Pull metadata and existing recordings from RingCentral's call log every 30 minutes. This is not required for live ingestion — the universal endpoint above works with any provider.
                </p>
              </div>
              {rc?.connected ? (
                <div className="flex gap-2">
                  <Button size="sm" disabled={sync.isPending} onClick={() => sync.mutate()}>
                    {sync.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Sync now
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => disconnect.mutate()}>Disconnect</Button>
                </div>
              ) : (
                <Button size="sm" disabled={!rc?.configured || connect.isPending} onClick={() => connect.mutate()}>
                  {connect.isPending && <Loader2 className="size-4 animate-spin" />} Connect RingCentral
                </Button>
              )}
            </div>
            {rc?.connected ? (
              <p className="mt-3 text-sm text-emerald-300">
                Connected by {rc.connected_by}. {rc.last_sync_at ? `Last sync ${fmtDate(rc.last_sync_at)} — ${rc.last_result}` : rc.last_result}
              </p>
            ) : (
              <p className="mt-3 text-sm text-amber-200/80">
                {rc?.configured ? "Not connected." : "RingCentral OAuth is not configured on this server. The universal webhook above is the recommended path."}
              </p>
            )}
          </Panel>
        )}
      </div>
    </>
  );
}
