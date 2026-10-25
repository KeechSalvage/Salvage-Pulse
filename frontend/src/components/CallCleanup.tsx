import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eraser, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { apiDelete, apiGet, apiPost, errorMessage } from "@/lib/api";
import type { CallCleanupRecord, ImportBatch, RangeDelete, RangeDeleteResult, RestoreResult } from "@/lib/types";

/** Manager clean-up: undo an upload batch, or delete every call in a date range (count first, then confirm). */
export default function CallCleanup() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<RangeDelete>({ date_from: "", date_to: "", source: "", dry_run: true });
  const [preview, setPreview] = useState<number | null>(null);
  const batches = useQuery({ queryKey: ["call-cleanup", "batches"], queryFn: () => apiGet<ImportBatch[]>("/call-cleanup/batches"), enabled: open });
  const trash = useQuery({ queryKey: ["call-cleanup", "trash"], queryFn: () => apiGet<CallCleanupRecord[]>("/call-cleanup/trash"), enabled: open });
  const restore = useMutation({
    mutationFn: (id: string) => apiPost<RestoreResult>(`/call-cleanup/trash/${id}/restore`),
    onSuccess: (r) => (toast.success(`Restored ${r.restored} call log${r.restored === 1 ? "" : "s"}`), qc.invalidateQueries()),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const done = (n: number) => {
    toast.success(`Deleted ${n} call log${n === 1 ? "" : "s"} — you can undo this for 7 days under Recently deleted`);
    setPreview(null);
    qc.invalidateQueries();
  };
  const undo = useMutation({ mutationFn: (id: string) => apiDelete<RangeDeleteResult>(`/call-cleanup/batches/${id}`), onSuccess: (r) => done(r.deleted), onError: (e) => toast.error(errorMessage(e)) });
  const run = useMutation({
    mutationFn: (dry: boolean) => apiPost<RangeDeleteResult>("/call-cleanup/range", { ...range, dry_run: dry } satisfies RangeDelete),
    onSuccess: (r, dry) => (dry ? setPreview(r.matched) : done(r.deleted)),
    onError: (e) => toast.error(errorMessage(e, "Pick both dates")),
  });
  const set = (p: Partial<RangeDelete>) => (setRange({ ...range, ...p }), setPreview(null));
  return (
    <>
      <Button variant="outline" data-testid="call-cleanup-button" onClick={() => setOpen(true)}><Eraser className="size-4" /> Clean up</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid="call-cleanup-dialog" className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Clean up call logs</DialogTitle>
            <DialogDescription>Remove a wrong import or a date range. Deleted calls are kept for 7 days — undo any clean-up in one tap under Recently deleted.</DialogDescription>
          </DialogHeader>
          {!!trash.data?.length && (
            <section className="rounded-lg border border-emerald-500/30 bg-emerald-500/[0.04] p-3" data-testid="cleanup-trash">
              <h4 className="mb-1 text-sm font-semibold text-white">Recently deleted</h4>
              <ul className="divide-y divide-border">
                {trash.data.map((t) => (
                  <li key={t.id} data-testid={`cleanup-trash-${t.id}`} className="flex items-center gap-3 py-2 text-sm">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-white">{t.label}</p>
                      <p className="font-mono text-[11px] text-slate-500">
                        {t.count} call{t.count === 1 ? "" : "s"} · {t.by} · {new Date(t.deleted_at).toLocaleString()} · undo until {new Date(t.expires_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                      </p>
                    </div>
                    <Button size="sm" variant="outline" data-testid={`cleanup-restore-${t.id}`} disabled={restore.isPending} onClick={() => restore.mutate(t.id)}>
                      <RotateCcw className="size-3.5" /> Restore
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section>
            <h4 className="mb-2 text-sm font-semibold text-white">Undo an upload</h4>
            {batches.data?.length === 0 && <p className="text-xs text-slate-500">No uploads recorded yet (uploads made before this feature can be removed by date below).</p>}
            <ul className="divide-y divide-border">
              {(batches.data ?? []).map((b) => (
                <li key={b.id} data-testid={`cleanup-batch-${b.id}`} className="flex items-center gap-3 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-white">{b.filename}</p>
                    <p className="font-mono text-[11px] text-slate-500">{new Date(b.created_at).toLocaleString()} · {b.by} · {b.new_calls} new of {b.rows} rows · {b.remaining} still here</p>
                  </div>
                  <Button size="sm" variant="destructive" data-testid={`cleanup-batch-delete-${b.id}`} disabled={!b.remaining || undo.isPending} onClick={() => window.confirm(`Delete the ${b.remaining} calls this upload added?`) && undo.mutate(b.id)}>
                    <Trash2 className="size-3.5" /> Undo
                  </Button>
                </li>
              ))}
            </ul>
          </section>
          <section className="border-t border-border pt-4">
            <h4 className="mb-2 text-sm font-semibold text-white">Delete by date</h4>
            <div className="flex flex-wrap items-center gap-2">
              <Input type="date" data-testid="cleanup-from" value={range.date_from} onChange={(e) => set({ date_from: e.target.value })} className="h-9 w-40" />
              <span className="text-slate-500">to</span>
              <Input type="date" data-testid="cleanup-to" value={range.date_to} onChange={(e) => set({ date_to: e.target.value })} className="h-9 w-40" />
              <select data-testid="cleanup-source" value={range.source} onChange={(e) => set({ source: e.target.value as RangeDelete["source"] })} className="h-9 rounded-md border border-border bg-surface px-2 text-sm text-white">
                <option value="">All call types</option>
                <option value="ringcentral">RingCentral imports</option>
                <option value="audio">Uploaded recordings</option>
                <option value="transcript">Pasted transcripts</option>
              </select>
            </div>
            <div className="mt-3 flex items-center gap-3">
              <Button variant="outline" size="sm" data-testid="cleanup-count" disabled={!range.date_from || !range.date_to || run.isPending} onClick={() => run.mutate(true)}>Count calls</Button>
              {preview !== null && (
                <>
                  <span data-testid="cleanup-preview" className="text-sm text-slate-200">{preview} call{preview === 1 ? "" : "s"} match</span>
                  <Button size="sm" variant="destructive" data-testid="cleanup-delete-range" disabled={!preview || run.isPending} onClick={() => window.confirm(`Delete ${preview} calls from ${range.date_from} to ${range.date_to}?`) && run.mutate(false)}>
                    <Trash2 className="size-3.5" /> Delete {preview}
                  </Button>
                </>
              )}
            </div>
          </section>
        </DialogContent>
      </Dialog>
    </>
  );
}
