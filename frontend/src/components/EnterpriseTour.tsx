import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BarChart3, CalendarRange, Car, PartyPopper, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiPost } from "@/lib/api";
import { useOrg } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import type { OrgInfo } from "@/lib/types";

const STEPS = [
  { icon: BarChart3, title: "Monthly trends", to: "/dashboard", body: "Calls, close rate and account value month over month, on the Team Dashboard. Load an older phone export to fill in more history." },
  { icon: Users, title: "Rep trend comparison", to: "/team", body: "Every rep's monthly close rate side by side on the Reps page, so you can see who's improving and who needs coaching." },
  { icon: CalendarRange, title: "Seasonal parts & trend alerts", to: "/dashboard", body: "Which parts sell each month, which ones callers ask about but rarely buy, and amber alerts when a topic jumps this month." },
  { icon: Car, title: "Inventory insights", to: "/vehicles", body: "Vehicle demand, stock alerts like \"2017 F-150 doors are up\", the didn't-buy list and your watchlist with a weekly demand email." },
];

/** Welcome tour shown once to each manager right after the yard upgrades to Enterprise. */
export default function EnterpriseTour() {
  const { data: org } = useOrg();
  const [step, setStep] = useState(0);
  const nav = useNavigate();
  const qc = useQueryClient();
  const done = useMutation({
    mutationFn: () => apiPost<OrgInfo>("/org/enterprise-tour/done"),
    onSuccess: (o) => qc.setQueryData(["org"], o),
  });
  const open = !!org?.show_enterprise_tour && !done.isSuccess;
  const close = (to?: string) => {
    done.mutate();
    if (to) nav(to);
  };
  const s = STEPS[step];
  const last = step === STEPS.length - 1;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-lg" data-testid="enterprise-tour">
        <DialogHeader>
          <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-amber-300">
            <PartyPopper className="size-4" /> Welcome to Enterprise
          </p>
          <DialogTitle className="font-heading text-2xl">Here's what you just unlocked</DialogTitle>
          <DialogDescription>Step {step + 1} of {STEPS.length} — your call data is already in, so every one of these is live now.</DialogDescription>
        </DialogHeader>
        <div key={step} data-testid={`enterprise-tour-step-${step}`} className="flex gap-4 rounded-xl border border-border bg-surface p-5 animate-in fade-in slide-in-from-right-2 duration-300">
          <span className="grid size-11 shrink-0 place-items-center rounded-full bg-amber-500/15">
            <s.icon className="size-5 text-amber-300" />
          </span>
          <div>
            <p className="font-heading text-lg font-bold text-white" data-testid="enterprise-tour-title">{s.title}</p>
            <p className="mt-1 text-sm text-slate-400">{s.body}</p>
            <button data-testid="enterprise-tour-show-me" onClick={() => close(s.to)} className="mt-3 text-sm font-medium text-amber-300 transition-colors duration-150 hover:text-amber-200">
              Show me →
            </button>
          </div>
        </div>
        <div className="flex justify-center gap-1.5">
          {STEPS.map((st, i) => (
            <span key={st.title} className={cn("h-1.5 rounded-full transition-[width,background-color] duration-300", i === step ? "w-6 bg-amber-400" : "w-1.5 bg-slate-700")} />
          ))}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" data-testid="enterprise-tour-skip" onClick={() => close()}>Skip tour</Button>
          <div className="flex gap-2">
            {step > 0 && <Button variant="outline" data-testid="enterprise-tour-back" onClick={() => setStep(step - 1)}>Back</Button>}
            {last ? (
              <Button data-testid="enterprise-tour-finish" onClick={() => close("/vehicles")}>Start exploring</Button>
            ) : (
              <Button data-testid="enterprise-tour-next" onClick={() => setStep(step + 1)}>Next</Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
