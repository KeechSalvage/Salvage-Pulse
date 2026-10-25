import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { apiPost, apiPut, errorMessage } from "@/lib/api";
import type { Scenario, ScenarioCreate, ScenarioIdea } from "@/lib/types";

const EMPTY: ScenarioCreate = { title: "", difficulty: "Medium", persona: "", objective: "", opening_hint: "", customer_brief: "", price_objection: false };

/** Manager form to create or edit a custom role-play caller, with an AI "write it for me" helper. */
export default function ScenarioEditor({ open, editing, onClose }: { open: boolean; editing: Scenario | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState<ScenarioCreate>(EMPTY);
  const [idea, setIdea] = useState("");

  useEffect(() => {
    if (!open) return;
    setIdea("");
    setF(
      editing
        ? {
            title: editing.title,
            difficulty: (editing.difficulty as ScenarioCreate["difficulty"]) || "Medium",
            persona: editing.persona,
            objective: editing.objective,
            opening_hint: editing.opening_hint,
            customer_brief: editing.customer_brief,
            price_objection: editing.price_objection,
          }
        : EMPTY,
    );
  }, [open, editing]);

  const set = <K extends keyof ScenarioCreate>(k: K, v: ScenarioCreate[K]) => setF((p) => ({ ...p, [k]: v }));

  const draft = useMutation({
    mutationFn: () => apiPost<ScenarioCreate>("/roleplay/scenarios/draft", { idea } satisfies ScenarioIdea),
    onSuccess: (d) => {
      setF(d);
      toast.success("Draft ready — review and save");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const save = useMutation({
    mutationFn: () => (editing ? apiPut<Scenario>(`/roleplay/scenarios/${editing.id}`, f) : apiPost<Scenario>("/roleplay/scenarios", f)),
    onSuccess: (s) => {
      toast.success(editing ? "Role-play updated" : `"${s.title}" is ready for your reps`);
      qc.invalidateQueries({ queryKey: ["scenarios"] });
      qc.invalidateQueries({ queryKey: ["roleplay-scoreboard"] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const valid = f.title.trim().length >= 3 && f.persona.trim().length >= 3 && f.objective.trim().length >= 10 && f.customer_brief.trim().length >= 20;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" data-testid="scenario-editor">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit role-play" : "Create a role-play"}</DialogTitle>
          <DialogDescription>Describe the caller your reps will practise with. The AI plays this customer on the call.</DialogDescription>
        </DialogHeader>

        {!editing && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
            <Label className="text-xs text-amber-300">Quick start — describe the call in a sentence</Label>
            <div className="mt-2 flex gap-2">
              <Input
                data-testid="scenario-idea-input"
                value={idea}
                onChange={(e) => setIdea(e.target.value)}
                placeholder="e.g. Fleet manager wants 4 alternators but says LKQ is cheaper"
                className="bg-surface"
              />
              <Button data-testid="scenario-draft-button" variant="outline" disabled={idea.trim().length < 5 || draft.isPending} onClick={() => draft.mutate()}>
                {draft.isPending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} Write it for me
              </Button>
            </div>
          </div>
        )}

        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-[1fr_160px]">
            <div className="grid gap-1.5">
              <Label htmlFor="sc-title">Title</Label>
              <Input id="sc-title" data-testid="scenario-title-input" value={f.title} onChange={(e) => set("title", e.target.value)} placeholder="Fleet Alternator Price Push" />
            </div>
            <div className="grid gap-1.5">
              <Label>Difficulty</Label>
              <Select value={f.difficulty} onValueChange={(v) => set("difficulty", v as ScenarioCreate["difficulty"])}>
                <SelectTrigger data-testid="scenario-difficulty-select" className="w-full">
                  <SelectValue>{(v) => v as string}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {(["Easy", "Medium", "Hard"] as const).map((d) => (
                    <SelectItem key={d} value={d}>{d}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="sc-persona">Who's calling</Label>
            <Input id="sc-persona" data-testid="scenario-persona-input" value={f.persona} onChange={(e) => set("persona", e.target.value)} placeholder="Rita, fleet manager for a plumbing company" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="sc-objective">Rep's goal (shown to the rep and used for grading)</Label>
            <Textarea id="sc-objective" data-testid="scenario-objective-input" rows={2} value={f.objective} onChange={(e) => set("objective", e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="sc-brief">Caller's hidden playbook (only the AI and managers see this)</Label>
            <Textarea
              id="sc-brief"
              data-testid="scenario-brief-input"
              rows={5}
              value={f.customer_brief}
              onChange={(e) => set("customer_brief", e.target.value)}
              placeholder="Exact vehicle and part, budget, objections to raise, what finally convinces them to buy…"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="sc-hint">Hint shown before the call (optional)</Label>
            <Input id="sc-hint" data-testid="scenario-hint-input" value={f.opening_hint} onChange={(e) => set("opening_hint", e.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <Checkbox data-testid="scenario-price-checkbox" checked={f.price_objection} onCheckedChange={(c) => set("price_objection", c === true)} />
            Price-objection practice (shows in the price column on the Role-Play Scores Board)
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" data-testid="scenario-cancel-button" onClick={onClose}>Cancel</Button>
          <Button data-testid="scenario-save-button" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
            {save.isPending && <Loader2 className="size-4 animate-spin" />} {editing ? "Save changes" : "Create role-play"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
