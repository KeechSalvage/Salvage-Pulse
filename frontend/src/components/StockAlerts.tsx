import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { PackageSearch } from "lucide-react";
import { apiGet } from "@/lib/api";
import type { StockAlert, VehicleRank } from "@/lib/types";

const plural = (p: string) => (/s$/i.test(p) ? p : `${p}s`);

/** Dashboard: vehicle + part combos callers suddenly want this month — pull them before the rush. */
export default function StockAlerts({ rank = "calls" }: { rank?: VehicleRank }) {
  const { data } = useQuery({ queryKey: ["stock-alerts", rank], queryFn: () => apiGet<StockAlert[]>(`/analytics/stock-alerts?rank=${rank}`) });
  if (!data?.length) return null;
  return (
    <div data-testid="stock-alerts">
      <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.2em] text-emerald-300">Pull early · stock alerts</p>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {data.map((a, i) => {
          const q = new URLSearchParams({ vehicle_make: a.make, vehicle_model: a.model });
          return (
            <Link
              key={`${a.make}-${a.model}-${a.part}`}
              to={`/calls?${q.toString()}`}
              data-testid={`stock-alert-${i}`}
              className="flex items-start gap-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-4 backdrop-blur transition-[border-color,transform] duration-150 hover:-translate-y-0.5 hover:border-emerald-400"
            >
              <PackageSearch className="mt-0.5 size-5 shrink-0 text-emerald-300" />
              <div className="min-w-0">
                <p className="font-medium text-white">
                  {a.years} {a.make} {a.model} {plural(a.part).toLowerCase()} <span className="font-mono text-emerald-300">×{a.ratio}</span>
                </p>
                <p className="mt-0.5 text-xs text-slate-400">
                  {a.this_month} calls so far this month (on pace for {a.projected}) vs about {a.baseline}/month before. Pull them before the rush.
                </p>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
