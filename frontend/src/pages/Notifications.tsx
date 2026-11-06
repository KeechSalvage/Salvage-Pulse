import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellRing, Check, Loader2, PanelTop, Play, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useCallPopups } from "@/components/CallPopupProvider";
import { Overline, Panel } from "@/components/common";
import { apiGet, apiPut, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { CallPopupMode, CallPopupSettings } from "@/lib/types";

const OPTIONS: { mode: CallPopupMode; title: string; body: string; icon: typeof Bell }[] = [
  {
    mode: "popup",
    title: "Pop up immediately",
    body: "Open the caller card as soon as a call arrives. If another call is already open, the next one waits.",
    icon: BellRing,
  },
  {
    mode: "queue",
    title: "Queue in corner",
    body: "Keep calls in a small stack in the corner. Click a card when you are ready to look at it.",
    icon: PanelTop,
  },
  {
    mode: "off",
    title: "Off",
    body: "Do not show incoming-call popups for this account.",
    icon: X,
  },
];

export default function Notifications() {
  const qc = useQueryClient();
  const { preview } = useCallPopups();
  const settings = useQuery({
    queryKey: ["call-popups", "prefs"],
    queryFn: () => apiGet<CallPopupSettings>("/me/call-popups"),
  });
  const [mode, setMode] = useState<CallPopupMode>("popup");

  useEffect(() => {
    if (settings.data) setMode(settings.data.mode);
  }, [settings.data?.mode]);

  const save = useMutation({
    mutationFn: () => apiPut<CallPopupSettings>("/me/call-popups", { mode }),
    onSuccess: (data) => {
      qc.setQueryData(["call-popups", "prefs"], data);
      toast.success("Call popup preference saved");
    },
    onError: (error) => toast.error(errorMessage(error, "Could not save popup preference")),
  });

  const dirty = settings.data?.mode !== mode;

  return (
    <div className="max-w-4xl">
      <h2 className="mb-1 font-heading text-2xl font-bold text-white">Notifications</h2>
      <p className="mb-4 text-sm text-slate-400">
        Choose how incoming calls appear while you are signed in. The popup shows the caller's number, matched customer,
        notes, and previous calls from any of their numbers.
      </p>

      <Panel testId="call-popup-settings" className="mb-6">
        <div className="flex items-center gap-2">
          <Bell className="size-4 text-amber-400" />
          <Overline>Incoming calls</Overline>
        </div>
        <h3 className="mt-1 text-xl font-bold text-white">Screen pop behaviour</h3>

        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {OPTIONS.map((option) => {
            const Icon = option.icon;
            const selected = mode === option.mode;
            return (
              <button
                key={option.mode}
                type="button"
                data-testid={`call-popup-mode-${option.mode}`}
                onClick={() => setMode(option.mode)}
                className={cn(
                  "relative rounded-xl border p-4 text-left transition-colors",
                  selected ? "border-amber-400/70 bg-amber-500/10" : "border-border bg-surface hover:border-slate-600",
                )}
              >
                {selected && (
                  <span className="absolute right-3 top-3 flex size-5 items-center justify-center rounded-full bg-amber-500 text-slate-950">
                    <Check className="size-3.5" />
                  </span>
                )}
                <Icon className={cn("size-5", selected ? "text-amber-300" : "text-slate-400")} />
                <p className="mt-3 text-sm font-semibold text-white">{option.title}</p>
                <p className="mt-1 text-xs leading-relaxed text-slate-400">{option.body}</p>
              </button>
            );
          })}
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button data-testid="call-popup-save" onClick={() => save.mutate()} disabled={!settings.data || !dirty || save.isPending}>
            {save.isPending && <Loader2 className="size-4 animate-spin" />} Save preference
          </Button>
          <Button variant="outline" data-testid="call-popup-preview" onClick={preview}>
            <Play className="size-3.5" /> Preview popup
          </Button>
          {settings.isLoading && <span className="text-xs text-slate-500">Loading saved preference…</span>}
          {settings.isError && <span className="text-xs text-red-300">{errorMessage(settings.error, "Could not load preference")}</span>}
        </div>
      </Panel>

      <Panel>
        <Overline>What appears in the popup</Overline>
        <ul className="mt-3 grid gap-2 text-sm text-slate-300 md:grid-cols-2">
          <li>Caller number and direction</li>
          <li>Matched customer and business type</li>
          <li>Which line the call came in on</li>
          <li>Customer notes from their profile</li>
          <li>Previous calls from any of their numbers</li>
          <li>Links to the call and customer profile</li>
        </ul>
        <p className="mt-4 text-xs text-slate-500">
          Popups use the call events your phone integration already sends. If the provider sends a call-started event,
          the popup appears while the call is happening; completed-call events still show the caller card once.
        </p>
      </Panel>
    </div>
  );
}
