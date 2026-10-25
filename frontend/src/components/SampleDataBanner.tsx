import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileUp, Loader2, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { apiDelete, apiUpload, errorMessage } from "@/lib/api";
import { useMe, useOrg } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import type { BulkAudioResult, ImportResult, OrgInfo } from "@/lib/types";

const SHEET = [".csv", ".xlsx", ".xls"];
const AUDIO = [".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".wav", ".webm"];
const ext = (n: string) => n.slice(n.lastIndexOf(".")).toLowerCase();

/** Dashboard: tells a new yard it's looking at sample calls, and takes their real call files (exports or recordings). */
export default function SampleDataBanner({ empty = false }: { empty?: boolean }) {
  const qc = useQueryClient();
  const { data: org } = useOrg();
  const { data: me } = useMe();
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const refreshAll = () => qc.invalidateQueries();

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const sheets = files.filter((f) => SHEET.includes(ext(f.name)));
      const audio = files.filter((f) => AUDIO.includes(ext(f.name)));
      if (!sheets.length && !audio.length) throw new Error("Drop a call-log export (CSV/XLSX) or call recordings (MP3, WAV, M4A…)");
      const notes: string[] = [];
      for (const s of sheets) {
        const fd = new FormData();
        fd.append("file", s);
        fd.append("replace_demo", "false");
        const r = await apiUpload<ImportResult>("/calls/import", fd);
        notes.push(`${r.imported} calls imported from ${s.name}`);
      }
      if (audio.length) {
        const fd = new FormData();
        audio.forEach((a) => fd.append("files", a));
        if (me?.id) fd.append("rep_id", me.id);
        const r = await apiUpload<BulkAudioResult>("/calls/bulk-audio", fd);
        notes.push(`${r.matched + r.created} recordings added${r.failed ? `, ${r.failed} failed` : ""}`);
      }
      return notes.join(" · ");
    },
    onSuccess: (msg) => {
      toast.success(msg || "Files added");
      refreshAll();
    },
    onError: (e) => toast.error(errorMessage(e, e instanceof Error ? e.message : "Upload failed")),
  });
  const remove = useMutation({
    mutationFn: () => apiDelete<OrgInfo>("/org/sample-data"),
    onSuccess: () => {
      toast.success("Sample calls removed");
      refreshAll();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (!org || me?.role !== "manager" || (!org.sample_data && !empty)) return null;
  return (
    <div data-testid="sample-data-banner" className="mb-6 grid gap-4 lg:grid-cols-[1fr_1.2fr]">
      <div className="rounded-xl border border-sky-500/30 bg-sky-500/[0.07] p-5">
        <div className="flex items-start gap-3">
          <Sparkles className="mt-0.5 size-5 shrink-0 text-sky-300" />
          <div>
            <p className="font-heading text-lg font-bold text-white">{org.sample_data ? "You're exploring sample calls" : "Add your first calls"}</p>
            <p className="mt-1 text-sm text-slate-400">
              {org.sample_data
                ? "These come from a made-up demo yard so you can see how scoring, coaching and win-backs work. They disappear automatically as soon as your own calls arrive."
                : "Drop in a call-log export or recordings, or connect your phone system from Phone Connectors."}
            </p>
            {org.sample_data && (
              <Button variant="ghost" size="sm" className="mt-3 -ml-2 text-slate-300" data-testid="sample-remove-button" disabled={remove.isPending} onClick={() => remove.mutate()}>
                <X className="size-4" /> Remove sample calls now
              </Button>
            )}
          </div>
        </div>
      </div>
      <button
        type="button"
        data-testid="real-data-dropzone"
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const files = Array.from(e.dataTransfer.files);
          if (files.length) upload.mutate(files);
        }}
        disabled={upload.isPending}
        className={cn(
          "flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-6 text-center transition-[border-color,background-color] duration-150",
          over ? "border-amber-400 bg-amber-500/10" : "border-slate-600 bg-card hover:border-amber-500/60",
        )}
      >
        {upload.isPending ? <Loader2 className="size-7 animate-spin text-amber-300" /> : <FileUp className="size-7 text-amber-300" />}
        <p className="mt-2 font-medium text-white">{upload.isPending ? "Uploading and scoring…" : "Drop your files here"}</p>
        <p className="mt-1 text-xs text-slate-500">Call-log export from RingCentral or another phone system (CSV / XLSX), or call recordings (MP3, WAV, M4A). Or click to choose.</p>
        <input
          ref={input}
          type="file"
          multiple
          accept={[...SHEET, ...AUDIO].join(",")}
          className="hidden"
          data-testid="real-data-file-input"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length) upload.mutate(files);
            e.target.value = "";
          }}
        />
      </button>
    </div>
  );
}
