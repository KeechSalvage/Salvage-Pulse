import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, MessageSquareText } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Overline, Panel } from "@/components/common";
import { apiGet, apiPut, errorMessage } from "@/lib/api";
import type { DeliveryTips } from "@/lib/types";
import { cn } from "@/lib/utils";

const STEPS: { k: keyof DeliveryTips; label: string; step: string; def: string }[] = [
  { k: "date_given", label: "Missed: delivery date given", step: "Delivery date given", def: 'Next time, give the customer a delivery day and time window ("Thursday between 9 and noon").' },
  { k: "address_confirmed", label: "Missed: address confirmed", step: "Address confirmed", def: "Next time, read the delivery address back to the customer before you hang up." },
  { k: "thanked", label: "Missed: thanked the customer", step: "Thanked the customer", def: "Next time, finish every delivery call by thanking them for the order." },
];

/** Reps page (manager): the yard's own text tips sent after 3 delivery calls in a row miss the same step. */
export default function DeliveryTipLibrary() {
  const { data } = useQuery({ queryKey: ["settings", "delivery-tips"], queryFn: () => apiGet<DeliveryTips>("/settings/delivery-tips") });
  return (
    <Panel testId="delivery-tips-panel">
      <div className="flex items-center gap-2">
        <MessageSquareText className="size-4 text-sky-300" />
        <Overline>Delivery tip texts</Overline>
      </div>
      <h3 className="mb-1 mt-1 text-xl font-bold text-white">Coach in your yard's voice</h3>
      <p className="mb-4 text-xs text-slate-500">Texted to a rep when their last 3 delivery calls miss the same step. Leave a box blank to use the Salvage Pulse tip shown in grey.</p>
      {data ? <Form key={JSON.stringify(data)} data={data} /> : <div className="h-40 animate-pulse rounded-lg bg-surface" />}
    </Panel>
  );
}

function Form({ data }: { data: DeliveryTips }) {
  const qc = useQueryClient();
  const [f, setF] = useState(data);
  const [preview, setPreview] = useState<keyof DeliveryTips | null>(null);
  // exactly what the server texts: the yard's tip, else the default with the miss streak
  const text = (s: (typeof STEPS)[number]) => `Salvage Pulse tip: ${f[s.k].trim() || `your last 3 delivery calls missed "${s.step}". ${s.def}`}`;
  const save = useMutation({
    mutationFn: () => apiPut<DeliveryTips>("/settings/delivery-tips", f),
    onSuccess: (d) => (qc.setQueryData(["settings", "delivery-tips"], d), toast.success("Delivery tips saved")),
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), save.mutate())}>
      {STEPS.map((s) => (
        <label key={s.k} className="block">
          <span className="mb-1 flex justify-between text-sm text-slate-300">{s.label}<span className={cn("font-mono text-[11px]", f[s.k].trim() && text(s).length > 160 ? "text-amber-300" : "text-slate-500")}>{f[s.k].trim() ? `${text(s).length}/160 as sent` : "default tip"}</span></span>
          <Textarea data-testid={`delivery-tip-${s.k}`} rows={2} value={f[s.k]} placeholder={s.def} onChange={(e) => setF({ ...f, [s.k]: e.target.value.slice(0, 160) })} />
          <button type="button" data-testid={`delivery-tip-preview-${s.k}`} onClick={(e) => (e.preventDefault(), setPreview(preview === s.k ? null : s.k))}
            className="mt-1 inline-flex items-center gap-1 text-xs text-sky-400 hover:underline">
            <Eye className="size-3" /> {preview === s.k ? "Hide preview" : "Preview on a phone"}
          </button>
          {f[s.k].trim() && text(s).length > 160 && (
            <p data-testid={`delivery-tip-long-${s.k}`} className="mt-1 text-xs text-amber-300">
              ⚠ With “Salvage Pulse tip:” in front this is {text(s).length} characters — it will arrive as 2 texts. Trim {text(s).length - 160} to keep it to one.
            </p>
          )}
          {preview === s.k && (
            <div data-testid={`delivery-tip-phone-${s.k}`} className="mt-2 w-72 rounded-[2rem] border-4 border-slate-700 bg-slate-950 p-3 shadow-xl">
              <p className="mb-2 text-center font-mono text-[10px] text-slate-500">Text Message · now</p>
              <p data-testid={`delivery-tip-bubble-${s.k}`} className="w-fit max-w-[95%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-slate-700 px-3 py-2 text-[13px] leading-snug text-white">{text(s)}</p>
              <p className="mt-2 text-right font-mono text-[10px] text-slate-500">{text(s).length} chars · {text(s).length > 160 ? "2 texts" : "1 text"}</p>
            </div>
          )}
        </label>
      ))}
      <p className="text-xs text-slate-500">Texts start with “Salvage Pulse tip:” and respect each rep's days off and vacation.</p>
      <div className="flex justify-end">
        <Button size="sm" type="submit" data-testid="delivery-tips-save" disabled={save.isPending || JSON.stringify(f) === JSON.stringify(data)}>Save tips</Button>
      </div>
    </form>
  );
}
