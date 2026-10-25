import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Overline, PageHeader, Panel } from "@/components/common";
import { apiDelete, apiGet, apiPost, apiPut, errorMessage } from "@/lib/api";
import { useKeywords, useOrg } from "@/lib/hooks";
import type { Keyword, KeywordCreate, KeywordMonth, KeywordSuggestion, OkResponse, Overview, PhraseBody } from "@/lib/types";
import RepWordUsePanel from "@/components/RepWordUse";
import TileCallsDialog, { type TilePick } from "@/components/TileCallsDialog";

function TileEditor({ k, onDone }: { k: Keyword; onDone: () => void }) {
  const qc = useQueryClient();
  const [words, setWords] = useState(k.keyword.split("/").map((w) => w.trim()).filter(Boolean));
  const [group, setGroup] = useState(k.group);
  const [draft, setDraft] = useState("");
  const addWord = () => {
    const parts = draft.split(/[,/]/).map((w) => w.trim()).filter((w) => w && !words.some((x) => x.toLowerCase() === w.toLowerCase()));
    if (parts.length) setWords([...words, ...parts]);
    setDraft("");
  };
  const save = useMutation({
    mutationFn: () => apiPut<Keyword>(`/keywords/${k.id}`, { keyword: words.join(" / "), group } satisfies KeywordCreate),
    onSuccess: () => {
      toast.success("Tile updated — counts include past calls");
      qc.invalidateQueries({ queryKey: ["keywords"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
      onDone();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <div data-testid={`keyword-editor-${k.id}`} className="mt-3 space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {words.map((w, i) => (
          <span key={w} data-testid={`keyword-word-${k.id}-${i}`} className="flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-0.5 font-mono text-xs text-emerald-200">
            {w}
            <button data-testid={`keyword-word-remove-${k.id}-${i}`} onClick={() => setWords(words.filter((x) => x !== w))} className="text-emerald-400/70 hover:text-red-300" title="Remove word">
              <X className="size-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          data-testid={`keyword-word-input-${k.id}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addWord();
            }
          }}
          placeholder="Add a word or phrase (comma for several)"
          className="h-9 bg-surface text-sm"
        />
        <Button size="sm" variant="outline" data-testid={`keyword-word-add-${k.id}`} onClick={addWord} disabled={!draft.trim()}>
          <Plus className="size-3.5" /> Add
        </Button>
      </div>
      <Input data-testid={`keyword-group-edit-${k.id}`} value={group} onChange={(e) => setGroup(e.target.value)} placeholder="Group" className="h-9 bg-surface text-sm" />
      <div className="flex gap-2">
        <Button size="sm" data-testid={`keyword-save-${k.id}`} disabled={save.isPending || words.length === 0} onClick={() => save.mutate()}>
          Save
        </Button>
        <Button size="sm" variant="ghost" data-testid={`keyword-cancel-${k.id}`} onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function WordTrend({ id, monthly, onPick }: { id: string; monthly: KeywordMonth[]; onPick: (month: string) => void }) {
  const max = Math.max(1, ...monthly.map((m) => m.calls));
  const recent = monthly.slice(-3).reduce((a, m) => a + m.calls, 0);
  const before = monthly.slice(0, -3).reduce((a, m) => a + m.calls, 0);
  const trend = recent > before * 1.15 && recent - before >= 2 ? "Rising" : before > recent * 1.15 && before - recent >= 2 ? "Fading" : "Steady";
  const tone = trend === "Rising" ? "text-emerald-300" : trend === "Fading" ? "text-amber-400" : "text-slate-400";
  return (
    <div className="ml-auto text-right" data-testid={`keyword-trend-${id}`}>
      <div className="flex h-10 items-end justify-end gap-1">
        {monthly.map((m) => (
          <button
            key={m.month}
            type="button"
            onClick={() => onPick(m.month)}
            title={`${MONTHS[Number(m.month.slice(5)) - 1]}: ${m.calls} calls — tap to see them`}
            data-testid={`keyword-trend-bar-${id}-${m.month}`}
            className="flex h-full w-3 cursor-pointer flex-col justify-end"
          >
            <div className="w-full rounded-sm bg-emerald-500/60 transition-[height,background-color] duration-300 hover:bg-emerald-300" style={{ height: `${Math.max(2, (m.calls / max) * 40)}px` }} />
          </button>
        ))}
      </div>
      <div className="mt-1 flex justify-end gap-1 font-mono text-[9px] text-slate-600">
        {monthly.map((m) => (
          <span key={m.month} className="w-3 text-center">{MONTHS[Number(m.month.slice(5)) - 1][0]}</span>
        ))}
      </div>
      <p data-testid={`keyword-trend-label-${id}`} className={`mt-0.5 font-mono text-[10px] uppercase tracking-wider ${tone}`}>{trend}</p>
    </div>
  );
}

const titleCase = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

export default function Keywords() {
  const qc = useQueryClient();
  const keywords = useKeywords();
  const ov = useQuery({ queryKey: ["overview", "team"], queryFn: () => apiGet<Overview>("/analytics/overview") });
  const [keyword, setKeyword] = useState("");
  const [group, setGroup] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [pick, setPick] = useState<TilePick | null>(null);
  const org = useOrg();
  const suggestions = useQuery({ queryKey: ["keyword-suggestions"], queryFn: () => apiGet<KeywordSuggestion[]>("/keywords/suggestions") });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["keywords"] });
    qc.invalidateQueries({ queryKey: ["overview"] });
    qc.invalidateQueries({ queryKey: ["keyword-suggestions"] });
    qc.invalidateQueries({ queryKey: ["keyword-rep-usage"] });
    qc.invalidateQueries({ queryKey: ["keyword-alerts"] });
  };
  const track = useMutation({
    mutationFn: (phrase: string) => apiPost<Keyword>("/keywords", { keyword: titleCase(phrase), group: "Suggested" }),
    onSuccess: (k) => {
      toast.success(`Now tracking "${k.keyword}"`);
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const restore = useMutation({
    mutationFn: (phrase: string) => apiPost<OkResponse>("/keywords/suggestions/restore", { phrase } satisfies PhraseBody),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["keyword-suggestions"] }),
  });
  const dismiss = useMutation({
    mutationFn: (phrase: string) => apiPost<OkResponse>("/keywords/suggestions/dismiss", { phrase } satisfies PhraseBody),
    onSuccess: (_r, phrase) => {
      qc.invalidateQueries({ queryKey: ["keyword-suggestions"] });
      toast(`Hid "${titleCase(phrase)}"`, { action: { label: "Undo", onClick: () => restore.mutate(phrase) } });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const add = useMutation({
    mutationFn: () => apiPost<Keyword>("/keywords", { keyword, group: group || "General" }),
    onSuccess: (k) => {
      toast.success(`Now tracking "${k.keyword}"`);
      setKeyword("");
      setGroup("");
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => apiDelete(`/keywords/${id}`),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  });

  const stat = (kw: string) => ov.data?.keyword_stats.find((s) => s.keyword === kw);
  const total = ov.data?.total_calls ?? 0;

  return (
    <>
      <PageHeader overline="Keyword tracker" title="Words that move parts" />
      <Panel className="mb-6" testId="keyword-add-panel">
        <Overline>Track a new keyword</Overline>
        <form
          className="mt-3 flex flex-wrap gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (keyword.trim()) add.mutate();
          }}
        >
          <Input data-testid="keyword-input" value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder='e.g. "Hollander" or "Discount / Best Price"' className="h-10 min-w-[260px] flex-1 bg-surface" />
          <Input data-testid="keyword-group-input" value={group} onChange={(e) => setGroup(e.target.value)} placeholder="Group (Fitment, Competitor…)" className="h-10 w-56 bg-surface" />
          <Button data-testid="keyword-add-button" type="submit" className="h-10" disabled={add.isPending || !keyword.trim()}>
            <Plus className="size-4" /> Track
          </Button>
        </form>
        <p className="mt-2 text-xs text-slate-500">Use “/” to group synonyms. Matching is case-insensitive whole-word across every transcript, including past calls.</p>
      </Panel>

      <Panel className="mb-6" testId="keyword-suggestions-panel">
        <Overline>Suggested words</Overline>
        <p className="mt-1 text-xs text-slate-500">Come up often in your calls but no tile tracks them yet. Tap one to start tracking it.</p>
        {!!org.data?.suggestion_cap && (
          <p data-testid="keyword-suggestions-trial-cap" className="mt-1 text-xs text-orange-300">Free-trial limit: showing the top {org.data.suggestion_cap}. Upgrade to see them all.</p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {suggestions.isLoading && <p className="text-sm text-slate-500">Reading your calls…</p>}
          {suggestions.data?.length === 0 && <p data-testid="keyword-suggestions-empty" className="text-sm text-slate-500">Nothing new right now — your tiles cover the common words.</p>}
          {(suggestions.data ?? []).map((s, i) => (
            <span key={s.phrase} className="flex items-center rounded-full border border-dashed border-slate-600 text-sm text-slate-200 transition-[border-color,background-color,transform] duration-150 hover:-translate-y-0.5 hover:border-emerald-400 hover:bg-emerald-500/10">
              <button
                data-testid={`keyword-suggestion-${i}`}
                disabled={track.isPending}
                onClick={() => track.mutate(s.phrase)}
                className="flex items-center gap-2 py-1 pl-3 pr-1.5 disabled:opacity-50"
              >
                <Plus className="size-3.5 text-emerald-300" />
                {titleCase(s.phrase)}
                <span className="font-mono text-[11px] text-slate-500">{s.calls} calls</span>
              </button>
              <button
                data-testid={`keyword-suggestion-dismiss-${i}`}
                title="Hide this suggestion"
                disabled={dismiss.isPending}
                onClick={() => dismiss.mutate(s.phrase)}
                className="mr-1 rounded-full p-1 text-slate-500 transition-colors duration-150 hover:bg-slate-700 hover:text-red-300"
              >
                <X className="size-3.5" />
              </button>
            </span>
          ))}
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3" data-testid="keyword-list">
        {(keywords.data ?? []).map((k) => {
          const s = stat(k.keyword);
          const pct = total ? Math.round(((s?.calls ?? 0) / total) * 100) : 0;
          return (
            <div key={k.id} data-testid={`keyword-card-${k.id}`} className="group rounded-xl border border-border bg-card p-5 transition-colors duration-150 hover:border-emerald-500/40">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-mono text-lg text-emerald-300">{k.keyword}</p>
                  <p className="font-mono text-[11px] uppercase tracking-wider text-slate-500">{k.group}</p>
                </div>
                <div className="flex gap-2">
                  <button data-testid={`keyword-edit-${k.id}`} onClick={() => setEditing(editing === k.id ? null : k.id)} className="text-slate-500 transition-colors duration-150 hover:text-emerald-300" title="Edit words">
                    <Pencil className="size-4" />
                  </button>
                  <button data-testid={`keyword-delete-${k.id}`} onClick={() => remove.mutate(k.id)} className="text-slate-600 opacity-0 transition-opacity duration-150 hover:text-red-400 group-hover:opacity-100">
                    <Trash2 className="size-4" />
                  </button>
                </div>
              </div>
              {editing === k.id && <TileEditor k={k} onDone={() => setEditing(null)} />}
              <div className="mt-4 flex items-end gap-6">
                <div>
                  <p className="font-heading text-3xl font-bold text-white">{s?.count ?? 0}</p>
                  <p className="text-xs text-slate-500">mentions</p>
                </div>
                <div>
                  <p className="font-heading text-3xl font-bold text-white">{pct}%</p>
                  <p className="text-xs text-slate-500">of calls</p>
                </div>
                {s?.monthly && s.monthly.length > 0 && <WordTrend id={k.id} monthly={s.monthly} onPick={(month) => setPick({ id: k.id, keyword: k.keyword, month })} />}
              </div>
              <div className="mt-3 h-1 rounded-full bg-slate-800">
                <div className="h-full rounded-full bg-emerald-500/70 transition-[width] duration-500" style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
      <RepWordUsePanel />
      <TileCallsDialog pick={pick} onClose={() => setPick(null)} />
    </>
  );
}
