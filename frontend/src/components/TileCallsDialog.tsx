import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CategoryBadge, ScoreBadge } from "@/components/common";
import { apiGet } from "@/lib/api";
import type { CallSummary } from "@/lib/types";

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export interface TilePick {
  id: string;
  keyword: string;
  month: string; // YYYY-MM
}

export default function TileCallsDialog({ pick, onClose }: { pick: TilePick | null; onClose: () => void }) {
  const calls = useQuery({
    queryKey: ["keyword-calls", pick?.id, pick?.month],
    queryFn: () => apiGet<CallSummary[]>(`/keywords/${pick!.id}/calls?month=${pick!.month}`),
    enabled: !!pick,
  });
  const label = pick ? `${MONTH_NAMES[Number(pick.month.slice(5)) - 1]} ${pick.month.slice(0, 4)}` : "";
  return (
    <Dialog open={!!pick} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl" data-testid="tile-calls-dialog">
        <DialogHeader>
          <DialogTitle className="font-mono text-emerald-300">{pick?.keyword}</DialogTitle>
          <DialogDescription data-testid="tile-calls-count">
            {calls.data ? `${calls.data.length} calls mentioned it in ${label}` : `Calls in ${label}`}
          </DialogDescription>
        </DialogHeader>
        {calls.isLoading && <p className="text-sm text-slate-500">Loading calls…</p>}
        {calls.data?.length === 0 && <p className="text-sm text-slate-500" data-testid="tile-calls-empty">No calls mentioned it that month.</p>}
        <ul className="divide-y divide-border">
          {(calls.data ?? []).map((c) => (
            <li key={c.id}>
              <Link
                to={`/calls/${c.id}`}
                onClick={onClose}
                data-testid={`tile-call-${c.id}`}
                className="flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors duration-150 hover:bg-slate-800/60"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-white">{c.customer_name}</p>
                  <p className="truncate text-xs text-slate-500">
                    {new Date(c.created_at).toLocaleDateString()} · {c.rep_name} {c.topics.length ? `· ${c.topics.slice(0, 2).join(", ")}` : ""}
                  </p>
                </div>
                <CategoryBadge category={c.category} />
                <ScoreBadge score={c.overall_score} />
              </Link>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
