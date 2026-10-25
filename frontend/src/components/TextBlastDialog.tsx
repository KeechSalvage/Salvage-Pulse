import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MessageSquare } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { apiPost, errorMessage } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import type { Arrival, SmsStatus, TextBlast } from "@/lib/types";

const DEFAULT = "Hi {name}, it's {yard}. The {vehicle} you asked about just came in. Still need the {part}? Call or text us back to grab it!";

/** PRACTICE MODE text blast: personalises a "vehicle is in" text for each caller still to call / called and logs it — nothing is sent. */
export default function TextBlastDialog({ arrival }: { arrival: Arrival }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [template, setTemplate] = useState(DEFAULT);
  const { data: smsStatus } = useQuery({ queryKey: ["sms-status"], queryFn: () => apiGet<SmsStatus>("/sms/status") });
  const live = !!smsStatus?.live;
  const eligible = arrival.callers.filter((c) => (c.status === "to_call" || c.status === "called") && c.customer_phone);
  const first = eligible[0];
  const preview = first
    ? template
        .replace("{name}", (first.customer_name.split(",").pop() ?? "").trim().split(" ")[0].toLowerCase().replace(/^\w/, (x) => x.toUpperCase()) || "there")
        .replace("{vehicle}", `${arrival.vehicle_year} ${arrival.vehicle_make} ${arrival.vehicle_model}`)
        .replace("{part}", (first.parts[0] ?? "part").toLowerCase())
        .replace("{yard}", "your yard")
    : "";
  const send = useMutation({
    mutationFn: () => apiPost<Arrival>(`/arrivals/${arrival.id}/text`, { template } satisfies TextBlast),
    onSuccess: (a) => {
      qc.setQueryData<Arrival[]>(["arrivals"], (old) => old?.map((x) => (x.id === a.id ? a : x)));
      const b = a.blasts[a.blasts.length - 1];
      if (b?.mode === "live") toast.success(`${b.count} texts sent${b.failed ? ` · ${b.failed} failed (see the list)` : ""}`);
      else toast.success(`Practice mode: ${b?.count ?? 0} texts logged — nothing was sent`);
      setOpen(false);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <>
      <Button variant="outline" size="sm" data-testid="arrival-text-button" disabled={!eligible.length} onClick={() => setOpen(true)} title={live ? "Twilio connected" : "Practice mode"}>
        <MessageSquare className="size-4" /> Text {eligible.length} caller{eligible.length === 1 ? "" : "s"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg" data-testid="text-blast-dialog">
          <DialogHeader>
            <DialogTitle>Text everyone the vehicle is in</DialogTitle>
            <DialogDescription>
              {smsStatus?.problem ? (
                <span className="font-semibold text-red-300" data-testid="text-blast-problem">Twilio is connected but can't send yet: {smsStatus.problem}</span>
              ) : live ? (
                <span className="font-semibold text-emerald-300" data-testid="text-blast-live">Live — texts really send from your Twilio number {smsStatus?.from_number}.</span>
              ) : (
                <span className="font-semibold text-amber-300" data-testid="text-blast-practice">Practice mode — no real texts are sent (Twilio not connected).</span>
              )}{" "}
              Each text is personalised and logged on the list. Skips callers marked Sold or No{live ? " and anyone who texted STOP" : ""}. Replies show on the list automatically.
            </DialogDescription>
          </DialogHeader>
          <Textarea data-testid="text-blast-template" rows={4} value={template} onChange={(e) => setTemplate(e.target.value)} maxLength={320} />
          <p className="text-[11px] text-slate-500">Fill-ins: {"{name} {vehicle} {part} {yard}"} · {template.length}/320</p>
          {first && (
            <div className="rounded-lg border border-border bg-surface p-3 text-sm text-slate-200" data-testid="text-blast-preview">
              <p className="mb-1 font-mono text-[10px] uppercase text-slate-500">Preview for {first.customer_name}</p>
              {preview}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button data-testid="text-blast-send" disabled={template.length < 10 || send.isPending || !!smsStatus?.problem} onClick={() => send.mutate()}>
              {live ? `Send ${eligible.length} texts` : `Log ${eligible.length} practice texts`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
