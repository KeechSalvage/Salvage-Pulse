import { useMemo, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Ban, CarFront, Check, Clock, Loader2, SkipForward, Sparkles, Trophy, Truck } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader, Panel } from "@/components/common";
import { apiGet, apiPatch, apiPost, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useMe } from "@/lib/hooks";
import type { CallSummary, TagItem, TaggingLeaderboard, TaggingQueue, TagPartPicks, VehicleOptions, VehicleUpdate } from "@/lib/types";

const chip =
  "rounded-full border px-3 py-1.5 text-sm transition-[background-color,border-color,color,transform] duration-150 active:scale-95";
const chipIdle = "border-border text-slate-300 hover:border-amber-500/60 hover:text-white";
const chipOn = "border-amber-500 bg-amber-500 text-white";

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const mins = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const vehicleLabel = (v: { vehicle_year: number | null; vehicle_make: string; vehicle_model: string }) =>
  [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(" ");

/** Quick vehicle tagging: one untagged call at a time — tap a make, tap a model, done. */
export default function TagVehicles() {
  const { data: me } = useMe();
  const qc = useQueryClient();

  if (me?.role === "inventory_manager") {
    return <Navigate to="/vehicles" replace />;
  }
  const queue = useQuery({ queryKey: ["tagging"], queryFn: () => apiGet<TaggingQueue>("/tagging/queue") });
  const vopts = useQuery({ queryKey: ["vehicle-options", "catalog", "calls"], queryFn: () => apiGet<VehicleOptions>("/calls/vehicle-options?catalog=true&rank=calls") });
  const [later, setLater] = useState<string[]>([]);
  const [saved, setSaved] = useState(0);
  const items = (queue.data?.items ?? []).filter((i) => !later.includes(i.id));
  const current = items[0];

  const done = () => {
    setSaved((n) => n + 1);
    qc.invalidateQueries({ queryKey: ["tagging"] });
    qc.invalidateQueries({ queryKey: ["vehicles"] });
    qc.invalidateQueries({ queryKey: ["vehicle-options"] });
  };

  return (
    <>
      <PageHeader overline="Vehicles" title="Quick vehicle tagging">
        <div className="flex items-center gap-4 font-mono text-sm">
          <span data-testid="tagging-remaining" className="text-slate-300">
            <span className="text-2xl text-white">{queue.data ? Math.max(queue.data.total - later.length, 0) : "—"}</span> calls to tag
          </span>
          {saved > 0 && (
            <span data-testid="tagging-saved-count" className="rounded-full bg-emerald-500/15 px-3 py-1 text-emerald-300">
              {saved} tagged this visit
            </span>
          )}
        </div>
      </PageHeader>
      <p className="-mt-5 mb-6 max-w-2xl text-sm text-slate-400">
        Connected calls with no vehicle yet. Tap the make, the model, then the part (most asked on that model first) — it saves and the next call appears. Every tag feeds
        vehicle demand, stock alerts and vehicle arrival lists.
      </p>
      <div className="grid items-start gap-6 xl:grid-cols-[1fr_320px]">
      <div id="tagging-active-card" className="scroll-mt-6">
      {queue.isLoading ? (
        <Panel><Loader2 className="size-5 animate-spin text-slate-400" /></Panel>
      ) : !current ? (
        <Panel testId="tagging-empty" className="flex items-center gap-3">
          <Check className="size-5 text-emerald-400" />
          <p className="text-slate-200">All caught up — every connected call has a vehicle or was marked "no vehicle".</p>
        </Panel>
      ) : (
        <TagCard
          key={current.id}
          item={current}
          options={vopts.data}
          onSaved={done}
          onLater={() => setLater((l) => [...l, current.id])}
          onSkipped={() => qc.invalidateQueries({ queryKey: ["tagging"] })}
        />
      )}
      {items.length > 1 && (
        <p data-testid="tagging-up-next" className="mt-4 text-xs text-slate-500">
          Up next: {items.slice(1, 4).map((i) => i.customer_name || i.customer_phone || "Unknown caller").join(" · ")}
        </p>
      )}
      </div>
      <div id="tagging-leaderboard-section" className="scroll-mt-6">
        <TagLeaderboardPanel />
      </div>
      </div>
    </>
  );
}

/** This week's tagging leaderboard (Monday–today, yard time): vehicles saved + "no vehicle" marks. */
function TagLeaderboardPanel() {
  const { data: me } = useMe();
  const board = useQuery({ queryKey: ["tagging", "leaderboard"], queryFn: () => apiGet<TaggingLeaderboard>("/tagging/leaderboard") });
  const leaders = board.data?.leaders ?? [];
  return (
    <Panel testId="tagging-leaderboard" className="xl:sticky xl:top-6">
      <p className="flex items-center gap-2 font-heading text-base font-semibold text-white">
        <Trophy className="size-4 text-amber-300" /> Top taggers this week
      </p>
      <p className="mt-1 text-xs text-slate-500" data-testid="tagging-leaderboard-total">
        {board.data ? `${board.data.total_tagged} vehicles tagged since Monday` : "Loading…"}
      </p>
      {board.data && leaders.length === 0 && <p data-testid="tagging-leaderboard-empty" className="mt-4 text-sm text-slate-400">No tags yet this week — be first on the board.</p>}
      <ol className="mt-4 space-y-2">
        {leaders.slice(0, 8).map((l, i) => {
          const you = l.user_id === me?.id;
          return (
            <li
              key={l.user_id}
              data-testid={`tagging-leader-${l.user_id}`}
              className={cn("flex items-center gap-3 rounded-lg px-3 py-2 transition-colors duration-150", you ? "bg-amber-500/15 ring-1 ring-amber-500/40" : "bg-surface-2")}
            >
              <span className={cn("w-5 font-mono text-sm", i === 0 ? "text-amber-300" : "text-slate-500")}>{i + 1}</span>
              <span className="flex-1 truncate text-sm text-slate-100">{l.name}{you && <span className="ml-1 text-xs text-amber-300">(you)</span>}</span>
              <span className="font-mono text-sm text-white" title="vehicles tagged">{l.tagged}</span>
              {l.skipped > 0 && <span className="font-mono text-xs text-slate-500" title='marked "no vehicle"'>+{l.skipped}</span>}
            </li>
          );
        })}
      </ol>
      {leaders.some((l) => l.skipped > 0) && <p className="mt-3 text-[11px] text-slate-500">+N = calls marked "no vehicle"</p>}
    </Panel>
  );
}

/** Part buttons: yard's most-asked parts this month; with a make/model, that vehicle's most-asked parts come first. */
function usePartPicks(make: string, model: string | null) {
  const q = new URLSearchParams({ make, model: model ?? "" }).toString();
  return useQuery({
    queryKey: ["tagging", "parts", make, model ?? ""],
    queryFn: () => apiGet<TagPartPicks>(`/tagging/parts?${q}`),
    staleTime: 10 * 60_000,
    placeholderData: (prev) => prev,
  });
}

function TagCard({ item, options, onSaved, onLater, onSkipped }: {
  item: TagItem;
  options?: VehicleOptions;
  onSaved: () => void;
  onLater: () => void;
  onSkipped: () => void;
}) {
  const [make, setMakeRaw] = useState("");
  const [model, setModel] = useState<string | null>(null); // chosen model waiting for a part ("" = make only)
  const setMake = (m: string) => {
    setMakeRaw(m);
    setModel(null);
  };
  const [year, setYear] = useState("");
  const [part, setPart] = useState(item.part_requested);
  const [otherModel, setOtherModel] = useState("");
  const makes = options?.makes ?? [];
  const quickMakes = makes.slice(0, 10);
  const restMakes = useMemo(() => makes.slice(10).map((m) => m.make).sort(), [makes]);
  const models = makes.find((m) => m.make === make)?.models.slice(0, 14) ?? [];
  const parts = usePartPicks(make, model).data;

  const save = useMutation({
    mutationFn: (v: { year: number | null; make: string; model: string; part?: string }) =>
      apiPatch<CallSummary>(`/calls/${item.id}/vehicle`, {
        vehicle_year: v.year, vehicle_make: v.make, vehicle_model: v.model, part_requested: (v.part ?? part).trim(),
      } satisfies VehicleUpdate),
    onSuccess: (c) => {
      toast.success(`Tagged ${vehicleLabel(c)}`);
      onSaved();
    },
    onError: (e) => toast.error(errorMessage(e, "Enter a year between 1960 and 2035")),
  });
  const skip = useMutation({
    mutationFn: () => apiPost<TaggingQueue>(`/tagging/${item.id}/skip`, {}),
    onSuccess: () => {
      toast("Marked as no vehicle");
      onSkipped();
    },
    onError: (e) => toast.error(errorMessage(e, "Couldn't update the call")),
  });
  const delivery = useMutation({
    mutationFn: () => apiPost<TaggingQueue>(`/tagging/${item.id}/delivery`, {}),
    onSuccess: () => {
      toast.success("Tagged as a delivery call — kept out of sales and vehicle lookups");
      onSkipped();
    },
    onError: (e) => toast.error(errorMessage(e, "Couldn't update the call")),
  });
  const yr = year ? Number(year) : null;
  // Part already chosen (or read from topics) → the model tap saves; otherwise ask for the part with this model's parts first.
  const pick = (m: string) => (part.trim() ? save.mutate({ year: yr, make, model: m }) : setModel(m));
  const savePart = (p: string) => save.mutate({ year: yr, make, model: model ?? "", part: p });
  const vehicleName = [make, model].filter(Boolean).join(" ");
  const s = item.suggestion;

  return (
    <Panel testId="tagging-card" className="relative overflow-clip">
      <div className="pointer-events-none absolute -right-20 -top-20 size-56 rounded-full bg-amber-500/10 blur-3xl" />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p data-testid="tagging-caller" className="font-heading text-xl font-semibold text-white">{item.customer_name || item.customer_phone || "Unknown caller"}</p>
          <p data-testid="tagging-call-meta" className="mt-1 flex items-center gap-2 font-mono text-xs text-slate-400">
            <Clock className="size-3.5" /> {when(item.created_at)} · {item.direction || "call"} · {mins(item.duration_sec)} · {item.rep_name}
          </p>
        </div>
        <Link to={`/calls/${item.id}`} data-testid="tagging-open-call" className="flex items-center gap-1 text-sm text-amber-300 hover:text-amber-200">
          Open call <ArrowRight className="size-4" />
        </Link>
      </div>
      {item.topics.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5" data-testid="tagging-topics">
          {item.topics.map((t) => (
            <span key={t} className="rounded-md bg-surface-2 px-2 py-0.5 text-xs text-slate-300">{t}</span>
          ))}
        </div>
      )}
      {item.summary && <p className="mt-3 text-sm text-slate-400">{item.summary}</p>}

      {s && (
        <button
          type="button"
          data-testid="tagging-use-suggestion"
          disabled={save.isPending}
          onClick={() => save.mutate({ year: s.vehicle_year, make: s.vehicle_make, model: s.vehicle_model })}
          className="mt-5 flex w-full items-center gap-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-left transition-colors duration-150 hover:bg-emerald-500/20"
        >
          <Sparkles className="size-4 shrink-0 text-emerald-300" />
          <span className="text-sm text-emerald-100">
            This caller asked about a <b>{vehicleLabel(s)}</b> on {new Date(s.from_call_at).toLocaleDateString()} — tap to use it
          </span>
        </button>
      )}

      <div className="mt-5 grid gap-5 md:grid-cols-[1fr_auto]">
        <div>
          <p className="mb-2 text-xs uppercase tracking-wider text-slate-500">1 · Make</p>
          <div className="flex flex-wrap gap-2">
            {quickMakes.map((m) => (
              <button key={m.make} type="button" data-testid={`tagging-make-${m.make}`} onClick={() => setMake(m.make)} className={cn(chip, make === m.make ? chipOn : chipIdle)}>
                {m.make}
              </button>
            ))}
            {restMakes.length > 0 && (
              <Select value={restMakes.includes(make) ? make : ""} onValueChange={setMake}>
                <SelectTrigger data-testid="tagging-more-makes" className="h-9 w-36 rounded-full"><SelectValue placeholder="More makes" /></SelectTrigger>
                <SelectContent>
                  {restMakes.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
          </div>
        </div>
        <div className="flex gap-3 md:flex-col">
          <label className="text-xs text-slate-500">
            Year (optional)
            <Input data-testid="tagging-year-input" value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="2016" className="mt-1 h-9 w-24" />
          </label>
          <label className="text-xs text-slate-500">
            Part
            <Input data-testid="tagging-part-input" value={part} onChange={(e) => setPart(e.target.value)} placeholder="Door" className="mt-1 h-9 w-36" />
          </label>
        </div>
      </div>

      {model === null && (
      <div className="mt-5" data-testid="tagging-parts">
        <p className="mb-2 text-xs uppercase tracking-wider text-slate-500" data-testid="tagging-parts-basis">
          Part (optional) · tap before the model
          <span className="ml-2 normal-case tracking-normal text-slate-600">
            {parts?.model ? `· most asked on ${parts.model} first` : parts?.basis === "month" ? "· most asked this month" : parts?.basis === "recent" ? "· most asked lately" : ""}
          </span>
        </p>
        <div className="flex flex-wrap gap-2">
          {(parts?.parts ?? []).map(({ part: p, calls }) => {
            const on = part.trim().toLowerCase() === p.toLowerCase();
            return (
              <button key={p} type="button" data-testid={`tagging-quick-part-${p}`} aria-pressed={on} title={calls ? `${calls} calls` : undefined} onClick={() => setPart(on ? "" : p)} className={cn(chip, "px-2.5 py-1 text-xs", on ? chipOn : chipIdle)}>
                {p}
              </button>
            );
          })}
        </div>
      </div>
      )}

      {make && model === null && (
        <div className="mt-5 animate-in fade-in slide-in-from-top-1 duration-200" data-testid="tagging-models">
          <p className="mb-2 text-xs uppercase tracking-wider text-slate-500">2 · {make} model — {part.trim() ? "tap to save" : "then pick the part"}</p>
          <div className="flex flex-wrap gap-2">
            {models.map((m) => (
              <button key={m} type="button" data-testid={`tagging-model-${m}`} disabled={save.isPending} onClick={() => pick(m)} className={cn(chip, chipIdle)}>
                {m}
              </button>
            ))}
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                if (otherModel.trim()) pick(otherModel.trim());
              }}
            >
              <Input data-testid="tagging-other-model-input" value={otherModel} onChange={(e) => setOtherModel(e.target.value)} placeholder="Other model" className="h-9 w-32 rounded-full" />
            </form>
            <button type="button" data-testid="tagging-make-only" disabled={save.isPending} onClick={() => pick("")} className={cn(chip, "border-dashed", chipIdle)}>
              {make} only
            </button>
            {save.isPending && <Loader2 className="size-5 animate-spin self-center text-slate-400" />}
          </div>
        </div>
      )}

      {model !== null && (
        <div className="mt-5 animate-in fade-in slide-in-from-top-1 duration-200" data-testid="tagging-model-parts">
          <div className="mb-2 flex flex-wrap items-center gap-3">
            <p className="text-xs uppercase tracking-wider text-slate-500">3 · Part on the <span className="text-amber-300">{vehicleName}</span> — tap to save</p>
            <button type="button" data-testid="tagging-change-model" onClick={() => setModel(null)} className="text-xs text-slate-400 underline-offset-2 hover:text-white hover:underline">
              change model
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {(parts?.parts ?? []).map(({ part: p, model_calls }) => (
              <button
                key={p}
                type="button"
                data-testid={`tagging-model-part-${p}`}
                disabled={save.isPending}
                onClick={() => savePart(p)}
                className={cn(chip, "flex items-center gap-1.5", model_calls ? "border-amber-500/50 text-white hover:bg-amber-500/15" : chipIdle)}
              >
                {p}
                {model_calls > 0 && <span className="font-mono text-[10px] text-amber-300">{model_calls}</span>}
              </button>
            ))}
            <button type="button" data-testid="tagging-save-no-part" disabled={save.isPending} onClick={() => savePart("")} className={cn(chip, "border-dashed", chipIdle)}>
              Save without part
            </button>
            {save.isPending && <Loader2 className="size-5 animate-spin self-center text-slate-400" />}
          </div>
          {parts?.model && <p className="mt-2 text-[11px] text-slate-500">Highlighted = asked for on {parts.model} calls (number of calls)</p>}
        </div>
      )}

      <div className="mt-6 flex flex-wrap gap-3 border-t border-border pt-4">
        <button type="button" data-testid="tagging-later" onClick={onLater} className="flex items-center gap-1.5 text-sm text-slate-400 transition-colors duration-150 hover:text-white">
          <SkipForward className="size-4" /> Later
        </button>
        <button type="button" data-testid="tagging-no-vehicle" disabled={skip.isPending} onClick={() => skip.mutate()} className="flex items-center gap-1.5 text-sm text-slate-400 transition-colors duration-150 hover:text-red-300">
          <Ban className="size-4" /> No vehicle on this call
        </button>
        <button type="button" data-testid="tagging-delivery-call" disabled={delivery.isPending} onClick={() => delivery.mutate()} title="Parts sold on a different call — doesn't count as a sale or a vehicle lookup"
          className={cn("flex items-center gap-1.5 text-sm transition-colors duration-150", item.delivery_hint ? "rounded-full border border-sky-400/60 bg-sky-500/15 px-3 py-1 text-sky-200 shadow-[0_0_0_3px_rgba(56,189,248,0.12)] hover:bg-sky-500/25" : "text-slate-400 hover:text-sky-300")}>
          <Truck className="size-4" /> Delivery call
          {item.delivery_hint && <span data-testid="tagging-delivery-hint" className="text-[11px] text-sky-300/90">· suggested, {item.delivery_hint}</span>}
        </button>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-slate-500"><CarFront className="size-4" /> Saved vehicles show up on the Vehicles page right away</span>
      </div>
    </Panel>
  );
}
