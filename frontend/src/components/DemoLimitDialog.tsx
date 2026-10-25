import { useEffect, useState } from "react";
import { Rocket, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useNavigate } from "react-router-dom";
import { DEMO_LIMIT_EVENT, apiPost, errorMessage, type DemoLimitKind } from "@/lib/api";
import type { ResendResult } from "@/lib/types";
import { endSession } from "@/lib/session";

const COPY: Record<DemoLimitKind, { tag: string; title: string; body: string; bullets: string[]; cta: string }> = {
  ai: {
    tag: "Demo AI used up for today",
    title: "Liking what you see?",
    body: "The public demo gets a few AI role-plays and call scores a day. Try your own yard free for a day — no card — with your real calls and your own team.",
    bullets: ["• Connect RingCentral or any phone system", "• Sample calls to explore until your calls arrive", "• No card needed for your free day"],
    cta: "Start your free day",
  },
  verify: {
    tag: "One quick step",
    title: "Confirm your email to switch on AI",
    body: "We sent a confirmation link when you signed up. Tap it and AI call scoring and role-play switch on for your free day.",
    bullets: ["• Check your spam or promotions folder", "• The link works for 48 hours", "• Everything else works while you wait"],
    cta: "Resend the email",
  },
  trial: {
    tag: "Today's free AI is used up",
    title: "Keep the AI coaching going",
    body: "Your free day includes a few AI role-plays and call scores. Add a card to start your 7-day free trial with unlimited AI — nothing is charged for 7 days.",
    bullets: ["• Unlimited role-play and call scoring", "• Cancel any time before day 7", "• Your calls and settings carry over"],
    cta: "Add card — 7 days free",
  },
};

/** A daily AI allowance ran out → one tap to the next step (demo: start a free day; free day: add a card for the 7-day trial). */
export default function DemoLimitDialog() {
  const [kind, setKind] = useState<DemoLimitKind | null>(null);
  const [leaving, setLeaving] = useState(false);
  const nav = useNavigate();
  useEffect(() => {
    const on = (e: Event) => {
      toast.dismiss(); // the dialog replaces the plain "allowance used up" error toast
      setKind((e as CustomEvent<DemoLimitKind>).detail ?? "ai");
    };
    window.addEventListener(DEMO_LIMIT_EVENT, on);
    return () => window.removeEventListener(DEMO_LIMIT_EVENT, on);
  }, []);
  const c = COPY[kind ?? "ai"];
  const go = () => {
    if (kind === "verify") {
      setLeaving(true);
      apiPost<ResendResult>("/auth/resend-verification")
        .then((r) => (r.sent ? toast.success("Sent — check your inbox") : toast.error("Email is unavailable right now — try again shortly")))
        .catch((e) => toast.error(errorMessage(e, "Couldn't resend")))
        .finally(() => {
          setLeaving(false);
          setKind(null);
        });
      return;
    }
    if (kind === "trial") {
      setKind(null);
      nav("/billing");
      return;
    }
    setLeaving(true);
    void endSession("/signup?plan=pro");
  };
  return (
    <Dialog open={kind !== null} onOpenChange={(o) => !o && setKind(null)}>
      <DialogContent className="sm:max-w-md" data-testid="demo-limit-dialog">
        <DialogHeader>
          <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-amber-300">
            <Sparkles className="size-4" /> {c.tag}
          </p>
          <DialogTitle className="font-heading text-2xl">{c.title}</DialogTitle>
          <DialogDescription>{c.body}</DialogDescription>
        </DialogHeader>
        <ul className="space-y-1.5 text-sm text-slate-300">
          {c.bullets.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
        <DialogFooter className="gap-2">
          <Button variant="ghost" data-testid="demo-limit-keep-exploring" onClick={() => setKind(null)}>
            Keep exploring
          </Button>
          <Button data-testid="demo-limit-start-trial" disabled={leaving} onClick={go}>
            <Rocket className="size-4" /> {c.cta}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
