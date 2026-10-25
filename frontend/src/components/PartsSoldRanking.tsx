import { useState } from "react";
import { Overline, Panel, fmtMoney } from "@/components/common";
import { MONTH_LONG, useDrill } from "@/components/CallsDrill";
import { cn } from "@/lib/utils";
import type { PartsSoldMonth } from "@/lib/types";

/** Reports: part types actually sold (from the sold tags), ranked per month. */
export default function PartsSoldRanking({ months }: { months: PartsSoldMonth[] }) {
  const drill = useDrill();
  const [pick, setPick] = useState(0);
  const m = months[Math.min(pick, months.length - 1)];
  const max = Math.max(1, ...(m?.parts ?? []).map((p) => p.sales));
  return (
    <Panel testId="report-parts-sold-panel">
      <Overline>Parts sold</Overline>
      <h3 className="mb-1 mt-1 text-xl font-bold text-white">What actually sold</h3>
      <p className="mb-4 text-xs text-slate-500">Ranked from the part types reps tag when they mark a sale (calls, callbacks and vehicle lists).</p>
      {!m ? (
        <p className="text-sm text-slate-500" data-testid="report-parts-sold-empty">No sales tagged with part types in this range yet. Pick parts in the sold box on any sale.</p>
      ) : (
        <>
          {months.length > 1 && (
            <div className="mb-4 flex flex-wrap gap-1.5">
              {months.map((x, i) => (
                <button key={x.month} type="button" data-testid={`report-parts-sold-month-${x.month}`} onClick={() => setPick(i)}
                  className={cn("rounded-full border px-3 py-1 text-xs transition-colors duration-150", i === pick ? "border-emerald-500 bg-emerald-500/15 text-white" : "border-border text-slate-400 hover:text-white")}>
                  {MONTH_LONG(x.month)}
                </button>
              ))}
            </div>
          )}
          <ol className="space-y-2" data-testid="report-parts-sold-list">
            {m.parts.map((p, i) => (
              <li key={p.part}>
                <button type="button" data-testid={`report-part-sold-${p.part.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
                  onClick={() => drill({ title: `${p.part} sales · ${MONTH_LONG(m.month)}`, subtitle: `${p.sales} sold · ${fmtMoney(p.revenue)}`, query: { month: m.month, part_sold: p.part, outcome: "won" } })}
                  className="block w-full rounded px-1 py-0.5 text-left transition-colors duration-150 hover:bg-slate-800/50">
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-200"><span className="mr-2 font-mono text-xs text-slate-500">{i + 1}</span>{p.part}</span>
                    <span className="font-mono text-xs text-slate-400">{p.sales} sold · {fmtMoney(p.revenue)}</span>
                  </div>
                  <div className="mt-1 h-1 rounded-full bg-slate-800">
                    <div className="h-full rounded-full bg-emerald-500/80 transition-[width] duration-500" style={{ width: `${(p.sales / max) * 100}%` }} />
                  </div>
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
    </Panel>
  );
}
