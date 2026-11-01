import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Bot, ListChecks, PhoneCall, PhoneMissed, Truck } from "lucide-react";
import { Overline, Panel } from "@/components/common";
import { apiGet } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { CallQueue as Queue, QueueItem } from "@/lib/types";

const KIND: Record<QueueItem["kind"], { icon: typeof Truck; label: string; tone: string }> = {
  arrival: { icon: Truck, label: "Vehicle in", tone: "text-amber-300" },
  missed: { icon: PhoneMissed, label: "Missed caller", tone: "text-red-300" },
  roleplay: { icon: Bot, label: "Role-play", tone: "text-sky-300" },
};
const fmtPhone = (p: string) => {
  const d = p.replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p;
};

/** Rep dashboard: one morning list — vehicle-arrival callers, missed callers and assigned role-plays (urgent first). */
export default function CallQueue() {
  const { data } = useQuery({ queryKey: ["queue"], queryFn: () => apiGet<Queue>("/queue") });
  const [all, setAll] = useState(false);
  if (!data) return null;
  const rawItems = data.items ?? [];
  const items = all ? rawItems : rawItems.slice(0, 8);
  const counts = data.counts ?? { arrival: 0, missed: 0, roleplay: 0 };
  return (
    <Panel className="mb-6" testId="call-queue-panel">
      <div className="flex flex-wrap items-center gap-3">
        <ListChecks className="size-5 text-amber-300" />
        <div className="mr-auto">
          <Overline>Today's call queue</Overline>
          <p className="text-xs text-slate-500">Work top to bottom — urgent items first.</p>
        </div>
        <div className="flex gap-3 font-mono text-xs text-slate-400" data-testid="call-queue-counts">
          <span><b className="text-amber-300">{counts.arrival ?? 0}</b> vehicle callers</span>
          <span><b className="text-red-300">{counts.missed ?? 0}</b> missed</span>
          <span><b className="text-sky-300">{counts.roleplay ?? 0}</b> role-plays</span>
        </div>
      </div>
      {data.progress?.behind && (
        <div data-testid="queue-behind-nudge" className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          Afternoon check-in: you're {data.progress.pct}% through today's list with {data.progress.remaining} to go. A few quick calls now keeps your vehicles moving — start with the ones marked urgent.
        </div>
      )}
      {data.progress && (
        <div className="mt-4" data-testid="call-queue-progress">
          <div className="flex justify-between font-mono text-[11px] text-slate-400">
            <span>
              Cleared today <b className="text-white">{data.progress.cleared_today}</b> · {data.progress.remaining} to go
            </span>
            <span className="text-emerald-300">{data.progress.pct}%</span>
          </div>
          <div className="mt-1 h-2 rounded-full bg-slate-800">
            <div className="h-full rounded-full bg-emerald-500/80 transition-[width] duration-500" style={{ width: `${data.progress.pct}%` }} />
          </div>
        </div>
      )}
      {rawItems.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500" data-testid="call-queue-empty">All clear — nothing waiting for you.</p>
      ) : (
        <ul className="mt-4 divide-y divide-border">
          {items.map((i) => {
            const k = KIND[i.kind];
            return (
              <li key={`${i.kind}-${i.id}`} data-testid={`queue-item-${i.kind}-${i.id}`} className="flex flex-wrap items-center gap-3 py-2.5">
                <k.icon className={cn("size-4 shrink-0", k.tone)} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-white">
                    {i.title}
                    {i.urgent && <span className="ml-2 rounded bg-red-500/15 px-1.5 py-0.5 font-mono text-[10px] uppercase text-red-300">{i.kind === "roleplay" ? "overdue" : i.kind === "arrival" ? "same year" : "new"}</span>}
                  </p>
                  <p className="truncate text-xs text-slate-500">{k.label} · {i.detail}</p>
                </div>
                {i.phone && (
                  <a href={`tel:${i.phone}`} data-testid={`queue-call-${i.id}`} className="flex items-center gap-1 rounded-md border border-sky-500/40 px-2 py-1 font-mono text-xs text-sky-300 transition-colors duration-150 hover:bg-sky-500/10">
                    <PhoneCall className="size-3" /> {fmtPhone(i.phone)}
                  </a>
                )}
                <Link to={i.link} data-testid={`queue-open-${i.id}`} className="rounded-md border border-border px-2 py-1 text-xs text-slate-300 transition-colors duration-150 hover:border-amber-500/50 hover:text-white">
                  {i.kind === "roleplay" ? "Practise" : i.kind === "arrival" ? "Mark result" : "Open"}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {rawItems.length > 8 && (
        <button data-testid="call-queue-toggle" onClick={() => setAll(!all)} className="mt-2 text-xs text-amber-300 hover:underline">
          {all ? "Show fewer" : `Show all ${rawItems.length}`}
        </button>
      )}
    </Panel>
  );
}
