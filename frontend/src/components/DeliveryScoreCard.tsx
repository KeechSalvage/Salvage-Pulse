import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarCheck, Loader2, MapPin, Sparkles, ThumbsUp } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Overline, Panel, ScoreBadge } from "@/components/common";
import { apiPost, apiPut, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Call, CallSummary, DeliveryCheckUpdate } from "@/lib/types";

const ITEMS = [
  { k: "date_given", label: "Delivery date given", hint: "Gave or confirmed a date / time window", icon: CalendarCheck },
  { k: "address_confirmed", label: "Address confirmed", hint: "Confirmed where it's going (or pickup spot)", icon: MapPin },
  { k: "thanked", label: "Thanked the customer", hint: "Thanked them for the order", icon: ThumbsUp },
] as const;

/** Delivery calls get their own 3-point checklist instead of the sales scorecard. AI fills it from a transcript; anyone can tick by hand. */
export default function DeliveryScoreCard({ call }: { call: Call }) {
  const qc = useQueryClient();
  const chk = call.delivery_check;
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["call", call.id] });
    qc.invalidateQueries({ queryKey: ["calls"] });
  };
  const save = useMutation({
    mutationFn: (b: DeliveryCheckUpdate) => apiPut<CallSummary>(`/calls/${call.id}/delivery-check`, b),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const ai = useMutation({
    mutationFn: () => apiPost<CallSummary>(`/calls/${call.id}/delivery-check/ai`),
    onSuccess: () => (toast.success("Delivery checklist scored by AI"), refresh()),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const cur: DeliveryCheckUpdate = { date_given: !!chk?.date_given, address_confirmed: !!chk?.address_confirmed, thanked: !!chk?.thanked };
  return (
    <Panel testId="delivery-scorecard" className="mb-6 border-sky-500/30">
      <div className="flex flex-wrap items-center gap-4">
        {call.delivery_score != null ? <ScoreBadge score={call.delivery_score} testId="delivery-score" /> : <span data-testid="delivery-score" className="font-mono text-sm text-slate-500">—</span>}
        <div className="min-w-0 flex-1">
          <Overline className="text-sky-300">{call.delivery_kind === "confirmation" ? "Delivery confirmation checklist" : "Delivery call checklist"}</Overline>
          <p className="mt-1 text-xs text-slate-400">
            Scored on delivery basics, not the sales checklist.{" "}
            {chk ? (chk.source === "ai" ? "Scored by AI from the transcript." : `Ticked by ${chk.by}.`) : call.transcript ? "Scoring with AI…" : "No transcript — tick what the rep did."}
          </p>
        </div>
        {!!call.transcript && (
          <Button size="sm" variant="outline" data-testid="delivery-ai-button" disabled={ai.isPending} onClick={() => ai.mutate()}>
            {ai.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} {chk?.source === "ai" ? "Re-score" : "Score with AI"}
          </Button>
        )}
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        {ITEMS.map(({ k, label, hint, icon: Icon }) => {
          const on = cur[k];
          return (
            <button key={k} type="button" data-testid={`delivery-check-${k}`} aria-pressed={on} disabled={save.isPending} onClick={() => save.mutate({ ...cur, [k]: !on })}
              className={cn("flex items-start gap-3 rounded-lg border p-3 text-left transition-colors duration-150",
                on ? "border-emerald-500/50 bg-emerald-500/[0.07]" : "border-border bg-surface hover:border-slate-500")}>
              <Icon className={cn("mt-0.5 size-4 shrink-0", on ? "text-emerald-300" : "text-slate-500")} />
              <span>
                <span className={cn("block text-sm", on ? "text-white" : "text-slate-300")}>{label}</span>
                <span className="block text-xs text-slate-500">{hint}</span>
              </span>
            </button>
          );
        })}
      </div>
      {chk?.notes && <p data-testid="delivery-notes" className="mt-3 text-sm text-slate-300">💡 {chk.notes}</p>}
    </Panel>
  );
}
