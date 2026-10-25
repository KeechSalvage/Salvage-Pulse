import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Mail, Plus, Trash2, TrendingDown, TrendingUp } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Overline, Panel } from "@/components/common";
import { apiDelete, apiGet, apiPost, apiPut, errorMessage } from "@/lib/api";
import { rankStat } from "@/components/VehicleRankToggle";
import type { VehicleRank, VehicleOptions, WatchEmail, WatchEmailUpdate, WatchItem, WatchItemCreate } from "@/lib/types";

const EMPTY = { make: "", model: "all", from: "", to: "", part: "" };

function EmailSettings() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["watchlist-email"], queryFn: () => apiGet<WatchEmail>("/watchlist/email") });
  const [email, setEmail] = useState("");
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    if (data) {
      setEmail(data.recipient_email);
      setEnabled(data.enabled);
    }
  }, [data]);
  const save = useMutation({
    mutationFn: () => apiPut<WatchEmail>("/watchlist/email", { enabled, recipient_email: email } satisfies WatchEmailUpdate),
    onSuccess: (d) => {
      qc.setQueryData(["watchlist-email"], d);
      toast.success(d.enabled && d.recipient_email ? `Weekly email goes to ${d.recipient_email} every Monday` : "Weekly email is off");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <div className="mt-5 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3" data-testid="watchlist-email-settings">
      <Mail className="size-4 text-amber-300" />
      <label className="flex items-center gap-2 text-sm text-slate-300">
        <Checkbox data-testid="watchlist-email-enabled" checked={enabled} onCheckedChange={(c) => setEnabled(c === true)} />
        Weekly demand email (Mondays 8am ET) to
      </label>
      <Input data-testid="watchlist-email-input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@yourYard.com" className="h-9 w-64" />
      <Button size="sm" variant="outline" data-testid="watchlist-email-save" disabled={save.isPending} onClick={() => save.mutate()}>
        Save
      </Button>
      <span className="font-mono text-[11px] text-slate-500" data-testid="watchlist-email-status">
        {!data?.recipient_email || !data.enabled ? "Not sending — add an email to start" : data.last_sent_at ? `Last sent ${new Date(data.last_sent_at).toLocaleDateString()}` : "First email next Monday"}
      </span>
    </div>
  );
}

/** Dashboard: vehicles the yard stocks, with call demand for each (and a weekly email of it). */
export default function WatchlistPanel({ rank = "calls" }: { rank?: VehicleRank }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["watchlist"], queryFn: () => apiGet<WatchItem[]>("/watchlist") });
  const vopts = useQuery({ queryKey: ["vehicle-options", "catalog", rank], queryFn: () => apiGet<VehicleOptions>(`/calls/vehicle-options?catalog=true&rank=${rank}`) });
  const [f, setF] = useState(EMPTY);
  const modelStats = vopts.data?.makes.find((m) => m.make === f.make)?.model_stats ?? [];
  const add = useMutation({
    mutationFn: () =>
      apiPost<WatchItem>("/watchlist", {
        make: f.make,
        model: f.model === "all" ? "" : f.model,
        year_from: f.from ? Number(f.from) : null,
        year_to: f.to ? Number(f.to) : null,
        part: f.part,
      } satisfies WatchItemCreate),
    onSuccess: (w) => {
      toast.success(`Watching ${w.label}`);
      setF(EMPTY);
      qc.invalidateQueries({ queryKey: ["watchlist"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => apiDelete(`/watchlist/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["watchlist"] }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const yearInput = (k: "from" | "to", ph: string) => (
    <Input data-testid={`watchlist-year-${k}`} inputMode="numeric" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value.replace(/\D/g, "").slice(0, 4) })} placeholder={ph} className="h-9 w-24" />
  );

  return (
    <Panel className="xl:col-span-12" testId="watchlist-panel">
      <div className="flex items-center gap-2">
        <Eye className="size-4 text-amber-300" />
        <Overline>Inventory watchlist</Overline>
      </div>
      <p className="mt-1 text-xs text-slate-500">Vehicles you stock — see how many callers ask for each, and get it by email weekly.</p>

      <div className="mt-4 flex flex-wrap items-center gap-2" data-testid="watchlist-add-form">
        <Select value={f.make} onValueChange={(v) => setF({ ...f, make: v as string, model: "all" })}>
          <SelectTrigger data-testid="watchlist-make-select" className="h-9 w-40">
            <SelectValue>{(v) => (v ? (v as string) : "Make")}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {(vopts.data?.makes ?? []).map((m) => (
            <SelectItem key={m.make} value={m.make}>
              {m.make} {rankStat(m, rank) && <span className="ml-1 font-mono text-[10px] text-slate-500">{rankStat(m, rank)}</span>}
            </SelectItem>
          ))}
          </SelectContent>
        </Select>
        <Select value={f.model} onValueChange={(v) => setF({ ...f, model: v as string })} disabled={!f.make}>
          <SelectTrigger data-testid="watchlist-model-select" className="h-9 w-44">
            <SelectValue>{(v) => (v === "all" ? "Any model" : (v as string))}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any model</SelectItem>
            {modelStats.map((m) => (
            <SelectItem key={m.model} value={m.model}>
              {m.model} {rankStat(m, rank) && <span className="ml-1 font-mono text-[10px] text-slate-500">{rankStat(m, rank)}</span>}
            </SelectItem>
          ))}
          </SelectContent>
        </Select>
        {yearInput("from", "From yr")}
        <span className="text-slate-600">–</span>
        {yearInput("to", "To yr")}
        <Input data-testid="watchlist-part-input" value={f.part} onChange={(e) => setF({ ...f, part: e.target.value })} placeholder="Part (optional)" className="h-9 w-36" />
        <Button size="sm" data-testid="watchlist-add-button" disabled={!f.make || add.isPending} onClick={() => add.mutate()}>
          <Plus className="size-4" /> Watch
        </Button>
      </div>

      {data && data.length > 0 ? (
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {data.map((w) => {
            const up = w.calls_30d >= w.prev_30d;
            return (
              <div key={w.id} data-testid={`watch-item-${w.id}`} className="group relative rounded-xl border border-border bg-surface p-4 transition-[border-color] duration-150 hover:border-amber-500/40">
                <button data-testid={`watch-delete-${w.id}`} title="Stop watching" onClick={() => remove.mutate(w.id)} className="absolute right-3 top-3 text-slate-600 opacity-0 transition-opacity duration-150 hover:text-red-400 group-hover:opacity-100">
                  <Trash2 className="size-4" />
                </button>
                <p className="pr-6 font-medium text-white">{w.label}</p>
                <div className="mt-3 flex items-end gap-5 font-mono">
                  <div>
                    <p className="text-2xl font-bold text-white" data-testid={`watch-7d-${w.id}`}>{w.calls_7d}</p>
                    <p className="text-[10px] uppercase text-slate-500">calls this week</p>
                  </div>
                  <div>
                    <p className="flex items-center gap-1 text-lg text-slate-200">
                      {w.calls_30d}
                      {up ? <TrendingUp className="size-4 text-emerald-300" /> : <TrendingDown className="size-4 text-orange-300" />}
                    </p>
                    <p className="text-[10px] uppercase text-slate-500">30 days (prior {w.prev_30d})</p>
                  </div>
                  <div>
                    <p className="text-lg text-slate-200">{w.orders_30d}<span className="text-slate-500"> / {w.lost_30d}</span></p>
                    <p className="text-[10px] uppercase text-slate-500">ordered / didn't</p>
                  </div>
                </div>
                <p className="mt-2 truncate text-xs text-slate-400">{w.top_parts.length ? `Asked for: ${w.top_parts.join(", ")}` : "No calls in the last 30 days"}</p>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="mt-4 text-sm text-slate-500" data-testid="watchlist-empty">Nothing on the watchlist yet — add a vehicle you stock above.</p>
      )}
      <EmailSettings />
    </Panel>
  );
}
