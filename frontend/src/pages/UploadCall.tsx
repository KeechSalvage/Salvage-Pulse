import RecentUploads from "@/components/RecentUploads";
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileAudio, FileSpreadsheet, FileText, Loader2, UploadCloud, X } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Overline, PageHeader, Panel } from "@/components/common";
import { apiGet, apiPost, apiUpload, errorMessage } from "@/lib/api";
import { useMe, useReps } from "@/lib/hooks";
import ImportVehicleSummary from "@/components/ImportVehicleSummary";
import { cn } from "@/lib/utils";
import type { BulkAudioResult, Call, CallCoverage, ImportResult, TranscriptCreate } from "@/lib/types";

const fmtDay = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—");

const SAMPLE = `Rep: Thanks for calling Salvage Pulse Pro, this is Chris.
Customer: Hey, I need a driver side headlight for a 2019 Honda Civic.
Rep: Sure, is it the LED or halogen? Do you have the VIN handy?
Customer: LED, I don't have the VIN on me.
Rep: No problem. I have an OEM LED assembly, no broken tabs, $245 with a 90-day warranty.
Customer: That's a little high, aftermarket is like $150.
Rep: Understood. Aftermarket LED units often flicker and don't seal well. This is the factory Honda part, it'll plug right in. Want me to set it aside for you?
Customer: Yeah, hold it, I'll pick up today.
Rep: Done, it'll be at the front counter under your name.`;

const ACCEPT = ".mp3,.mp4,.mpeg,.mpga,.m4a,.wav,.webm";

