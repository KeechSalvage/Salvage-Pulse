import { useState } from "react";
import { Link } from "react-router-dom";
import TileGrid from "@/components/TileGrid";
import { CarFront } from "lucide-react";
import { PageHeader } from "@/components/common";
import VehicleRankToggle from "@/components/VehicleRankToggle";
import PremiumGate from "@/components/PremiumGate";
import StockAlerts from "@/components/StockAlerts";
import TruckArrivals from "@/components/TruckArrivals";
import TruckLeaderboard from "@/components/TruckLeaderboard";
import VehicleDemandPanel from "@/components/VehicleDemand";
import WatchlistPanel from "@/components/Watchlist";
import { useMe } from "@/lib/hooks";
import type { VehicleRank } from "@/lib/types";
import { isManagerLike } from "@/lib/types";

/** Vehicles tab: vehicle arrivals for everyone; demand, didn't-buy, stock alerts and the watchlist for managers. */
export default function Vehicles() {
  const { data: me } = useMe();
  const isManager = isManagerLike(me?.role);
  const [rank, setRank] = useState<VehicleRank>("calls");
  return (
    <>
      <PageHeader overline="Yard inventory" title={isManager ? "Vehicles & inventory" : "Vehicle arrivals"}>
        <Link to="/tag-vehicles" data-testid="vehicles-tag-link" className="flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm text-slate-200 transition-colors duration-150 hover:border-amber-500/60 hover:text-white">
          <CarFront className="size-4 text-amber-300" /> Tag calls with no vehicle
        </Link>
      </PageHeader>
      {isManager && <VehicleRankToggle value={rank} onChange={setRank} />}
      <TileGrid
        page="vehicles"
        label="sections"
        className="grid grid-cols-1 gap-6 xl:grid-cols-12"
        tiles={[
          ...(isManager ? [{ id: "stock-alerts", label: "Stock alerts", span: "xl:col-span-12", node: <PremiumGate feature="trend_alerts" hidden><StockAlerts rank={rank} /></PremiumGate> }] : []),
          { id: "truck-leaderboard", label: "Vehicle-sales leaderboard", span: "xl:col-span-12", node: <PremiumGate feature="leaderboards" hidden><TruckLeaderboard /></PremiumGate> },
          { id: "arrivals", label: "Vehicle arrivals", span: "xl:col-span-12", node: <PremiumGate feature="vehicle_arrivals"><TruckArrivals isManager={isManager} rank={rank} /></PremiumGate> },
          ...(isManager
            ? [
                { id: "vehicle-demand", label: "Vehicle demand", span: "xl:col-span-12", node: <PremiumGate feature="inventory_insights"><VehicleDemandPanel rank={rank} /></PremiumGate> },
                { id: "watchlist", label: "Watchlist", span: "xl:col-span-12", node: <PremiumGate feature="inventory_insights" hidden><WatchlistPanel rank={rank} /></PremiumGate> },
              ]
            : []),
        ]}
      />
    </>
  );
}
