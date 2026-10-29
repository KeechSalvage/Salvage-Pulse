import { useEffect, useState } from "react";
import { DrillProvider } from "@/components/CallsDrill";
import { NavLink, Navigate, Outlet, useLocation, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import PreviewEndingBanner from "@/components/PreviewEndingBanner";
import EnterpriseTour from "@/components/EnterpriseTour";
import DemoLimitDialog from "@/components/DemoLimitDialog";
import ThemeToggle from "@/components/ThemeToggle";
import { ContactUsButton } from "@/components/ContactUs";
import BrandLogo from "@/components/BrandLogo";
import AppFooter from "@/components/AppFooter";
import { useBranding } from "@/lib/branding";
import {
  BarChart3,
  Bot,
  Building2,
  CreditCard,
  Plug,
  Gauge,
  LogOut,
  PhoneIncoming,
  PhoneMissed,
  Tags,
  Users,
  Car,
  CarFront,
  FileBarChart, Trophy, CalendarDays,
  Truck,
  Palette,
  Settings,
  History,
  MessageSquare,
  Percent,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, errorMessage } from "@/lib/api";
import { useMe } from "@/lib/hooks";
import { ChangePasswordPanel } from "@/components/StaffSecurity";
import type { CallbackItem } from "@/lib/types";
import { endSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { useAssignments } from "@/components/AssignmentNudge";
import type { Branding, OrgInfo, ResendResult, Role, User } from "@/lib/types";
import { isManagerLike, roleLabel } from "@/lib/types";

const PLAN_NAMES: Record<string, string> = { starter: "Starter", pro: "Pro", pro_unlimited: "Pro Platinum", enterprise: "Enterprise", enterprise_platinum: "Enterprise Platinum" };

const yardManagerNav = [
  { to: "/dashboard", label: "Team Dashboard", icon: BarChart3, id: "dashboard" },
  { to: "/calls", label: "Call Library", icon: PhoneIncoming, id: "calls" },
  { to: "/callbacks", label: "Callbacks", icon: PhoneMissed, id: "callbacks" },
  { to: "/team", label: "Reps", icon: Users, id: "team" },
  { to: "/vehicles", label: "Vehicles", icon: Car, id: "vehicles" },
  { to: "/tag-vehicles", label: "Tag Vehicles", icon: CarFront, id: "tag-vehicles" },
  { to: "/reports", label: "Reports", icon: FileBarChart, id: "reports" },
  { to: "/leaderboards", label: "Leaderboards", icon: Trophy, id: "leaderboards" },
  { to: "/calendar", label: "Shift calendar", icon: CalendarDays, id: "calendar" },
  { to: "/keywords", label: "Keyword Tracker", icon: Tags, id: "keywords" },
  { to: "/roleplay", label: "Role-Play Trainer", icon: Bot, id: "roleplay" },
  { to: "/settings", label: "Settings", icon: Settings, id: "settings" },
];

const inventoryManagerNav = [
  { to: "/vehicles", label: "Vehicles & Stock", icon: Car, id: "vehicles" },
  { to: "/tag-vehicles", label: "Tag Vehicles", icon: CarFront, id: "tag-vehicles" },
  { to: "/dashboard", label: "Yard Dashboard", icon: BarChart3, id: "dashboard" },
  { to: "/calls", label: "Call Library", icon: PhoneIncoming, id: "calls" },
  { to: "/reports", label: "Reports", icon: FileBarChart, id: "reports" },
  { to: "/calendar", label: "Shift calendar", icon: CalendarDays, id: "calendar" },
  { to: "/settings", label: "Settings", icon: Settings, id: "settings" },
];

const repNav = [
  { to: "/me", label: "My Performance", icon: Gauge, id: "me" },
  { to: "/calls", label: "My Calls", icon: PhoneIncoming, id: "calls" },
  { to: "/callbacks", label: "Callbacks", icon: PhoneMissed, id: "callbacks" },
  { to: "/vehicles", label: "Vehicle Arrivals", icon: Truck, id: "vehicles" },
  { to: "/tag-vehicles", label: "Tag Vehicles", icon: CarFront, id: "tag-vehicles" },
  { to: "/reports", label: "Reports", icon: FileBarChart, id: "reports" },
  { to: "/leaderboards", label: "Leaderboards", icon: Trophy, id: "leaderboards" },
  { to: "/roleplay", label: "Role-Play Trainer", icon: Bot, id: "roleplay" },
  { to: "/settings", label: "Settings", icon: Settings, id: "settings" },
];

const adminNav = [
  { to: "/admin#admin-yards", hash: "#admin-yards", label: "Yards", icon: Building2, id: "admin-yards" },
  { to: "/admin#admin-discounts", hash: "#admin-discounts", label: "Discounts & Revenue", icon: Percent, id: "admin-discounts" },
  { to: "/admin#admin-growth", hash: "#admin-growth", label: "Growth & Trials", icon: TrendingUp, id: "admin-growth" },
  { to: "/admin#admin-messages", hash: "#admin-messages", label: "Support Messages", icon: MessageSquare, id: "admin-messages" },
  { to: "/admin#admin-security", hash: "#admin-security", label: "Staff & Security", icon: ShieldCheck, id: "admin-security" },
  { to: "/admin#admin-users", hash: "#admin-users", label: "Users", icon: Users, id: "admin-users" },
  { to: "/admin#admin-activity", hash: "#admin-activity", label: "Activity Log", icon: History, id: "admin-activity" },
];

const NAV: Record<Role, { to: string; label: string; icon: typeof Gauge; id: string; hash?: string }[]> = {
  master: adminNav,
  admin: adminNav,
  owner: yardManagerNav,
  sales_manager: yardManagerNav,
  manager: yardManagerNav,
  inventory_manager: inventoryManagerNav,
  rep: repNav,
  sales_rep: repNav,
};

export function homeFor(role: Role) {
  if (role === "master" || role === "admin") return "/admin";
  if (role === "inventory_manager") return "/vehicles";
  if (isManagerLike(role)) return "/dashboard";
  return "/me";
}

/** Everything the shell needs about the signed-in user and their yard. */
function useShellData() {
  const me = useMe();
  const user = me.data;
  const isStaff = user?.role === "master" || user?.role === "admin";
  const org = useQuery({ queryKey: ["org"], queryFn: () => apiGet<OrgInfo>("/org/me"), enabled: !!user && !isStaff, retry: false });
  const branding = useBranding(!!user);
  const callbacks = useQuery({
    queryKey: ["callbacks", "open"],
    queryFn: () => apiGet<CallbackItem[]>("/callbacks?status=open"),
    enabled: !!user && !isStaff && (org.data?.access === true || !!user.impersonated_by),
    refetchInterval: 60_000,
  });
  const assignments = useAssignments(!!user && user.role === "rep" && org.data?.access === true);
  const pending = (assignments.data ?? []).filter((x) => x.status !== "done");
  return {
    me,
    isStaff,
    org: org.data,
    loading: me.isLoading || (!!user && !isStaff && org.isLoading),
    branding: branding.data,
    badges: {
      callbacks: callbacks.isError ? 0 : (callbacks.data?.length ?? 0),
      assignments: pending.length,
      overdue: pending.some((x) => x.status === "overdue"),
    } satisfies NavBadges,
  };
}

type NavBadges = { callbacks: number; assignments: number; overdue: boolean };
type ShellData = ReturnType<typeof useShellData>;

/** Where this visitor must be sent instead of the page they asked for (null = let them in). */
function redirectFor(d: ShellData, path: string, managerOnly: boolean, platform: boolean): string | null {
  const user = d.me.data;
  if (d.me.isError || !user) return "/login";
  if (platform !== d.isStaff) return homeFor(user.role);
  if (managerOnly && !isManagerLike(user.role)) return homeFor(user.role);
  const billing = isManagerLike(user.role) ? "/settings/billing" : "/billing";
  if (d.org && !d.org.access && !user.impersonated_by && path !== billing) return billing;
  return null;
}

/** New staff login on its starting password: nothing else opens until they choose their own. */
function FirstPasswordScreen({ name }: { name: string }) {
  const qc = useQueryClient();
  return (
    <div className="bg-grid grid min-h-screen place-items-center bg-background px-4" data-testid="first-password-screen">
      <div className="w-full max-w-4xl">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-sky-300">Welcome, {name.split(" ")[0]}</p>
        <h1 className="mt-2 font-heading text-3xl font-bold text-white">One step before you start</h1>
        <ChangePasswordPanel first className="mt-6" onChanged={() => qc.invalidateQueries({ queryKey: ["me"] })} />
        <button type="button" data-testid="first-password-sign-out" onClick={() => endSession()} className="mt-4 inline-flex items-center gap-1.5 text-sm text-slate-400 transition-colors duration-150 hover:text-white">
          <LogOut className="size-3.5" /> Sign out instead
        </button>
      </div>
    </div>
  );
}

export default function AppShell({ managerOnly = false, platform = false }: { managerOnly?: boolean; platform?: boolean }) {
  const loc = useLocation();
  const d = useShellData();
  if (d.loading) return <ShellLoading />;
  const to = redirectFor(d, loc.pathname, managerOnly, platform);
  const me = d.me.data;
  if (to || !me) return <Navigate to={to ?? "/login"} replace state={to === "/login" ? { from: loc.pathname } : undefined} />;
  if (me.must_change_password && !me.impersonated_by) return <FirstPasswordScreen name={me.name} />;

  return (
    <div className="min-h-screen bg-background">
      <Sidebar me={me} org={d.org} isStaff={d.isStaff} branding={d.branding} badges={d.badges} />
      <MobileBar me={me} branding={d.branding} />
      <main className="bg-grid min-h-screen lg:pl-64">
        {me.impersonated_by && <ImpersonationBanner me={me} orgName={d.org?.name} />}
        {!d.isStaff && (
          <>
            <PreviewEndingBanner />
            <EnterpriseTour />
            <DemoLimitDialog />
          </>
        )}
        {d.org?.status === "trialing" && d.org.access && <TrialBanner org={d.org} isManager={isManagerLike(me.role)} />}
        <div className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-[1400px] flex-col px-4 py-8 md:px-8 md:py-10">
          <DrillProvider>
            <Outlet />
          </DrillProvider>
          <AppFooter />
        </div>
      </main>
    </div>
  );
}

function ShellLoading() {
  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <div className="relative h-1 w-48 overflow-hidden rounded bg-slate-800">
        <div className="scan-bar absolute inset-y-0 w-1/3 bg-amber-500" />
      </div>
    </div>
  );
}

function Sidebar({ me, org, isStaff, branding, badges }: { me: User; org?: OrgInfo; isStaff: boolean; branding?: Branding; badges: NavBadges }) {
  const loc = useLocation();
  const [activeHash, setActiveHash] = useState(loc.hash || "#admin-yards");

  useEffect(() => {
    const onHashChange = () => {
      setActiveHash(window.location.hash || "#admin-yards");
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    if (!isStaff || loc.pathname !== "/admin") return;
    const sections = ["#admin-yards", "#admin-discounts", "#admin-growth", "#admin-messages", "#admin-security", "#admin-users", "#admin-activity"];
    const onScroll = () => {
      for (const s of sections) {
        const el = document.querySelector(s);
        if (el) {
          const rect = el.getBoundingClientRect();
          if (rect.top <= 240 && rect.bottom >= 120) {
            setActiveHash(s);
            break;
          }
        }
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [isStaff, loc.pathname]);

  const handleNavClick = (e: React.MouseEvent, n: { to: string; hash?: string }) => {
    if (n.hash && loc.pathname === "/admin") {
      e.preventDefault();
      setActiveHash(n.hash);
      if (window.location.hash !== n.hash) {
        window.history.pushState(null, "", n.hash);
      }
      const el = document.querySelector(n.hash);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        el.classList.add("ring-2", "ring-amber-500/50");
        setTimeout(() => el.classList.remove("ring-2", "ring-amber-500/50"), 1200);
      }
    }
  };

  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-sidebar-border bg-sidebar lg:flex">
      <div className="flex items-center gap-2.5 px-6 py-6">
        <BrandLogo branding={branding} />
        <div>
          <div className="flex items-center gap-1.5">
            <p className="font-heading text-[16px] font-extrabold leading-none text-white">Salvage Pulse AI</p>
            <span className="rounded bg-amber-500/15 px-1 py-0.2 font-mono text-[9px] font-bold uppercase text-amber-300 ring-1 ring-amber-500/30">
              Beta
            </span>
          </div>
          <p className="mt-1 font-mono text-[9px] uppercase tracking-[0.18em] text-amber-400/80">{isStaff ? "Platform console" : (org?.name ?? "Salvage Pulse")}</p>
        </div>
      </div>
      <nav className="mt-4 flex-1 space-y-1 px-3">
        {(NAV[me.role] || NAV.rep).map((n) => {
          const isAnchor = Boolean(n.hash && isStaff && loc.pathname === "/admin");
          const active = isAnchor ? activeHash === n.hash : undefined;
          return (
            <NavLink
              key={n.to}
              to={n.to}
              data-testid={`nav-${n.id}`}
              onClick={(e) => handleNavClick(e, n)}
              className={({ isActive }) =>
                cn(
                  "group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors duration-150",
                  (isAnchor ? active : isActive)
                    ? "bg-sidebar-accent text-white shadow-[inset_2px_0_0_var(--color-amber-500)]"
                    : "text-slate-400 hover:bg-sidebar-accent/60 hover:text-white",
                )
              }
            >
              <n.icon className="size-4 transition-transform duration-150 group-hover:scale-110" />
              {n.label}
              <NavBadge id={n.id} isRep={me.role === "rep" || me.role === "sales_rep"} badges={badges} />
            </NavLink>
          );
        })}
      </nav>
      <div className="mt-auto">
        <UserCard me={me} />
        <AppFooter compact className="border-t border-sidebar-border/40 mx-2" />
      </div>
    </aside>
  );
}

function NavBadge({ id, isRep, badges }: { id: string; isRep: boolean; badges: NavBadges }) {
  if (id === "roleplay" && isRep && badges.assignments > 0) {
    return (
      <span
        data-testid="nav-roleplay-badge"
        className={cn("ml-auto rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold", badges.overdue ? "bg-red-500 text-white" : "bg-sky-500 text-black")}
      >
        {badges.assignments}
      </span>
    );
  }
  if (id === "callbacks" && badges.callbacks > 0) {
    return (
      <span data-testid="nav-callbacks-badge" className="ml-auto rounded-full bg-red-500 px-2 py-0.5 font-mono text-[10px] font-semibold text-white">
        {badges.callbacks}
      </span>
    );
  }
  return null;
}

function UserCard({ me }: { me: User }) {
  return (
    <div className="m-3 rounded-xl border border-sidebar-border bg-card p-4">
      <div className="flex items-center gap-3">
        <Avatar name={me.name} url={me.avatar_url} />
        <div className="min-w-0">
          <p data-testid="current-user-name" className="truncate text-sm font-semibold text-white">
            {me.name}
          </p>
          <p data-testid="current-user-role" className="font-mono text-[10px] uppercase tracking-wider text-amber-400/80">
            {roleLabel(me.role)}
          </p>
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <button
          data-testid="logout-button"
          onClick={() => endSession()}
          className="flex flex-1 items-center justify-center gap-2 rounded-md border border-slate-700 py-1.5 text-xs text-slate-300 transition-colors duration-150 hover:border-red-500/50 hover:text-red-300"
        >
          <LogOut className="size-3.5" /> Sign out
        </button>
        <ThemeToggle />
      </div>
      <ContactUsButton className="mt-2" />
    </div>
  );
}

function MobileBar({ me, branding }: { me: User; branding?: Branding }) {
  const loc = useLocation();
  const isStaff = me.role === "master" || me.role === "admin";
  return (
    <header className="sticky top-0 z-30 flex items-center gap-3 overflow-x-auto border-b border-border bg-sidebar/95 px-4 py-3 backdrop-blur lg:hidden">
      <BrandLogo branding={branding} className="h-7 w-auto shrink-0" testId="mobile-brand-logo" />
      <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase text-amber-300 ring-1 ring-amber-500/30">
        Beta
      </span>
      {(NAV[me.role] || NAV.rep).map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          data-testid={`mobile-nav-${n.id}`}
          onClick={(e) => {
            if (n.hash && isStaff && loc.pathname === "/admin") {
              e.preventDefault();
              window.history.pushState(null, "", n.hash);
              const el = document.querySelector(n.hash);
              if (el) {
                el.scrollIntoView({ behavior: "smooth", block: "start" });
                el.classList.add("ring-2", "ring-amber-500/50");
                setTimeout(() => el.classList.remove("ring-2", "ring-amber-500/50"), 1200);
              }
            }
          }}
          className={({ isActive }) => cn("whitespace-nowrap text-sm", isActive ? "text-amber-400" : "text-slate-400")}
        >
          {n.label}
        </NavLink>
      ))}
      <ContactUsButton compact className="ml-auto" />
      <ThemeToggle className="shrink-0" testId="mobile-theme-toggle" />
      <button data-testid="mobile-logout-button" onClick={() => endSession()} className="shrink-0 text-slate-400">
        <LogOut className="size-4" />
      </button>
    </header>
  );
}

function ImpersonationBanner({ me, orgName }: { me: User; orgName?: string }) {
  const qc = useQueryClient();
  const stop = useMutation({
    mutationFn: () => apiPost<User>("/auth/stop-impersonating"),
    onSuccess: () => {
      qc.cancelQueries();
      window.location.assign("/admin");
    },
  });
  return (
    <div data-testid="impersonation-banner" className="sticky top-0 z-50 flex items-center justify-between gap-3 bg-amber-500 px-6 py-2.5 text-sm font-medium text-slate-950 shadow-md">
      <div className="flex items-center gap-2">
        <span className="inline-block size-2 animate-pulse rounded-full bg-slate-950" />
        <span>
          Viewing as <strong>{me.name}</strong> ({orgName || "Demo Yard"}) · Signed in by {me.impersonated_by}
        </span>
      </div>
      <button
        data-testid="stop-impersonating-button"
        onClick={() => stop.mutate()}
        disabled={stop.isPending}
        className="flex items-center gap-1.5 rounded-md bg-slate-950 px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-slate-800 disabled:opacity-50"
      >
        Return to Master Console
      </button>
    </div>
  );
}

function trialNote(org: OrgInfo): string {
  if (org.no_card_trial && org.trial_ends_at) return `Ends ${new Date(org.trial_ends_at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}. Add a card for 7 more free days.`;
  if (org.trial_limited) return `Premium features are now limited (trends & parts insights paused, ${org.roleplay_daily_cap} role-play a day).`;
  if (org.limited_starts_at) return `Full access until ${new Date(org.limited_starts_at).toLocaleDateString()}, then premium features are limited.`;
  return "";
}

function ConfirmEmailNote({ isManager }: { isManager: boolean }) {
  const resend = useMutation({
    mutationFn: () => apiPost<ResendResult>("/auth/resend-verification"),
    onSuccess: (r) => (r.sent ? toast.success("Sent — check your inbox") : toast.error("Email is unavailable right now — try again shortly")),
    onError: (e) => toast.error(errorMessage(e, "Couldn't resend")),
  });
  return (
    <span data-testid="trial-banner-verify" className="w-full text-amber-100">
      <strong>Confirm your email</strong> to switch on AI scoring and role-play.{" "}
      {isManager && (
        <button data-testid="trial-banner-resend" disabled={resend.isPending} onClick={() => resend.mutate()} className="font-medium underline underline-offset-2 hover:text-white">
          Resend the link
        </button>
      )}
    </span>
  );
}

/** Back from the confirmation email (?email=confirmed|expired): say so once, refresh the yard, tidy the URL. */
function useEmailConfirmResult() {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const result = params.get("email");
  useEffect(() => {
    if (!result) return;
    if (result === "confirmed") toast.success("Email confirmed — AI is switched on for your free day");
    else toast.error("That confirmation link has expired — use “Resend the link” in the banner");
    qc.invalidateQueries({ queryKey: ["org"] });
    params.delete("email");
    setParams(params, { replace: true });
  }, [result, params, setParams, qc]);
}

function TrialBanner({ org, isManager }: { org: OrgInfo; isManager: boolean }) {
  useEmailConfirmResult();
  return (
    <div
      data-testid="trial-banner"
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-6 py-2 text-sm",
        org.trial_limited ? "border-orange-500/40 bg-orange-500/15 text-orange-100" : "border-amber-500/30 bg-amber-500/10 text-amber-200",
      )}
    >
      <span data-testid="trial-banner-text">
        {org.no_card_trial ? (
          <>
            Free day on the <strong>{org.plan}</strong> plan — no card needed.
          </>
        ) : (
          <>
            Free trial: <strong>{org.days_left} {org.days_left === 1 ? "day" : "days"} left</strong> on the {PLAN_NAMES[org.plan] ?? org.plan} plan.
          </>
        )}{" "}
        {trialNote(org)}{" "}
        {org.card_on_file && org.trial_ends_at && `Your card is charged on ${new Date(org.trial_ends_at).toLocaleDateString()}.`}
      </span>
      {org.no_card_trial && !org.email_verified && <ConfirmEmailNote isManager={isManager} />}
      {isManager && (
        <NavLink to="/billing" data-testid="trial-banner-upgrade" className="ml-auto font-medium text-amber-300 hover:underline">
          {org.card_on_file ? "Upgrade now" : org.no_card_trial ? "Add card — 7 days free" : "Add card & upgrade"}
        </NavLink>
      )}
    </div>
  );
}

export function Avatar({ name, url, size = 36 }: { name: string; url?: string; size?: number }) {
  const initials = name
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return url ? (
    <img src={url} alt={name} style={{ width: size, height: size }} className="shrink-0 rounded-full object-cover ring-1 ring-slate-700" />
  ) : (
    <div
      style={{ width: size, height: size }}
      className="flex shrink-0 items-center justify-center rounded-full bg-slate-800 font-mono text-xs text-amber-300 ring-1 ring-slate-700"
    >
      {initials}
    </div>
  );
}
