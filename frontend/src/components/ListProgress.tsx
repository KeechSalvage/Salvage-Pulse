import { Link } from "react-router-dom";
import { ListChecks } from "lucide-react";
import { Overline, Panel, fmtMoney } from "@/components/common";
import { useCallbackLists } from "@/components/AddToCallbacks";

/** Reps page: every callback list's progress and what it sold, best payoff first. */
export default function ListProgress() {
  const { data } = useCallbackLists();
  const lists = [...(data ?? [])].sort((a, b) => b.revenue - a.revenue || b.sold - a.sold);
  return (
    <Panel testId="list-progress-panel">
      <div className="flex items-center gap-2">
        <ListChecks className="size-4 text-sky-300" />
        <Overline>Callback lists</Overline>
      </div>
      <h3 className="mb-1 mt-1 text-xl font-bold text-white">Which lists pay off</h3>
      <p className="mb-4 text-xs text-slate-500">Called back vs. still open, and sales from list customers after they were added (the callback itself or any later order).</p>
      {!lists.length ? (
        <p className="text-sm text-slate-500" data-testid="list-progress-empty">No callback lists yet — make one from the Callbacks page, the Call Library, or a new vehicle arrival.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="font-mono text-[11px] uppercase tracking-wider text-slate-500">
              <tr>{["List", "Rep", "Progress", "Sold", "Sales", "Created"].map((h) => <th key={h} className="py-2 pr-4 text-left font-normal">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-border">
              {lists.map((l) => {
                const pct = l.total ? Math.round((100 * l.done) / l.total) : 0;
                return (
                  <tr key={l.id} data-testid={`list-progress-${l.id}`}>
                    <td className="py-2.5 pr-4">
                      <Link to="/callbacks" className="text-white hover:underline">{l.name}</Link>
                      {l.arrival_id && <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] uppercase text-amber-300">arrival</span>}
                    </td>
                    <td className="pr-4 text-slate-300">{l.rep_name}</td>
                    <td className="min-w-44 pr-4">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 flex-1 rounded-full bg-slate-800">
                          <div className="h-full rounded-full bg-sky-500 transition-[width] duration-500" style={{ width: `${pct}%` }} />
                        </div>
                        <span data-testid={`list-progress-done-${l.id}`} className="font-mono text-xs text-slate-400">{l.done}/{l.total}</span>
                      </div>
                    </td>
                    <td data-testid={`list-progress-sold-${l.id}`} className="pr-4 font-mono text-emerald-300">{l.sold}{l.total ? <span className="text-slate-500"> · {Math.round((100 * l.sold) / l.total)}%</span> : null}</td>
                    <td data-testid={`list-progress-revenue-${l.id}`} className="pr-4 font-mono">{fmtMoney(l.revenue)}</td>
                    <td className="pr-4 font-mono text-xs text-slate-500">{l.created_at ? new Date(l.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : ""} · {l.created_by}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
