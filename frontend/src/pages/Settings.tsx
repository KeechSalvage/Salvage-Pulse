import { Navigate, NavLink, useLocation, useParams } from "react-router-dom";
import { CreditCard, MonitorSmartphone, Palette, Plug, SlidersHorizontal, Smartphone, Upload } from "lucide-react";
import MyDevices from "@/components/MyDevices";
import { MobileCard } from "@/components/RepExtras";
import UploadCall from "@/pages/UploadCall";
import Connectors from "@/pages/Connectors";
import Billing from "@/pages/Billing";
import Appearance from "@/pages/Appearance";
import ScoringSettings from "@/pages/ScoringSettings";
import { cn } from "@/lib/utils";
import { useMe } from "@/lib/hooks";
import { APP_VERSION, APP_STAGE, IS_BETA } from "@/lib/version";

function PhoneAndTexts() {
  return (
    <div className="max-w-3xl">
      <h2 className="mb-1 font-heading text-2xl font-bold text-white">Phone &amp; texts</h2>
      <p className="mb-4 text-sm text-slate-400">Your mobile number for callback, cover-swap and coaching texts — and the days they pause (regular days off and vacation).</p>
      <MobileCard />
    </div>
  );
}

const TABS = [
  { id: "upload", label: "Upload Call", icon: Upload, page: UploadCall, roles: ["owner", "sales_manager", "inventory_manager", "rep", "manager", "sales_rep"] },
  { id: "scoring", label: "Call Scoring", icon: SlidersHorizontal, page: ScoringSettings, roles: ["owner", "sales_manager", "manager"] },
  { id: "phone", label: "Phone & texts", icon: Smartphone, page: PhoneAndTexts, roles: ["rep", "sales_rep"] },
  { id: "connectors", label: "Phone Connectors", icon: Plug, page: Connectors, roles: ["owner", "sales_manager", "manager"] },
  { id: "billing", label: "Billing", icon: CreditCard, page: Billing, roles: ["owner", "manager"] },
  { id: "appearance", label: "Appearance", icon: Palette, page: Appearance, roles: ["owner", "sales_manager", "manager"] },
  { id: "devices", label: "Devices", icon: MonitorSmartphone, page: MyDevices, roles: ["owner", "sales_manager", "inventory_manager", "manager"] },
] as const;

/** Settings (/settings/:tab). Managers: Upload Call, Phone Connectors, Billing, Appearance, Devices. Reps: Upload Call, Phone & texts. */
export default function Settings() {
  const { tab = "" } = useParams();
  const { search } = useLocation();
  const { data: me } = useMe();
  if (!me) return null;
  const tabs = TABS.filter((t) => (t.roles as readonly string[]).includes(me.role));
  const cur = tabs.find((t) => t.id === tab);
  if (!cur) return <Navigate to={`/settings/${tabs[0]?.id ?? "upload"}${search}`} replace />;
  const Page = cur.page;
  return (
    <div data-testid="settings-page">
      <nav className="mb-6 flex flex-wrap gap-1 rounded-xl border border-border bg-card/60 p-1 backdrop-blur" aria-label="Settings sections">
        {tabs.map((t) => (
          <NavLink key={t.id} to={`/settings/${t.id}`} data-testid={`settings-tab-${t.id}`}
            id={`settings-${t.id}`}
            className={({ isActive }) => cn("flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors duration-150 scroll-mt-6",
              isActive ? "bg-sidebar-accent text-white shadow-[inset_0_-2px_0_var(--color-amber-500)]" : "text-slate-400 hover:bg-sidebar-accent/60 hover:text-white")}>
            <t.icon className="size-4" /> {t.label}
          </NavLink>
        ))}
        <div className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-500">
          <span>Salvage Pulse</span>
          {IS_BETA && (
            <span className="rounded bg-amber-500/15 px-1 py-0.2 font-mono text-[9px] font-semibold uppercase text-amber-400 ring-1 ring-amber-500/30">
              {APP_STAGE}
            </span>
          )}
          <span className="font-mono text-slate-400">v{APP_VERSION}</span>
        </div>
      </nav>
      <Page />
    </div>
  );
}

/** /billing: managers land on the Settings tab (keeps Stripe return links working); reps of a lapsed yard still see Billing. */
export function BillingRoute() {
  const { data: me } = useMe();
  if (!me) return null;
  return (me.role === "owner" || me.role === "manager") ? <ToSettings tab="billing" /> : <Billing />;
}

/** Old /billing, /connectors, /appearance links (Stripe returns, emails) land on the matching Settings tab. */
export function ToSettings({ tab }: { tab: string }) {
  const { search } = useLocation();
  return <Navigate to={`/settings/${tab}${search}`} replace />;
}
