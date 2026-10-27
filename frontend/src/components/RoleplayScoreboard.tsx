import { useQuery } from "@tanstack/react-query";
import { Overline, Panel, scoreTier } from "@/components/common";
import { apiGet } from "@/lib/api";
import type { RoleplayScoreboard } from "@/lib/types";

export default function RoleplayScoreboardPanel() {
  const { data, isError } = useQuery({ queryKey: ["roleplay-scoreboard"], queryFn: () => apiGet<RoleplayScoreboard>("/roleplay/scoreboard") });
  return (
    <Panel testId="roleplay-scoreboard-panel">
      <Overline>Role-play scores</Overline>
      <h3 className="mt-1 text-xl font-bold text-white">Best grade per scenario</h3>
      <p className="mt-1 text-sm text-slate-400">Price-objection scenarios are marked with $. Empty cells mean the rep hasn't practised it yet.</p>
      {isError && <p className="mt-4 text-sm text-slate-500">Scores unavailable.</p>}
      {data && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm" data-testid="roleplay-scoreboard-table">
            <thead>
              <tr className="font-mono text-[10px] uppercase tracking-wider text-slate-500">
                <th className="py-2 pr-3 text-left font-normal">Rep</th>
                {(data.scenarios ?? []).map((s) => (
                  <th key={s.id} className="max-w-[120px] px-2 py-2 text-center font-normal" title={s.title}>
                    {s.price_objection && <span className="text-amber-300">$ </span>}
                    {s.title}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {(data.rows ?? []).map((r, i) => (
                <tr key={r.rep_id} data-testid={`scoreboard-row-${i}`}>
                  <td className="py-2.5 pr-3 font-medium text-white">{r.rep_name}</td>
                  {(data.scenarios ?? []).map((s) => {
                    const sc = r.scores?.[s.id];
                    return (
                      <td key={s.id} className="px-2 text-center">
                        {sc ? (
                          <span className="font-mono text-sm font-bold" style={{ color: scoreTier(sc.best).color }} title={`${sc.attempts} attempts`}>
                            {sc.best}
                            <span className="ml-1 text-[10px] font-normal text-slate-500">×{sc.attempts}</span>
                          </span>
                        ) : (
                          <span className="text-slate-700">—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
