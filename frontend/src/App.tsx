import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { GoogleCallback } from "@/components/GoogleSignIn";
import PremiumGate from "@/components/PremiumGate";
import { Toaster } from "@/components/ui/sonner";
import AppShell, { homeFor } from "@/components/AppShell";
import ErrorBoundary from "@/components/ErrorBoundary";
import { useMe } from "@/lib/hooks";
import Login from "@/pages/Login";
import Dashboard from "@/pages/Dashboard";
import Performance from "@/pages/Performance";
import Calls from "@/pages/Calls";
import CallDetail from "@/pages/CallDetail";
import UploadCall from "@/pages/UploadCall";
import Team from "@/pages/Team";
import Keywords from "@/pages/Keywords";
import Vehicles from "@/pages/Vehicles";
import TagVehicles from "@/pages/TagVehicles";
import Reports from "@/pages/Reports";
import Leaderboards from "@/pages/Leaderboards";
import LotPoster from "@/pages/LotPoster";
import TrophyPoster from "@/pages/TrophyPoster";
import Settings, { BillingRoute, ToSettings } from "@/pages/Settings";
import ShiftCalendar from "@/pages/ShiftCalendar";
import Roleplay from "@/pages/Roleplay";
import Callbacks from "@/pages/Callbacks";
import CustomerProfilePage from "@/pages/CustomerProfile";
import Signup from "@/pages/Signup";
import { ForgotPassword, LockAccount, NotMe, ResetPassword } from "@/pages/PasswordReset";
import Billing, { PaymentSuccess } from "@/pages/Billing";
import AdminConsole from "@/pages/AdminConsole";

function HomeRedirect() {
  const { data: me, isLoading } = useMe();
  if (isLoading) return null;
  return <Navigate to={me ? homeFor(me.role) : "/login"} replace />;
}

// One <Route> per page in src/pages; BrowserRouter already wraps this in main.tsx.
export default function App() {
  // Back from Google sign-in: handle #session_id before any route (and its /auth/me check) renders.
  const { hash } = useLocation();
  if (hash.includes("session_id=")) {
    return (
      <>
        <GoogleCallback hash={hash} />
        <Toaster richColors />
      </>
    );
  }
  return (
    <ErrorBoundary>
      <Routes>
        <Route path="/" element={<HomeRedirect />} />
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/not-me" element={<NotMe />} />
        <Route path="/lock-account" element={<LockAccount />} />
        <Route path="/payment/success" element={<PaymentSuccess />} />
        <Route path="/poster/:repId" element={<TrophyPoster />} />
        <Route path="/poster/location/:siteId" element={<TrophyPoster />} />
        <Route path="/poster/lot/:siteId" element={<LotPoster />} />
        <Route element={<AppShell platform />}>
          <Route path="/admin" element={<AdminConsole />} />
        </Route>
        <Route element={<AppShell />}>
          <Route path="/me" element={<Performance />} />
          <Route path="/calls" element={<Calls />} />
          <Route path="/calls/:id" element={<CallDetail />} />
          <Route path="/upload" element={<UploadCall />} />
          <Route path="/roleplay" element={<PremiumGate feature="roleplay" className="mt-2"><Roleplay /></PremiumGate>} />
          <Route path="/callbacks" element={<Callbacks />} />
          <Route path="/customers/:key" element={<CustomerProfilePage />} />
          <Route path="/billing" element={<BillingRoute />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/settings/:tab" element={<Settings />} />
          <Route path="/vehicles" element={<Vehicles />} />
          <Route path="/tag-vehicles" element={<TagVehicles />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/leaderboards" element={<Leaderboards />} />
          <Route path="/calendar" element={<ShiftCalendar />} />
        </Route>
        <Route element={<AppShell managerOnly />}>
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/reps/:repId" element={<Performance />} />
          <Route path="/team" element={<Team />} />
          <Route path="/keywords" element={<Keywords />} />
          <Route path="/connectors" element={<ToSettings tab="connectors" />} />
          <Route path="/appearance" element={<ToSettings tab="appearance" />} />
        </Route>
        <Route path="*" element={<HomeRedirect />} />
      </Routes>
      <Toaster richColors />
    </ErrorBoundary>
  );
}
