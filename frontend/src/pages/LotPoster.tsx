import { useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Award, Crown, HeartHandshake, ListChecks, MapPin, Printer, Tag, Trophy, Truck } from "lucide-react";
import { useChampions } from "@/components/ChampionBadges";
import { useSites } from "@/components/Sites";
import { MONTH_LONG } from "@/components/CallsDrill";
import { apiGet } from "@/lib/api";
import type { Branding, ChampionCategory } from "@/lib/types";

const CAT: Record<ChampionCategory, { label: string; icon: typeof Trophy; color: string }> = {
  vehicle_sales: { label: "Vehicle Sales", icon: Trophy, color: "#f59e0b" },
  callback_lists: { label: "Callback Lists", icon: ListChecks, color: "#0ea5e9" },
  winback_dollars: { label: "Win-Back $", icon: Crown, color: "#10b981" },
  winback_customers: { label: "Win-Back Customers", icon: Award, color: "#34d399" },
  tagging: { label: "Top Tagger", icon: Tag, color: "#a78bfa" },
  delivery_score: { label: "Delivery Checklist", icon: Truck, color: "#38bdf8" },
  team_player: { label: "Team Player", icon: HeartHandshake, color: "#fb7185" },
  top_location: { label: "Top Location", icon: MapPin, color: "#38bdf8" },
};

/** /poster/lot/:siteId[?month=YYYY-MM] — one lot's champions for a finished month, printable for that lot's break room. */
export default function LotPoster() {
  const { siteId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const champs = useChampions(siteId);
  const sites = useSites();
  const brand = useQuery({ queryKey: ["branding"], queryFn: () => apiGet<Branding>("/branding") });
  const all = champs.data?.champions ?? [];
  const months = [...new Set(all.map((c) => c.period.slice(0, 7)))].sort().reverse(); // tagging weeks count toward the month they start in
  const month = params.get("month") || months[0] || "";
  const winners = all.filter((c) => (c.category === "tagging" ? c.period.startsWith(month) : c.period === month));
  const lotName = sites.data?.sites.find((s) => s.id === siteId)?.name ?? "";
  if (champs.isLoading || sites.isLoading) return <div className="grid min-h-screen place-items-center bg-white text-slate-500">Loading…</div>;
  if (champs.isError || !lotName) return <div data-testid="lot-poster-missing" className="grid min-h-screen place-items-center bg-white text-slate-500">This location doesn't exist anymore.</div>;
  return (
    <div className="min-h-screen bg-neutral-200 py-8 print:bg-white print:py-0" data-testid="lot-poster">
      <style>{"@page { size: letter portrait; margin: 0 } @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact } }"}</style>
      <div className="mx-auto mb-4 flex max-w-[8.5in] items-center justify-end gap-3 print:hidden">
        {months.length > 1 && (
          <select data-testid="lot-poster-month" value={month} onChange={(e) => setParams({ month: e.target.value }, { replace: true })} style={{ color: "#171717", background: "#fff" }} className="h-9 rounded-md border border-neutral-400 px-2 text-sm">
            {months.map((m) => <option key={m} value={m}>{MONTH_LONG(m)}</option>)}
          </select>
        )}
        <button type="button" data-testid="lot-poster-print" onClick={() => window.print()} style={{ color: "#fff", background: "#171717" }} className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm transition-transform duration-150 hover:-translate-y-0.5">
          <Printer className="size-4" /> Print poster
        </button>
      </div>
      <article style={{ color: "#fff", background: "#0a0a0a" }} className="relative mx-auto flex h-[11in] w-[8.5in] flex-col overflow-hidden shadow-2xl print:shadow-none">
        <div className="absolute -left-24 -top-24 size-96 rounded-full bg-sky-500/25 blur-3xl" />
        <div className="absolute -bottom-32 -right-20 size-[28rem] rounded-full bg-amber-500/20 blur-3xl" />
        <header className="relative flex items-center gap-3 px-12 pt-12">
          {brand.data?.logo_url ? <img src={brand.data.logo_url} alt="" className="h-12 w-auto rounded" /> : <Trophy className="size-10 text-amber-400" />}
          <span className="font-mono text-sm uppercase tracking-[0.3em] text-neutral-400">{brand.data?.yard_name || "Salvage Pulse"}</span>
        </header>
        <div className="relative px-12 pt-14">
          <p className="flex items-center gap-2 font-mono text-lg uppercase tracking-[0.4em] text-sky-300"><MapPin className="size-5" /> Lot champions</p>
          <h1 data-testid="lot-poster-name" className="mt-4 font-heading text-[5rem] font-black uppercase leading-[0.9] tracking-tight">{lotName}</h1>
          <p data-testid="lot-poster-month-label" className="mt-4 text-3xl font-bold uppercase text-amber-400">{month ? MONTH_LONG(month) : "No finished month yet"}</p>
        </div>
        <div className="relative mt-10 grid grid-cols-2 gap-4 px-12">
          {winners.map((c) => {
            const m = CAT[c.category];
            const Icon = m.icon;
            return (
              <div key={`${c.category}-${c.period}`} data-testid={`lot-poster-${c.category}`} className="flex items-start gap-4 rounded-2xl border-2 p-4" style={{ borderColor: m.color }}>
                <Icon className="mt-1 size-10 shrink-0" style={{ color: m.color }} />
                <div className="min-w-0">
                  <p className="font-mono text-xs uppercase tracking-widest" style={{ color: m.color }}>{m.label}{c.category === "tagging" ? ` · wk of ${c.period.slice(5)}` : ""}</p>
                  <p className="mt-1 text-2xl font-black uppercase leading-tight">{c.names.join(" & ")}</p>
                  <p className="mt-1 text-sm text-neutral-400">{c.detail}</p>
                </div>
              </div>
            );
          })}
          {!winners.length && <p data-testid="lot-poster-empty" className="col-span-2 text-2xl text-neutral-400">No champions at this lot yet — the first trophies go out when a month ends.</p>}
        </div>
        <footer className="relative mt-auto flex items-center justify-between border-t border-neutral-800 px-12 py-5 font-mono text-xs uppercase tracking-widest text-neutral-500">
          <span>Printed {new Date().toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}</span>
          <span>Salvage Pulse AI</span>
        </footer>
      </article>
    </div>
  );
}