export default function UploadCall() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const isManager = me?.role === "manager";
  const reps = useReps(isManager);
  const [mode, setMode] = useState<"audio" | "transcript" | "ringcentral">("audio");
  const [sheet, setSheet] = useState<File | null>(null);
  const [replaceDemo, setReplaceDemo] = useState(false);
  const coverage = useQuery({ queryKey: ["coverage"], queryFn: () => apiGet<CallCoverage>("/calls/coverage"), enabled: isManager });
  const [result, setResult] = useState<ImportResult | null>(null);
  const sheetRef = useRef<HTMLInputElement>(null);
  const [repId, setRepId] = useState("");
  const [customer, setCustomer] = useState("");
  const [transcript, setTranscript] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [bulk, setBulk] = useState<BulkAudioResult | null>(null);
  const file = files[0] ?? null;
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const done = (call: Call) => {
    qc.invalidateQueries({ queryKey: ["calls"] });
    qc.invalidateQueries({ queryKey: ["overview"] });
    toast.success("Call submitted — analysis started");
    nav(`/calls/${call.id}`);
  };

  const bulkUpload = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      files.forEach((f) => fd.append("files", f));
      if (isManager && repId) fd.append("rep_id", repId);
      return apiUpload<BulkAudioResult>("/calls/bulk-audio", fd);
    },
    onSuccess: (r) => {
      setBulk(r);
      setFiles([]);
      qc.invalidateQueries({ queryKey: ["calls"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
      toast.success(`${r.matched} matched · ${r.created} new · analysis running`);
    },
    onError: (e) => toast.error(errorMessage(e, "Bulk upload failed")),
  });

  const submit = useMutation({
    mutationFn: async () => {
      const rep = isManager ? repId || null : null;
      if (mode === "audio") {
        if (!file) throw new Error("no-file");
        const fd = new FormData();
        fd.append("file", file);
        fd.append("customer_name", customer);
        if (rep) fd.append("rep_id", rep);
        return apiUpload<Call>("/calls/audio", fd);
      }
      const body: TranscriptCreate = { customer_name: customer, transcript, rep_id: rep };
      return apiPost<Call>("/calls/transcript", body);
    },
    onSuccess: done,
    onError: (e) => toast.error(e instanceof Error && e.message === "no-file" ? "Choose an audio file first" : errorMessage(e, "Upload failed")),
  });

  const importCalls = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      if (sheet) fd.append("file", sheet);
      fd.append("replace_demo", String(replaceDemo));
      return apiUpload<ImportResult>("/calls/import", fd);
    },
    onSuccess: (r) => {
      setResult(r);
      setSheet(null);
      qc.invalidateQueries();
      toast.success(`Imported ${r.imported} new calls (${r.updated} updated)` + (r.vehicles ? ` · ${r.vehicles.matched} calls matched to vehicles` : ""));
    },
    onError: (e) => toast.error(errorMessage(e, "Import failed")),
  });

  const repName = (id: string) => reps.data?.find((r) => r.id === id)?.name ?? "Select rep";
  const isBulk = mode === "audio" && files.length > 1;
  const canSubmit = isBulk
    ? !bulkUpload.isPending
    : (!isManager || !!repId) && (mode === "audio" ? !!file : transcript.trim().length >= 20) && !submit.isPending;

  return (
    <>
      <PageHeader overline="Call ingestion" title="Upload a call for analysis" />
      <RecentUploads />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        <Panel className="xl:col-span-8" testId="upload-panel">
          <div className={cn("mb-6 grid gap-2 rounded-lg bg-surface p-1", isManager ? "grid-cols-3" : "grid-cols-2")}>
            {(isManager ? (["audio", "transcript", "ringcentral"] as const) : (["audio", "transcript"] as const)).map((m) => (
              <button
                key={m}
                data-testid={`upload-mode-${m}`}
                onClick={() => setMode(m)}
                className={cn(
                  "flex items-center justify-center gap-2 rounded-md py-2.5 text-sm font-medium transition-colors duration-150",
                  mode === m ? "bg-amber-500 text-primary-foreground" : "text-slate-400 hover:text-white",
                )}
              >
                {m === "audio" ? <FileAudio className="size-4" /> : m === "transcript" ? <FileText className="size-4" /> : <FileSpreadsheet className="size-4" />}
                {m === "audio" ? "Audio recording" : m === "transcript" ? "Paste transcript" : "RingCentral import"}
              </button>
            ))}
          </div>

          {mode === "ringcentral" ? (
            <div className="space-y-5">
              {coverage.data && (
                <div data-testid="import-coverage" className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-lg border border-border bg-surface px-4 py-3 text-sm">
                  <span className="font-mono text-[11px] uppercase tracking-wider text-slate-500">History loaded</span>
                  <span data-testid="import-coverage-range" className="text-white">
                    {fmtDay(coverage.data.earliest)} → {fmtDay(coverage.data.latest)}
                  </span>
                  <span data-testid="import-coverage-total" className="font-mono text-xs text-slate-400">{coverage.data.total} calls</span>
                  <span className="text-xs text-slate-500">Imports merge by Interaction ID. Upload older exports to extend history; duplicates are never added twice.</span>
                </div>
              )}
              <div
                data-testid="import-dropzone"
                onClick={() => sheetRef.current?.click()}
                className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-700 px-6 py-12 text-center transition-colors duration-150 hover:border-amber-500/60"
              >
                <input ref={sheetRef} type="file" accept=".csv,.xlsx,.xls" className="hidden" data-testid="import-file-input" onChange={(e) => setSheet(e.target.files?.[0] ?? null)} />
                <FileSpreadsheet className="size-10 text-amber-400" />
                {sheet ? (
                  <p data-testid="import-file-name" className="mt-4 font-mono text-sm text-white">{sheet.name}</p>
                ) : (
                  <>
                    <p className="mt-4 font-heading text-lg font-semibold text-white">Drop your RingCentral "Calls Data Export"</p>
                    <p className="mt-1 text-sm text-slate-400">CSV or XLSX · reps are matched by Host Email (new reps get a login)</p>
                  </>
                )}
              </div>
              <label className="flex items-center gap-3 text-sm text-slate-300">
                <Checkbox data-testid="import-replace-demo-checkbox" checked={replaceDemo} onCheckedChange={(v) => setReplaceDemo(!!v)} />
                Also remove sample demo reps & calls, if any are left
              </label>
              <div className="flex justify-end">
                <Button data-testid="import-submit-button" size="lg" disabled={!sheet || importCalls.isPending} onClick={() => importCalls.mutate()}>
                  {importCalls.isPending && <Loader2 className="size-4 animate-spin" />} Import calls
                </Button>
              </div>
              {result && (
                <div data-testid="import-result" className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-5">
                  <p className="font-heading text-lg font-bold text-white">Import complete</p>
                  <p data-testid="import-result-range" className="text-sm text-slate-400">File covers {fmtDay(result.file_from)} → {fmtDay(result.file_to)}</p>
                  <div className="mt-3 grid grid-cols-3 gap-4 font-mono text-sm">
                    <div><p className="text-2xl text-emerald-300" data-testid="import-result-imported">{result.imported}</p><p className="text-xs text-slate-500">new calls</p></div>
                    <div><p className="text-2xl text-sky-300" data-testid="import-result-updated">{result.updated}</p><p className="text-xs text-slate-500">updated</p></div>
                    <div><p className="text-2xl text-slate-300">{result.total_rows}</p><p className="text-xs text-slate-500">rows read</p></div>
                  </div>
                  {result.vehicles && <ImportVehicleSummary v={result.vehicles} total={result.total_rows} />}
                  {result.rep_logins.length > 0 && (
                    <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm" data-testid="import-new-logins">
                      <p className="text-amber-100">New staff logins — copy these temporary passwords now; they won't be shown again.</p>
                      <ul className="mt-2 space-y-1 font-mono text-xs text-slate-200">
                        {result.rep_logins.map((l) => (
                          <li key={l.email} data-testid={`import-login-${l.email}`}>
                            {l.name} · {l.email} · <span className="text-amber-300">{l.temp_password}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div className="mt-4 flex gap-3">
                    <Button variant="outline" data-testid="import-view-dashboard" onClick={() => nav("/dashboard")}>View dashboard</Button>
                    <Button variant="ghost" data-testid="import-view-calls" onClick={() => nav("/calls")}>Browse calls</Button>
                  </div>
                </div>
              )}
            </div>
          ) : (
          <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {isManager && (
              <div className="space-y-2">
                <Label>Sales rep on the call</Label>
                <Select value={repId} onValueChange={setRepId}>
                  <SelectTrigger data-testid="upload-rep-select" className="h-10 w-full bg-surface">
                    <SelectValue>{(v) => (v ? repName(v as string) : "Select rep")}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {(reps.data ?? []).map((r) => (
                      <SelectItem key={r.id} value={r.id} data-testid={`upload-rep-option-${r.id}`}>
                        {r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="customer">Caller / customer name</Label>
              <Input id="customer" data-testid="upload-customer-input" value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="e.g. Tony's Auto Repair" className="h-10 bg-surface" />
            </div>
          </div>

          <div className="mt-5">
            {mode === "audio" ? (
              <div
                data-testid="upload-dropzone"
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDrag(true);
                }}
                onDragLeave={() => setDrag(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDrag(false);
                  if (e.dataTransfer.files.length) setFiles(Array.from(e.dataTransfer.files));
                }}
                className={cn(
                  "flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-14 text-center transition-colors duration-150",
                  drag ? "border-amber-500 bg-amber-500/5" : "border-slate-700 hover:border-slate-500",
                )}
              >
                <input ref={fileRef} type="file" multiple accept={ACCEPT} className="hidden" data-testid="upload-file-input" onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
                <UploadCloud className="size-10 text-amber-400" />
                {file ? (
                  <div className="mt-4 flex items-center gap-2">
                    <span data-testid="upload-file-name" className="font-mono text-sm text-white">
                      {files.length > 1 ? `${files.length} recordings selected` : file.name}
                    </span>
                    <span className="font-mono text-xs text-slate-500">{(files.reduce((n, f) => n + f.size, 0) / 1024 / 1024).toFixed(1)} MB</span>
                    <button
                      data-testid="upload-file-clear"
                      onClick={(e) => {
                        e.stopPropagation();
                        setFiles([]);
                      }}
                      className="text-slate-500 hover:text-red-400"
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                ) : (
                  <>
                    <p className="mt-4 font-heading text-lg font-semibold text-white">Drop a call recording here</p>
                    <p className="mt-1 text-sm text-slate-400">MP3, WAV, M4A, MP4, WEBM · up to 25 MB each · select up to 50 at once</p>
                    <p className="mt-1 text-xs text-slate-500">RingCentral recordings auto-match their call by Interaction ID, or phone number + date in the filename</p>
                  </>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="transcript">Transcript</Label>
                  <button data-testid="upload-sample-button" onClick={() => setTranscript(SAMPLE)} className="text-xs text-sky-400 hover:underline">
                    Insert sample call
                  </button>
                </div>
                <Textarea
                  id="transcript"
                  data-testid="upload-transcript-input"
                  value={transcript}
                  onChange={(e) => setTranscript(e.target.value)}
                  placeholder={"Rep: Thanks for calling…\nCustomer: I need a…"}
                  className="min-h-[300px] bg-surface font-mono text-sm"
                />
                <p className="text-xs text-slate-500">Speaker labels help, but aren't required — the AI will separate speakers.</p>
              </div>
            )}
          </div>

          <div className="mt-6 flex items-center justify-end gap-3">
            {isManager && !repId && (
              <span className="text-xs text-slate-500">{isBulk ? "Optional: pick a rep for recordings that don't match a call" : "Select a rep to continue"}</span>
            )}
            <Button
              data-testid="upload-submit-button"
              size="lg"
              disabled={!canSubmit}
              onClick={() => (isBulk ? bulkUpload.mutate() : submit.mutate())}
            >
              {submit.isPending || bulkUpload.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              {isBulk ? `Upload ${files.length} recordings` : "Analyze call"}
            </Button>
          </div>
          {bulk && (
            <div data-testid="bulk-result" className="mt-6 rounded-xl border border-border bg-surface p-5">
              <div className="flex flex-wrap items-center gap-6 font-mono text-sm">
                <span data-testid="bulk-result-matched" className="text-emerald-300">{bulk.matched} matched</span>
                <span data-testid="bulk-result-created" className="text-sky-300">{bulk.created} new calls</span>
                <span data-testid="bulk-result-failed" className="text-red-300">{bulk.failed} failed</span>
                <span className="text-xs text-slate-500">Transcription + scoring runs in the background (3 at a time)</span>
              </div>
              <ul className="mt-4 divide-y divide-border">
                {bulk.items.map((it, i) => (
                  <li key={`${it.filename}-${i}`} data-testid={`bulk-item-${i}`} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-300">{it.filename}</span>
                    <span
                      className={cn(
                        "rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider",
                        it.match === "error" ? "border-red-500/40 text-red-300" : it.match === "new" ? "border-sky-500/40 text-sky-300" : "border-emerald-500/40 text-emerald-300",
                      )}
                    >
                      {it.match === "interaction_id" ? "matched · ID" : it.match === "phone_date" ? "matched · phone+date" : it.match}
                    </span>
                    {it.call_id ? (
                      <button data-testid={`bulk-item-open-${i}`} onClick={() => nav(`/calls/${it.call_id}`)} className="text-sky-400 hover:underline">
                        {it.customer_name} · {it.rep_name}
                      </button>
                    ) : (
                      <span className="text-xs text-red-300">{it.error}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          </>
          )}
        </Panel>

        <Panel className="xl:col-span-4" testId="upload-howto">
          <Overline>What happens next</Overline>
          <ol className="mt-4 space-y-5">
            {[
              ["Transcribe", "Audio is converted to text with OpenAI Whisper, tuned for yard lingo."],
              ["Categorize", "Claude sorts the call into one of 8 recycler call categories."],
              ["Score", "7 weighted sales metrics → a 0–100 QA score."],
              ["Coach", "Strengths, gaps, insights and a coaching script for the rep."],
            ].map(([t, d], i) => (
              <li key={t} className="flex gap-4">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-amber-500/40 font-mono text-xs text-amber-400">{i + 1}</span>
                <div>
                  <p className="font-semibold text-white">{t}</p>
                  <p className="text-sm text-slate-400">{d}</p>
                </div>
              </li>
            ))}
          </ol>
          <img
            src="https://images.pexels.com/photos/4224967/pexels-photo-4224967.jpeg?auto=compress&cs=tinysrgb&w=800"
            alt="Parts warehouse"
            className="mt-8 h-40 w-full rounded-lg object-cover opacity-80"
          />
        </Panel>
      </div>
    </>
  );
}
