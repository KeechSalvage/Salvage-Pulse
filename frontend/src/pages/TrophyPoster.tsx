import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Award, Crown, HeartHandshake, ListChecks, MapPin, Printer, Tag, Trophy, Truck } from "lucide-react";
import { useChampions } from "@/components/ChampionBadges";
import { MONTH_LONG } from "@/components/CallsDrill";
import { apiGet } from "@/lib/api";
import type { Branding, ChampionCategory, User } from "@/lib/types";

const CAT: Record<ChampionCategory, { label: string; icon: typeof Trophy; color: string }> = {
  vehicle_sales: { label: "Vehicle Sales Champ", icon: Trophy, color: "#f59e0b" },
  callback_lists: { label: "Callback List Champ", icon: ListChecks, color: "#0ea5e9" },
  winback_dollars: { label: "Win-Back $ Champ", icon: Crown, color: "#10b981" },
  winback_customers: { label: "Win-Back Customers Champ", icon: Award, color: "#10b981" },
  tagging: { label: "Top Tagger", icon: Tag, color: "#8b5cf6" },
  delivery_score: { label: "Delivery Checklist Champ", icon: Truck, color: "#38bdf8" },
  team_player: { label: "Team Player Champ", icon: HeartHandshake, color: "#fb7185" },
  top_location: { label: "Top Location", icon: MapPin, color: "#38bdf8" },
};

/** Standalone printable break-room poster of one rep's trophies (opened in a new tab, prints on one page). */
export default function TrophyPoster() {
  const { repId = "", siteId = "" } = useParams(); // /poster/:repId or /poster/location/:siteId
  const champs = useChampions();
  const brand = useQuery({ queryKey: ["branding"], queryFn: () => apiGet<Branding>("/branding") });
  const reps = useQuery({ queryKey: ["users", "reps"], queryFn: () => apiGet<User[]>("/users/reps") });
  const mine = (champs.data?.champions ?? []).filter((c) => (siteId ? c.site_ids.includes(siteId) : c.rep_ids.includes(repId)));
  const name = (siteId ? mine[0]?.names[mine[0].site_ids.indexOf(siteId)] : (reps.data ?? []).find((r) => r.id === repId)?.name) ?? mine[0]?.names.find(Boolean) ?? "";
  const counts = new Map<ChampionCategory, number>();
  for (const c of mine) counts.set(c.category, (counts.get(c.category) ?? 0) + 1);
  if (champs.isLoading || reps.isLoading) return <div className="grid min-h-screen place-items-center bg-white text-slate-500">Loading…</div>;
  return (
    <div className="min-h-screen bg-neutral-200 py-8 print:bg-white print:py-0" data-testid="trophy-poster">
      <style>{"@page { size: letter portrait; margin: 0 } @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact } }"}</style>
      <div className="mx-auto mb-4 flex max-w-[8.5in] justify-end print:hidden">
        <button type="button" data-testid="trophy-poster-print" onClick={() => window.print()} style={{ color: "#fff", background: "#171717" }} className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm transition-transform duration-150 hover:-translate-y-0.5">
          <Printer className="size-4" /> Print poster
        </button>
      </div>
      <article style={{ color: "#fff", background: "#0a0a0a" }} className="relative mx-auto flex h-[11in] w-[8.5in] flex-col overflow-hidden shadow-2xl print:shadow-none">
        <div className="absolute -right-24 -top-24 size-96 rounded-full bg-amber-500/25 blur-3xl" />
        <div className="absolute -bottom-32 -left-20 size-[28rem] rounded-full bg-sky-500/15 blur-3xl" />
        <header className="relative flex items-center gap-3 px-12 pt-12">
          {brand.data?.logo_url ? <img src={brand.data.logo_url} alt="" className="h-12 w-auto rounded" /> : <Trophy className="size-10 text-amber-400" />}
          <span className="font-mono text-sm uppercase tracking-[0.3em] text-neutral-400">{brand.data?.yard_name || "Salvage Pulse"}</span>
        </header>
        <div className="relative px-12 pt-16">
          <p className="font-mono text-lg uppercase tracking-[0.4em] text-amber-400">{siteId ? "Top Location" : "Hall of Champions"}</p>
          <h1 data-testid="trophy-poster-name" className="mt-4 font-heading text-[5.5rem] font-black uppercase leading-[0.9] tracking-tight">{name || "Champion"}</h1>
          <div className="mt-8 flex items-baseline gap-4">
            <span data-testid="trophy-poster-total" className="font-heading text-[9rem] font-black leading-none text-amber-400">{mine.length}</span>
            <span className="text-3xl font-bold uppercase text-neutral-300">troph{mine.length === 1 ? "y" : "ies"}</span>
          </div>
        </div>
        <div className="relative mt-8 grid grid-cols-2 gap-4 px-12">
          {[...counts.entries()].map(([k, n]) => {
            const m = CAT[k];
            const Icon = m.icon;
            return (
              <div key={k} data-testid={`trophy-poster-${k}`} className="flex items-center gap-4 rounded-2xl border-2 p-4" style={{ borderColor: m.color }}>
                <Icon className="size-12 shrink-0" style={{ color: m.color }} />
                <div>
                  <p className="text-xl font-black uppercase leading-tight">{m.label}</p>
                  <p className="font-mono text-lg" style={{ color: m.color }}>×{n}</p>
                </div>
              </div>
            );
          })}
          {!mine.length && <p className="col-span-2 text-2xl text-neutral-400">The first trophy is coming — keep calling!</p>}
        </div>
        <ul className="relative mt-auto flex flex-wrap gap-x-6 gap-y-1 px-12 pb-6 font-mono text-xs text-neutral-400">
          {mine.slice(0, 14).map((c) => (
            <li key={`${c.category}-${c.period}`}>
              {CAT[c.category].label} · {c.category === "tagging" ? `wk of ${c.period.slice(5)}` : MONTH_LONG(c.period)}
            </li>
          ))}
        </ul>
        <footer className="relative flex items-center justify-between border-t border-neutral-800 px-12 py-5 font-mono text-xs uppercase tracking-widest text-neutral-500">
          <span>Printed {new Date().toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}</span>
          <span>Salvage Pulse AI</span>
        </footer>
      </article>
    </div>
  );
}
