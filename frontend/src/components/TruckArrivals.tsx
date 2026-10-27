import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PhoneCall, Trash2, Truck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Overline, Panel, fmtMoney } from "@/components/common";
import { apiDelete, apiGet, apiPatch, apiPost, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import TextBlastDialog from "@/components/TextBlastDialog";
import { SaleForm } from "@/components/SaleFields";
import ArrivalListPrompt from "@/components/ArrivalListPrompt";
import { rankStat } from "@/components/VehicleRankToggle";
import type { Arrival, ArrivalCallerUpdate, ArrivalCostUpdate, ArrivalCreate, ArrivalStatus, VehicleOptions, VehicleRank } from "@/lib/types";

const STATUSES: { v: ArrivalStatus; label: string; cls: string }[] = [
  { v: "called", label: "Called", cls: "border-sky-500/50 text-sky-300 bg-sky-500/10" },
  { v: "sold", label: "Sold", cls: "border-emerald-500/50 text-emerald-300 bg-emerald-500/10" },
  { v: "not_interested", label: "No", cls: "border-slate-500/50 text-slate-300 bg-slate-500/10" },
];
const fmtPhone = (p: string) => {
  const d = p.replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p;
};

function NewArrival({ onCreated, rank }: { onCreated: (a: Arrival) => void; rank: VehicleRank }) {
  // Every car, SUV, van and pickup: ones callers asked about first (ranked), then the rest of the catalog.
  const vopts = useQuery({ queryKey: ["vehicle-options", "catalog", rank], queryFn: () => apiGet<VehicleOptions>(`/calls/vehicle-options?catalog=true&rank=${rank}`) });
  const [f, setF] = useState({ year: "", make: "", model: "", note: "", cost: "", stock: "" });
  const modelStats = (vopts.data?.makes ?? []).find((m) => m.make === f.make)?.model_stats ?? [];
  const create = useMutation({
    mutationFn: () =>
      apiPost<Arrival>("/arrivals", { vehicle_year: Number(f.year), vehicle_make: f.make, vehicle_model: f.model, note: f.note, stock_number: f.stock, year_span: 2, cost: f.cost ? Number(f.cost) : null } satisfies ArrivalCreate),
    onSuccess: (a) => {
      toast.success(`${a.callers.length} callers to call about the ${a.vehicle_year} ${a.vehicle_make} ${a.vehicle_model}`);
      setF({ year: "", make: "", model: "", note: "", cost: "", stock: "" });
      onCreated(a);
    },
    onError: (e) => toast.error(errorMessage(e, "Enter a year, make and model")),
  });
  return (
    <form
      className="mt-4 flex flex-wrap items-center gap-2"
      data-testid="arrival-form"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <Input data-testid="arrival-year-input" inputMode="numeric" value={f.year} onChange={(e) => setF({ ...f, year: e.target.value.replace(/\D/g, "").slice(0, 4) })} placeholder="Year" className="h-10 w-24" />
      <Select value={f.make} onValueChange={(v) => setF({ ...f, make: v as string, model: "" })}>
        <SelectTrigger data-testid="arrival-make-select" className="h-10 w-40">
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
        <SelectTrigger data-testid="arrival-model-select" className="h-10 w-48">
          <SelectValue>{(v) => (v ? (v as string) : "Model")}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {modelStats.map((m) => (
            <SelectItem key={m.model} value={m.model}>
              {m.model} {rankStat(m, rank) && <span className="ml-1 font-mono text-[10px] text-slate-500">{rankStat(m, rank)}</span>}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">$</span>
        <Input
          data-testid="arrival-cost-input"
          inputMode="decimal"
          aria-label="What you paid"
          value={f.cost}
          onChange={(e) => setF({ ...f, cost: e.target.value.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1").slice(0, 10) })}
          placeholder="Paid (cost)"
          className="h-10 w-36 pl-6"
        />
      </div>
      <Input data-testid="arrival-stock-input" aria-label="Stock number" value={f.stock} onChange={(e) => setF({ ...f, stock: e.target.value.slice(0, 30) })} placeholder="Stock #" className="h-10 w-28" />
      <Input data-testid="arrival-note-input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="Note — damage, what's good" className="h-10 min-w-[200px] flex-1" />
      <Button type="submit" data-testid="arrival-submit-button" disabled={f.year.length !== 4 || !f.make || !f.model || create.isPending}>
        <Truck className="size-4" /> Just got one — find callers
      </Button>
    </form>
  );
}

/** Paid amount on the selected arrival — editable (cost is often known after the vehicle is logged). */
function ArrivalCost({ arrival }: { arrival: Arrival }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(arrival.cost != null ? String(arrival.cost) : "");
  const save = useMutation({
    mutationFn: () => apiPatch<Arrival>(`/arrivals/${arrival.id}/cost`, { cost: val ? Number(val) : null } satisfies ArrivalCostUpdate),
    onSuccess: (a) => {
      qc.setQueryData<Arrival[]>(["arrivals"], (old) => old?.map((x) => (x.id === a.id ? a : x)));
      setEditing(false);
      toast.success(a.cost != null ? `Cost saved: ${fmtMoney(a.cost)}` : "Cost cleared");
    },
    onError: (e) => toast.error(errorMessage(e, "Enter an amount up to $1,000,000")),
  });
  if (!editing)
    return (
      <button type="button" data-testid="arrival-cost-display" onClick={() => setEditing(true)} className="mt-1.5 font-mono text-xs text-slate-300 underline-offset-2 transition-colors duration-150 hover:text-white hover:underline">
        {arrival.cost != null ? <>Paid <span className="text-white">{fmtMoney(arrival.cost)}</span> · edit</> : "+ Add what you paid"}
      </button>
    );
  return (
    <form className="mt-1.5 flex items-center gap-2" onSubmit={(e) => (e.preventDefault(), save.mutate())}>
      <span className="text-xs text-slate-500">Paid $</span>
      <Input autoFocus data-testid="arrival-cost-edit-input" inputMode="decimal" value={val} onChange={(e) => setVal(e.target.value.replace(/[^\d.]/g, "").slice(0, 10))} className="h-8 w-28" />
      <Button size="sm" type="submit" data-testid="arrival-cost-save" disabled={save.isPending}>Save</Button>
      <Button size="sm" type="button" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
    </form>
  );
}

function Profit({ v }: { v: number | null }) {
  if (v == null) return <span className="text-slate-500">add cost</span>;
  return <span className={v >= 0 ? "text-emerald-300" : "text-red-300"}>{v >= 0 ? "+" : "−"}{fmtMoney(Math.abs(v))}{v >= 0 ? " paid off" : ""}</span>;
}

function ArrivalPayoff({ arrivals }: { arrivals: Arrival[] }) {
  const rows = [...arrivals].sort((a, b) => (a.results?.first_sale_days ?? 1e9) - (b.results?.first_sale_days ?? 1e9) || (b.results?.sold ?? 0) - (a.results?.sold ?? 0));
  return (
    <div className="mt-5 overflow-x-auto rounded-lg border border-border" data-testid="arrival-payoff-table">
      <table className="w-full text-sm">
        <thead className="bg-surface font-mono text-[11px] uppercase tracking-wider text-slate-500">
          <tr>
            {["Vehicle (fastest payoff first)", "Logged", "Paid", "Brought in", "Profit", "First sale", "Sold", "Orders", "Replied / texted", "Contacted"].map((h) => (
              <th key={h} className="px-3 py-2 text-left font-normal">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((a) => (
            <tr key={a.id} data-testid={`payoff-row-${a.id}`}>
              <td className="px-3 py-2 text-white">{a.vehicle_year} {a.vehicle_make} {a.vehicle_model}</td>
              <td className="px-3 font-mono text-xs text-slate-400">{new Date(a.created_at).toLocaleDateString()}</td>
              <td className="px-3 font-mono text-xs text-slate-200">{a.cost != null ? fmtMoney(a.cost) : "—"}</td>
              <td className="px-3 font-mono text-xs text-slate-200" data-testid={`payoff-revenue-${a.id}`}>{a.results ? `${fmtMoney(a.results.revenue)}${a.results.revenue_estimated ? "*" : ""}` : "—"}</td>
              <td className="px-3 font-mono text-xs" data-testid={`payoff-profit-${a.id}`}><Profit v={a.results?.profit ?? null} /></td>
              <td className="px-3 font-mono text-xs text-emerald-300">{a.results?.first_sale_days == null ? "—" : a.results.first_sale_days < 1 ? "same day" : `${a.results.first_sale_days} days`}</td>
              <td className="px-3 font-mono">{a.results?.sold ?? 0}</td>
              <td className="px-3 font-mono">{a.results?.orders ?? 0}</td>
              <td className="px-3 font-mono">{a.results?.replied ?? 0} / {a.results?.texted ?? 0}</td>
              <td className="px-3 font-mono">{a.results?.contacted ?? 0} / {a.results?.callers ?? 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-border px-3 py-2 text-[11px] text-slate-500" data-testid="payoff-footnote">
        Brought in = won orders from the vehicle's callers after it was logged. * uses your average order value where an order had no amount. Profit = brought in − paid.
      </p>
    </div>
  );
}

/** Vehicle arrivals: log a vehicle that just came in and work the list of everyone who asked about one (±2 model years). */
export default function TruckArrivals({ isManager, rank = "calls" }: { isManager: boolean; rank?: VehicleRank }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["arrivals"], queryFn: () => apiGet<Arrival[]>("/arrivals") });
  const [selId, setSelId] = useState<string | null>(null);
  const [selling, setSelling] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<Arrival | null>(null);
  const [stockQ, setStockQ] = useState("");
  const q = stockQ.trim().toLowerCase();
  const shownArrivals = (data ?? []).filter((a) => !q || a.stock_number.toLowerCase().includes(q) || `${a.vehicle_year} ${a.vehicle_make} ${a.vehicle_model}`.toLowerCase().includes(q));
  const sel = data?.find((a) => a.id === selId) ?? data?.[0];
  const mark = useMutation({
    mutationFn: ({ a, key, ...b }: ArrivalCallerUpdate & { a: string; key: string }) =>
      apiPatch<Arrival>(`/arrivals/${a}/callers/${encodeURIComponent(key)}`, b satisfies ArrivalCallerUpdate),
    onSuccess: (a) => {
      setSelling(null);
      qc.setQueryData<Arrival[]>(["arrivals"], (old) => old?.map((x) => (x.id === a.id ? a : x)));
      qc.invalidateQueries({ queryKey: ["queue"] });
      qc.invalidateQueries({ queryKey: ["arrivals", "leaderboard"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => apiDelete(`/arrivals/${id}`),
    onSuccess: () => {
      setSelId(null);
      qc.invalidateQueries({ queryKey: ["arrivals"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Panel testId="vehicle-arrivals-panel">
      <div className="flex items-center gap-2">
        <Truck className="size-4 text-amber-300" />
        <Overline>Vehicle arrivals</Overline>
      </div>
      <p className="mt-1 text-xs text-slate-500">
        {isManager
          ? "Just got a vehicle in? Log it and get a ready-to-call list of everyone who asked about one (±2 model years). Each rep sees the callers they spoke with."
          : "Vehicles that just came in, and the callers you spoke with who asked about one. Call them and mark how it went."}
      </p>
      {isManager && <NewArrival rank={rank} onCreated={(a) => (qc.invalidateQueries({ queryKey: ["arrivals"] }), setSelId(a.id), setPrompt(a))} />}
      <ArrivalListPrompt arrival={prompt} onClose={() => setPrompt(null)} />

      {isManager && data && data.some((a) => a.cost != null) && (
        <p data-testid="arrivals-total-paid" className="mt-4 font-mono text-xs text-slate-400">
          Paid for logged vehicles: <span className="text-white">{fmtMoney(data.reduce((t, a) => t + (a.cost ?? 0), 0))}</span> across {data.filter((a) => a.cost != null).length} of {data.length}
        </p>
      )}
      {isManager && data && data.length > 1 && <ArrivalPayoff arrivals={data} />}
      {!data?.length ? (
        <p className="mt-5 text-sm text-slate-500" data-testid="arrivals-empty">{isManager ? "No arrivals logged yet." : "No callers for you on recent arrivals."}</p>
      ) : (
        <div className="mt-5 grid gap-5 lg:grid-cols-[260px_1fr]">
          <div className="space-y-2">
          <Input data-testid="arrival-stock-search" value={stockQ} onChange={(e) => setStockQ(e.target.value)} placeholder="Search stock # or vehicle" className="h-9" />
          {q && !shownArrivals.length && <p data-testid="arrival-search-empty" className="text-xs text-slate-500">No arrival with stock # “{stockQ}”.</p>}
          <ul className="space-y-2" data-testid="arrivals-list">
            {shownArrivals.map((a) => {
              const done = a.callers.filter((c) => c.status !== "to_call").length;
              return (
                <li key={a.id}>
                  <button
                    data-testid={`arrival-${a.id}`}
                    onClick={() => setSelId(a.id)}
                    className={cn(
                      "w-full rounded-lg border px-3 py-2.5 text-left transition-colors duration-150",
                      sel?.id === a.id ? "border-amber-500/60 bg-amber-500/10" : "border-border bg-surface hover:border-slate-500",
                    )}
                  >
                    <p className="font-medium text-white">{a.vehicle_year} {a.vehicle_make} {a.vehicle_model}{a.stock_number && <span className="ml-2 font-mono text-[11px] text-amber-200/80">#{a.stock_number}</span>}</p>
                    <p className="font-mono text-[11px] text-slate-500">
                      {new Date(a.created_at).toLocaleDateString()} · {done}/{a.callers.length} called{a.cost != null ? ` · ${fmtMoney(a.cost)}` : ""}
                    </p>
                    {a.results && (a.results.sold + a.results.orders + a.results.replied > 0) && (
                      <p className="font-mono text-[11px] text-emerald-300/90">
                        {a.results.sold} sold · {a.results.orders} orders · {a.results.replied} replied
                      </p>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          </div>
          {sel && (
            <div data-testid="arrival-detail">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="font-heading text-xl font-bold text-white">{sel.vehicle_year} {sel.vehicle_make} {sel.vehicle_model}</h3>
                  <p className="text-xs text-slate-500">
                    {sel.stock_number && <span data-testid="arrival-stock-number" className="font-mono text-amber-200">Stock #{sel.stock_number} · </span>}
                    {sel.note && <span className="text-slate-300">{sel.note} · </span>}
                    {sel.callback_list_id && <span data-testid="arrival-has-list" className="text-sky-300">on a callback list · </span>}
                    Logged by {sel.created_by} · callers who asked about {sel.vehicle_year - sel.year_span}–{sel.vehicle_year + sel.year_span}
                  </p>
                  {isManager && <ArrivalCost key={sel.id} arrival={sel} />}
                  {isManager && sel.results && (
                    <p data-testid="arrival-profit" className="mt-1 font-mono text-xs text-slate-400">
                      Brought in <span className="text-white">{fmtMoney(sel.results.revenue)}</span>{sel.results.revenue_estimated && <span title="Some orders had no amount — the yard's average order value was used">*</span>} · <Profit v={sel.results.profit} />
                    </p>
                  )}
                  {sel.results && (
                    <div className="mt-2 flex flex-wrap gap-4 font-mono text-xs" data-testid="arrival-results">
                      {[
                        ["Callers", sel.results.callers],
                        ["Contacted", sel.results.contacted],
                        ["Texted", sel.results.texted],
                        ["Replied", sel.results.replied],
                        ["Sold", sel.results.sold],
                        ["Orders", sel.results.orders],
                        ["First sale", sel.results.first_sale_days === null ? "—" : sel.results.first_sale_days < 1 ? "same day" : `${sel.results.first_sale_days}d`],
                      ].map(([l, v]) => (
                        <span key={l} className="text-slate-500">
                          {l} <b className="text-white">{v}</b>
                        </span>
                      ))}
                    </div>
                  )}
                  {sel.blasts.length > 0 && (
                    <p className="mt-1 font-mono text-[11px] text-amber-300/80" data-testid="arrival-blast-log">
                      {sel.blasts.map((b) => (b.mode === "practice" ? `Practice text: ${b.count} logged` : `Texts: ${b.count} sent${b.failed ? `, ${b.failed} failed` : ""}`) + ` ${new Date(b.at).toLocaleString()} by ${b.by}`).join(" · ")}
                    </p>
                  )}
                </div>
                {isManager && <TextBlastDialog arrival={sel} />}
                {isManager && (
                  <Button variant="ghost" size="sm" data-testid="arrival-delete-button" onClick={() => window.confirm("Delete this arrival and its call list?") && remove.mutate(sel.id)}>
                    <Trash2 className="size-4" /> Delete
                  </Button>
                )}
              </div>
              <ul className="mt-3 divide-y divide-border">
                {sel.callers.map((c) => (
                  <li key={c.key} data-testid={`arrival-caller-${c.key}`} className={cn("flex flex-wrap items-center gap-3 py-2.5", c.status !== "to_call" && "opacity-60")}>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-white">
                        {c.customer_name}
                        {c.exact_year && <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-300">same year</span>}
                        {c.texted_at && (
                          <span
                            title={c.sms_error ? `${c.text}\n\nNot delivered: ${c.sms_error}` : c.text}
                            data-testid={`arrival-texted-${c.key}`}
                            className={cn("ml-2 rounded px-1.5 py-0.5 font-mono text-[10px]", c.sms_status === "failed" || c.sms_status === "undelivered" ? "bg-red-500/15 text-red-300" : "bg-sky-500/15 text-sky-300")}
                          >
                            {c.sms_sid || c.sms_status ? `text ${c.sms_status || "sent"}` : "texted (practice)"}
                          </span>
                        )}
                        {c.replied_at && (
                          <span data-testid={`arrival-replied-${c.key}`} title={c.sms_reply ? `Texted back: "${c.sms_reply}"` : `Called back ${new Date(c.replied_at).toLocaleString()}`} className="ml-2 rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300">
                            replied {new Date(c.replied_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                          </span>
                        )}
                        {c.ordered_at && (
                          <span data-testid={`arrival-ordered-${c.key}`} className="ml-2 rounded bg-amber-500/20 px-1.5 py-0.5 font-mono text-[10px] text-amber-200">
                            ordered
                          </span>
                        )}
                      </p>
                      <p className="truncate text-xs text-slate-500">
                        Asked about {c.vehicle || "this vehicle"}
                        {c.parts.length ? ` · ${c.parts.join(", ")}` : ""} · {new Date(c.last_asked).toLocaleDateString()}
                        {c.times_asked > 1 ? ` · ${c.times_asked}×` : ""} · {c.rep_name}
                        {isManager && (
                          <>
                            {" · "}
                            <Link to={`/calls/${c.last_call_id}`} className="text-slate-400 underline-offset-2 hover:underline">last call</Link>
                          </>
                        )}
                      </p>
                    </div>
                    {c.customer_phone && (
                      <a href={`tel:${c.customer_phone}`} data-testid={`arrival-call-${c.key}`} className="flex items-center gap-1 rounded-md border border-sky-500/40 px-2 py-1 font-mono text-xs text-sky-300 transition-colors duration-150 hover:bg-sky-500/10">
                        <PhoneCall className="size-3" /> {fmtPhone(c.customer_phone)}
                      </a>
                    )}
                    <div className="flex gap-1">
                      {STATUSES.map((s) => (
                        <button
                          key={s.v}
                          data-testid={`arrival-status-${c.key}-${s.v}`}
                          disabled={mark.isPending}
                          onClick={() => (s.v === "sold" ? setSelling(selling === c.key ? null : c.key) : mark.mutate({ a: sel.id, key: c.key, status: c.status === s.v ? "to_call" : s.v }))}
                          className={cn(
                            "rounded border px-2 py-0.5 font-mono text-[11px] transition-colors duration-150",
                            c.status === s.v ? s.cls : "border-border text-slate-500 hover:text-white",
                          )}
                        >
                          {s.label}
                          {s.v === "sold" && c.status === "sold" && c.sold_price ? ` ${fmtMoney(c.sold_price)}` : ""}
                        </button>
                      ))}
                    </div>
                    {c.status === "sold" && c.parts_sold.length > 0 && selling !== c.key && (
                      <p data-testid={`arrival-parts-sold-${c.key}`} className="w-full text-right font-mono text-[11px] text-emerald-300/80">sold: {c.parts_sold.join(", ")}</p>
                    )}
                    {selling === c.key && (
                      <div className="flex w-full flex-wrap items-center gap-2 border-t border-border pt-2" data-testid={`arrival-sale-${c.key}`}>
                        <SaleForm price={c.sold_price} parts={c.parts_sold} saving={mark.isPending} saveLabel={c.status === "sold" ? "Update sale" : "Mark sold"} testPrefix={`arrival-sale-${c.key}`}
                          onCancel={() => setSelling(null)} onSave={(p, parts) => mark.mutate({ a: sel.id, key: c.key, status: "sold", sold_price: p, parts_sold: parts })} />
                        {c.status === "sold" && (
                          <Button size="sm" variant="ghost" data-testid={`arrival-sale-unmark-${c.key}`} disabled={mark.isPending} onClick={() => mark.mutate({ a: sel.id, key: c.key, status: "to_call" })}>Not sold</Button>
                        )}
                      </div>
                    )}
                  </li>
                ))}
                {sel.callers.length === 0 && <li className="py-3 text-sm text-slate-500">Nobody has asked about this vehicle yet.</li>}
              </ul>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
