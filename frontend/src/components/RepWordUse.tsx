import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Overline, Panel } from "@/components/common";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiGet } from "@/lib/api";
import type { RepWordUse } from "@/lib/types";

/** Compare two tiles rep by rep — e.g. Warranty (selling value) vs Pricing (selling price). */
export default function RepWordUsePanel() {
  const { data } = useQuery({ queryKey: ["keyword-rep-usage"], queryFn: () => apiGet<RepWordUse[]>("/keywords/rep-usage") });
  const tiles = useMemo(() => data?.[0]?.tiles.map((t) => ({ id: t.keyword_id, name: t.keyword })) ?? [], [data]);
  const find = (rx: RegExp) => tiles.find((t) => rx.test(t.name))?.id;
  const [a, setA] = useState<string | null>(null);
  const [b, setB] = useState<string | null>(null);
  const left = a ?? find(/warrant/i) ?? tiles[0]?.id ?? "";
  const right = b ?? find(/^pric/i) ?? find(/pric/i) ?? tiles.find((t) => t.id !== left)?.id ?? "";
  const name = (id: string) => tiles.find((t) => t.id === id)?.name ?? "";
  const reps = (data ?? []).filter((r) => r.total_calls > 0);
  const max = Math.max(1, ...reps.flatMap((r) => r.tiles.filter((t) => t.keyword_id === left || t.keyword_id === right).map((t) => t.pct)));

  const picker = (value: string, set: (v: string) => void, testId: string, tone: string) => (
    <Select value={value} onValueChange={set}>
      <SelectTrigger size="sm" data-testid={testId} className={`w-48 ${tone}`}>
        <SelectValue>{(v) => name(v as string)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {tiles.map((t) => (
          <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  if (!tiles.length) return null;
  return (
    <Panel className="mt-6" testId="rep-word-use-panel">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Overline>Rep word use</Overline>
          <p className="mt-1 text-xs text-slate-500">Share of each rep's calls that mention each word — spot who sells value and who sells on price.</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-500">
          {picker(left, setA, "rep-word-use-left", "text-emerald-300")}
          <span>vs</span>
          {picker(right, setB, "rep-word-use-right", "text-amber-300")}
        </div>
      </div>
      <div className="mt-5 space-y-4">
        {reps.map((r) => {
          const l = r.tiles.find((t) => t.keyword_id === left);
          const rt = r.tiles.find((t) => t.keyword_id === right);
          const lp = l?.pct ?? 0;
          const rp = rt?.pct ?? 0;
          const lean = lp === rp ? "Even" : lp > rp ? `Leans ${name(left)}` : `Leans ${name(right)}`;
          return (
            <div key={r.rep_id} data-testid={`rep-word-use-row-${r.rep_id}`} className="grid grid-cols-[140px_1fr_auto] items-center gap-4">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-white">{r.rep_name}</p>
                <p className="text-[11px] text-slate-500">{r.total_calls} calls</p>
              </div>
              <div className="space-y-1.5">
                {[
                  { p: lp, n: l?.calls ?? 0, c: "bg-emerald-500/70", k: "left" },
                  { p: rp, n: rt?.calls ?? 0, c: "bg-amber-400/70", k: "right" },
                ].map((x) => (
                  <div key={x.k} className="flex items-center gap-2">
                    <div className="h-2 flex-1 rounded-full bg-slate-800">
                      <div className={`h-full rounded-full ${x.c} transition-[width] duration-500`} style={{ width: `${(x.p / max) * 100}%` }} />
                    </div>
                    <span data-testid={`rep-word-use-${x.k}-pct-${r.rep_id}`} className="w-24 text-right font-mono text-[11px] text-slate-400">
                      {x.p}% · {x.n}
                    </span>
                  </div>
                ))}
              </div>
              <span data-testid={`rep-word-use-lean-${r.rep_id}`} className={`w-36 text-right font-mono text-[10px] uppercase tracking-wider ${lp > rp ? "text-emerald-300" : lp < rp ? "text-amber-300" : "text-slate-500"}`}>
                {lean}
              </span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
