import { Link } from "react-router-dom";
import { ArrowRight, CarFront, Wrench } from "lucide-react";
import type { VehicleImportSummary } from "@/lib/types";

/** After a call-log upload: how many calls matched to vehicles (and parts), top makes, and a jump to tag the rest. */
export default function ImportVehicleSummary({ v, total }: { v: VehicleImportSummary; total: number }) {
  return (
    <div data-testid="import-vehicle-summary" className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
      <p className="flex items-center gap-2 font-heading text-base font-semibold text-white">
        <CarFront className="size-5 text-amber-300" />
        <span data-testid="import-vehicles-matched">
          {v.matched} of {total} calls matched to vehicles
        </span>
      </p>
      <p className="mt-1 text-sm text-slate-400">
        {v.newly_matched > 0 ? `${v.newly_matched} read from RingCentral topics on this upload. ` : ""}
        <span data-testid="import-parts-matched"><Wrench className="mr-1 inline size-3.5" />{v.with_part} name the part they need.</span>
      </p>
      {v.top_makes.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2" data-testid="import-top-makes">
          {v.top_makes.map((m) => (
            <span key={m.make} className="rounded-full bg-surface-2 px-3 py-1 font-mono text-xs text-slate-200">
              {m.make} · {m.calls}
            </span>
          ))}
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-4 text-sm">
        <Link to="/vehicles" data-testid="import-view-vehicles" className="flex items-center gap-1 text-amber-300 hover:text-amber-200">
          See vehicle demand <ArrowRight className="size-4" />
        </Link>
        {v.untagged > 0 && (
          <Link to="/tag-vehicles" data-testid="import-tag-rest" className="flex items-center gap-1 text-slate-300 hover:text-white">
            Tag the {v.untagged} connected calls with no vehicle <ArrowRight className="size-4" />
          </Link>
        )}
      </div>
    </div>
  );
}
