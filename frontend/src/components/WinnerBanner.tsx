import { useQuery } from "@tanstack/react-query";
import { Trophy } from "lucide-react";
import { fmtMoney } from "@/components/common";
import { Avatar } from "@/components/AppShell";
import { apiGet } from "@/lib/api";
import { lotQS } from "@/lib/lot";
import { useMe } from "@/lib/hooks";
import type { WinBackLeader, WinBackWinners } from "@/lib/types";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function Award({ title, l, stat, testId, mine }: { title: string; l: WinBackLeader; stat: string; testId: string; mine: boolean }) {
  return (
    <div data-testid={testId} className="flex items-center gap-3 rounded-lg border border-amber-500/30 bg-surface/70 px-4 py-2.5">
      <Trophy className="size-5 shrink-0 text-amber-400 drop-shadow-[0_0_6px_rgba(245,158,11,0.6)]" />
      <Avatar name={l.rep_name} size={30} />
      <div className="min-w-0">
        <p className="font-mono text-[10px] uppercase tracking-wider text-amber-300/80">{title}</p>
        <p className="truncate text-sm font-semibold text-white">
          {l.rep_name}
          {mine && <span className="ml-1.5 font-mono text-[10px] uppercase text-amber-300">you!</span>}
          <span className="ml-2 font-mono text-xs font-normal text-emerald-300">{stat}</span>
        </p>
      </div>
    </div>
  );
}

/** Last calendar month's win-back champions (most confirmed dollars, most confirmed customers). Hidden until someone wins. */
export default function WinnerBanner({ testId = "winner-banner", lot = "" }: { testId?: string; lot?: string }) {
  const { data: me } = useMe();
  const { data } = useQuery({ queryKey: ["winback-winners", lot], queryFn: () => apiGet<WinBackWinners>(`/analytics/winback/winners${lotQS(lot)}`) });
  if (!data?.top_dollars) return null;
  const label = `${MONTHS[Number(data.month.slice(5, 7)) - 1]} ${data.month.slice(0, 4)}`;
  return (
    <div
      data-testid={testId}
      className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/40 bg-gradient-to-r from-amber-500/[0.12] via-amber-500/[0.04] to-transparent px-5 py-3.5"
    >
      <div className="mr-2">
        <p className="font-mono text-[11px] uppercase tracking-wider text-amber-300">Win-back champions</p>
        <p data-testid={`${testId}-month`} className="font-heading text-lg font-bold text-white">
          {label}
        </p>
      </div>
      <Award title="Most won back" l={data.top_dollars} stat={fmtMoney(data.top_dollars.won_value)} testId={`${testId}-dollars`} mine={data.top_dollars.rep_id === me?.id} />
      {data.top_customers && (
        <Award
          title="Most customers"
          l={data.top_customers}
          stat={`${data.top_customers.customers_won} customers`}
          testId={`${testId}-customers`}
          mine={data.top_customers.rep_id === me?.id}
        />
      )}
    </div>
  );
}
