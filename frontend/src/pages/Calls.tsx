import { useState } from "react";
import AddToCallbacks from "@/components/AddToCallbacks";
import { PriceMissingBadge, priceMissing } from "@/components/PriceMissing";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { motion } from "motion/react";
import { fadeUpSm } from "@/lib/motion";
import { Car, Trash2, FileAudio, FileText, Loader2, PhoneIncoming, PhoneOutgoing, Radio, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { CATEGORY_COLORS, CategoryBadge, EmptyState, PageHeader, ScoreBadge, fmtDate, fmtDuration } from "@/components/common";
import { apiGet, apiPost, errorMessage } from "@/lib/api";
import { useAllReps, useMe, useMeta } from "@/lib/hooks";
import { SiteFilter } from "@/components/Sites";
import CallCleanup from "@/components/CallCleanup";
import { cn } from "@/lib/utils";
import type { BulkDelete, BulkDeleteResult, CallSummary, VehicleOptions } from "@/lib/types";

const DIR_LABELS: Record<string, string> = { all: "In & outbound", inbound: "Inbound", outbound: "Outbound" };
const PAGE = 100;

const SCORE_LABELS: Record<string, string> = { all: "Any score", "85": "85+ Exceptional", "70": "70+ Proficient", "50": "50+" };

export default function Calls() {
  const nav = useNavigate();
  const { data: me } = useMe();
  const isManager = me?.role === "manager";
  const meta = useMeta();
  const reps = useAllReps(isManager);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("all");
  const [repId, setRepId] = useState("all");
  const [siteId, setSiteId] = useState("");
  const [minScore, setMinScore] = useState("all");
  const [direction, setDirection] = useState("all");
  const [limit, setLimit] = useState(PAGE);
  const qc = useQueryClient();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const togglePick = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const bulkDelete = useMutation({
    mutationFn: (ids: string[]) => apiPost<BulkDeleteResult>("/calls/bulk-delete", { ids } satisfies BulkDelete),
    onSuccess: (r) => {
      toast.success(`Deleted ${r.deleted} call log${r.deleted === 1 ? "" : "s"}`);
      setPicked(new Set());
      qc.invalidateQueries();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const [urlParams] = useSearchParams();
  const [make, setMake] = useState(urlParams.get("vehicle_make") ?? "all");
  const [model, setModel] = useState(urlParams.get("vehicle_model") ?? "all");
  const [yearFrom, setYearFrom] = useState(urlParams.get("year_from") ?? "");
  const [yearTo, setYearTo] = useState(urlParams.get("year_to") ?? "");
  const vopts = useQuery({ queryKey: ["vehicle-options"], queryFn: () => apiGet<VehicleOptions>("/calls/vehicle-options") });
  const models = vopts.data?.makes.find((m) => m.make === make)?.models ?? [];
  const vehicleOn = make !== "all" || !!yearFrom || !!yearTo;

  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (category !== "all") params.set("category", category);
  if (repId !== "all") params.set("rep_id", repId);
  if (siteId) params.set("site_id", siteId);
  if (minScore !== "all") params.set("min_score", minScore);
  if (direction !== "all") params.set("direction", direction);
  if (make !== "all") params.set("vehicle_make", make);
  if (make !== "all" && model !== "all") params.set("vehicle_model", model);
  if (yearFrom.length === 4) params.set("year_from", yearFrom);
  if (yearTo.length === 4) params.set("year_to", yearTo);
  const qs = params.toString();
  const [prevQs, setPrevQs] = useState(qs);
  if (qs !== prevQs) {
    setPrevQs(qs);
    setLimit(PAGE);
  }

  const { data: calls, isLoading, isError } = useQuery({
    queryKey: ["calls", qs],
    queryFn: () => apiGet<CallSummary[]>(`/calls${qs ? `?${qs}` : ""}`),
    refetchInterval: (query) => (query.state.data?.some((c) => c.status === "processing") ? 4000 : false),
  });
  const repLabel = (id: string) => (id === "all" ? "All reps" : (reps.data?.find((r) => r.id === id)?.name ?? "Rep"));

  return (
    <>
      <PageHeader overline="Call library" title={isManager ? "All incoming calls" : "My calls"}>{isManager && <CallCleanup />}</PageHeader>

      <div className="mb-4 flex flex-wrap gap-2" data-testid="category-pills">
        {["all", ...(meta.data?.categories ?? [])].map((c) => (
          <button
            key={c}
            data-testid={`category-pill-${c.replace(/[^a-z]+/gi, "-").toLowerCase()}`}
            onClick={() => setCategory(c)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors duration-150",
              category === c ? "border-amber-500 bg-amber-500/15 text-amber-300" : "border-slate-700 text-slate-400 hover:border-slate-500 hover:text-white",
            )}
            style={category === c && c !== "all" ? { borderColor: CATEGORY_COLORS[c], color: CATEGORY_COLORS[c] } : undefined}
          >
            {c === "all" ? "All categories" : c}
          </button>
        ))}
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-3">
        <form
          className="relative min-w-[240px] flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            setQ(search.trim());
          }}
        >
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" />
          <Input
            data-testid="calls-search-input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onBlur={() => setQ(search.trim())}
            placeholder="Search transcripts — e.g. Hollander, core, LKQ, F-150… (Enter)"
            className="h-10 bg-surface pl-9"
          />
        </form>
        {isManager && <SiteFilter value={siteId} onChange={setSiteId} testId="calls-site-filter" />}
        {isManager && (
          <Select value={repId} onValueChange={setRepId}>
            <SelectTrigger data-testid="calls-rep-filter" className="h-10 w-44 bg-surface">
              <SelectValue>{(v) => repLabel(v as string)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All reps</SelectItem>
              {(reps.data ?? []).map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Select value={minScore} onValueChange={setMinScore}>
          <SelectTrigger data-testid="calls-score-filter" className="h-10 w-44 bg-surface">
            <SelectValue>{(v) => SCORE_LABELS[v as string]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {Object.entries(SCORE_LABELS).map(([v, l]) => (
              <SelectItem key={v} value={v}>
                {l}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={direction} onValueChange={setDirection}>
          <SelectTrigger data-testid="calls-direction-filter" className="h-10 w-40 bg-surface">
            <SelectValue>{(v) => DIR_LABELS[v as string]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {Object.entries(DIR_LABELS).map(([v, l]) => (
              <SelectItem key={v} value={v}>
                {l}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span data-testid="calls-count" className="px-2 font-mono text-xs text-slate-500">
          {calls?.length ?? 0} calls
        </span>
      </div>

      <div className="-mt-3 mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card/60 p-3" data-testid="calls-vehicle-filters">
        <span className="flex items-center gap-1.5 px-1 font-mono text-[11px] uppercase tracking-wider text-slate-500">
          <Car className="size-3.5" /> Vehicle
        </span>
        <Select
          value={make}
          onValueChange={(v) => {
            setMake(v as string);
            setModel("all");
          }}
        >
          <SelectTrigger data-testid="calls-make-filter" className="h-9 w-44 bg-surface">
            <SelectValue>{(v) => (v === "all" ? "Any make" : (v as string))}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any make</SelectItem>
            {(vopts.data?.makes ?? []).map((m) => (
              <SelectItem key={m.make} value={m.make}>
                {m.make} ({m.calls})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={model} onValueChange={(v) => setModel(v as string)} disabled={make === "all"}>
          <SelectTrigger data-testid="calls-model-filter" className="h-9 w-48 bg-surface">
            <SelectValue>{(v) => (v === "all" ? "Any model" : (v as string))}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any model</SelectItem>
            {models.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          data-testid="calls-year-from"
          inputMode="numeric"
          value={yearFrom}
          onChange={(e) => setYearFrom(e.target.value.replace(/\D/g, "").slice(0, 4))}
          placeholder={vopts.data?.year_min ? `From ${vopts.data.year_min}` : "Year from"}
          className="h-9 w-28 bg-surface"
        />
        <span className="text-slate-600">–</span>
        <Input
          data-testid="calls-year-to"
          inputMode="numeric"
          value={yearTo}
          onChange={(e) => setYearTo(e.target.value.replace(/\D/g, "").slice(0, 4))}
          placeholder={vopts.data?.year_max ? `To ${vopts.data.year_max}` : "Year to"}
          className="h-9 w-28 bg-surface"
        />
        {vehicleOn && (
          <Button
            variant="ghost"
            size="sm"
            data-testid="calls-vehicle-clear"
            onClick={() => {
              setMake("all");
              setModel("all");
              setYearFrom("");
              setYearTo("");
            }}
          >
            <X className="size-4" /> Clear
          </Button>
        )}
      </div>

      {isLoading && <Loader2 className="mx-auto size-6 animate-spin text-slate-500" />}
      {(isError || (calls && calls.length === 0)) && (
        <EmptyState testId="calls-empty" title="No calls found" body={isError ? "Couldn't load calls right now." : "Try clearing filters or upload a new call."} />
      )}
      {calls && calls.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {isManager && picked.size > 0 && (
            <div data-testid="calls-bulk-bar" className="sticky top-2 z-20 mb-3 flex items-center gap-3 rounded-lg border border-red-500/40 bg-card/95 px-4 py-2.5 backdrop-blur">
              <span data-testid="calls-selected-count" className="text-sm text-white">{picked.size} selected</span>
              <button type="button" className="text-xs text-slate-400 hover:text-white" onClick={() => setPicked(new Set())}>Clear</button>
              <div className="ml-auto" />
              <AddToCallbacks callIds={[...picked]} onDone={() => setPicked(new Set())} />
              <Button
                size="sm"
                variant="destructive"
                data-testid="calls-delete-selected"
                disabled={bulkDelete.isPending}
                onClick={() => window.confirm(`Delete ${picked.size} call log${picked.size === 1 ? "" : "s"}? You can restore them for 7 days from Clean up → Recently deleted.`) && bulkDelete.mutate([...picked])}
              >
                <Trash2 className="size-4" /> Delete selected
              </Button>
            </div>
          )}
          <Table data-testid="calls-table">
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                {isManager && (
                  <TableHead className="w-8">
                    <input
                      type="checkbox"
                      aria-label="Select all shown calls"
                      data-testid="calls-select-all"
                      className="size-4 accent-red-500"
                      checked={calls.slice(0, limit).length > 0 && calls.slice(0, limit).every((c) => picked.has(c.id))}
                      onChange={(e) => setPicked(e.target.checked ? new Set(calls.slice(0, limit).map((c) => c.id)) : new Set())}
                    />
                  </TableHead>
                )}
                <TableHead className="font-mono text-[11px] uppercase tracking-wider">Score</TableHead>
                <TableHead className="font-mono text-[11px] uppercase tracking-wider">Caller</TableHead>
                <TableHead className="font-mono text-[11px] uppercase tracking-wider">Category</TableHead>
                {isManager && <TableHead className="font-mono text-[11px] uppercase tracking-wider">Rep</TableHead>}
                <TableHead className="hidden font-mono text-[11px] uppercase tracking-wider md:table-cell">Vehicle / Part</TableHead>
                <TableHead className="font-mono text-[11px] uppercase tracking-wider">Length</TableHead>
                <TableHead className="font-mono text-[11px] uppercase tracking-wider">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {calls.slice(0, limit).map((c, i) => (
                <motion.tr
                  key={c.id}
                  {...fadeUpSm}
                  transition={{ duration: 0.2, delay: Math.min(i * 0.02, 0.3) }}
                  data-testid={`call-row-${c.id}`}
                  onClick={() => nav(`/calls/${c.id}`)}
                  className={cn("cursor-pointer border-b border-border transition-colors duration-150 hover:bg-slate-800/40", picked.has(c.id) && "bg-red-500/[0.06]")}
                >
                  {isManager && (
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" aria-label="Select call" data-testid={`call-select-${c.id}`} className="size-4 accent-red-500" checked={picked.has(c.id)} onChange={() => togglePick(c.id)} />
                    </TableCell>
                  )}
                  <TableCell>
                    {c.status === "analyzed" || c.status === "imported" ? (
                      <ScoreBadge score={c.overall_score} />
                    ) : (
                      <span className={cn("font-mono text-xs", c.status === "failed" ? "text-red-400" : "text-amber-300")}>
                        {c.status === "processing" ? "analyzing…" : "failed"}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {c.source === "ringcentral" ? (
                        c.direction === "outbound" ? <PhoneOutgoing className="size-3.5 text-sky-400" /> : <PhoneIncoming className="size-3.5 text-amber-400" />
                      ) : c.source === "audio" ? (
                        <FileAudio className="size-3.5 text-sky-400" />
                      ) : (
                        <FileText className="size-3.5 text-slate-500" />
                      )}
                      <span className="font-medium text-white">{c.customer_name}</span>
                      {priceMissing(c) && <PriceMissingBadge testId={`call-price-missing-${c.id}`} />}
                    </div>
                  </TableCell>
                  <TableCell>{c.status === "analyzed" || c.status === "imported" ? <CategoryBadge category={c.category} /> : "—"}</TableCell>
                  {isManager && <TableCell className="text-slate-300">{c.rep_name}</TableCell>}
                  <TableCell className="hidden max-w-[260px] truncate text-slate-400 md:table-cell">
                    {[c.vehicle, c.part_requested].filter(Boolean).join(" · ") || c.topics.slice(0, 3).join(", ") || "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-slate-400">
                    <span className="flex items-center gap-1.5">
                      {c.status === "imported" && <Radio className="size-3 text-slate-600" />}
                      {c.duration_sec ? fmtDuration(c.duration_sec) : "—"}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs text-slate-500">{fmtDate(c.created_at)}</TableCell>
                </motion.tr>
              ))}
            </TableBody>
          </Table>
          {calls.length > limit && (
            <div className="border-t border-border p-3 text-center">
              <Button variant="ghost" data-testid="calls-show-more" onClick={() => setLimit((l) => l + PAGE)}>
                Show more ({calls.length - limit} remaining)
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
