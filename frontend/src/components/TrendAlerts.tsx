import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { TrendingUp } from "lucide-react";
import { apiGet } from "@/lib/api";
import type { TrendAlert } from "@/lib/types";

const cap = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** Dashboard banner: topics whose pace this month is well above the last 3 months — stock up ahead. */
export default function TrendAlerts() {
  const { data } = useQuery({ queryKey: ["keyword-alerts"], queryFn: () => apiGet<TrendAlert[]>("/keywords/alerts") });
  if (!data?.length) return null;
  return (
    <div className="mb-6 grid gap-3 md:grid-cols-2 xl:grid-cols-4" data-testid="trend-alerts">
      {data.map((a, i) => (
        <Link
          key={a.phrase}
          to="/keywords"
          data-testid={`trend-alert-${i}`}
          className="group flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 backdrop-blur transition-[border-color,transform] duration-150 hover:-translate-y-0.5 hover:border-amber-400"
        >
          <TrendingUp className="mt-0.5 size-5 shrink-0 text-amber-300" />
          <div className="min-w-0">
            <p className="font-medium text-white">
              {cap(a.phrase)} is jumping <span className="font-mono text-amber-300">×{a.ratio}</span>
            </p>
            <p className="mt-0.5 text-xs text-slate-400">
              {a.this_month} calls so far this month (on pace for {a.projected}) vs about {a.baseline}/month before. Stock up ahead.
            </p>
            {!a.keyword_id && <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-slate-500">Not tracked yet — add it as a tile</p>}
          </div>
        </Link>
      ))}
    </div>
  );
}
