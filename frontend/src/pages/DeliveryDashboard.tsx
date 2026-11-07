import { useCallback, useEffect, useMemo, useRef } from "react";
import { Navigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/common";
import { apiGet } from "@/lib/api";
import { useMe } from "@/lib/hooks";
import type { Call, User } from "@/lib/types";
import { roleLabel } from "@/lib/types";

/**
 * Delivery Dashboard: the standalone report/PDF parser and dispatch board from
 * Delivery-Dash, served as a same-origin static app and embedded in an iframe.
 * Keeping it isolated preserves its PDF.js worker and platform API lookups
 * without porting thousands of lines of vanilla JS into React.
 */
const DASHBOARD_PATH = "/delivery-dash/index.html";

const REP_COLORS = ["#38bdf8", "#4ade80", "#a855f7", "#fbbf24", "#f87171", "#818cf8", "#fb7185", "#2dd4bf"];

interface DeliveryCall {
  phone: string;
  customer: string;
  rep: string;
  time: string;
  category: string;
  notes: string;
}

interface DeliveryRep {
  id: string;
  name: string;
  desk: string;
  role: string;
  color: string;
}

function formatCallTime(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString([], { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function daysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

export default function DeliveryDashboard() {
  const { data: me, isLoading } = useMe();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const isStaff = me?.role === "master" || me?.role === "admin";

  const callsQuery = useQuery({
    queryKey: ["calls", "delivery-dash"],
    queryFn: () => apiGet<Call[]>(`/calls?date_from=${daysAgo(120)}`),
    enabled: !!me && !isStaff,
    staleTime: 60_000,
  });

  const repsQuery = useQuery({
    queryKey: ["reps", "delivery-dash"],
    queryFn: () => apiGet<User[]>("/users/reps?include_disabled=true"),
    enabled: !!me && !isStaff,
    staleTime: 5 * 60_000,
  });

  const dashboardCalls = useMemo<DeliveryCall[]>(
    () =>
      (callsQuery.data ?? [])
        .filter((c) => c.customer_name || c.customer_phone)
        .map((c) => ({
          phone: c.customer_phone || "",
          customer: c.customer_name || "",
          rep: c.rep_name || "",
          time: formatCallTime(c.created_at),
          category: c.category || "",
          notes: c.summary || "",
        })),
    [callsQuery.data],
  );

  const dashboardReps = useMemo<DeliveryRep[]>(
    () =>
      (repsQuery.data ?? []).map((r, i) => ({
        id: r.id,
        name: r.name,
        desk: r.title || roleLabel(r.role),
        role: roleLabel(r.role),
        color: REP_COLORS[i % REP_COLORS.length],
      })),
    [repsQuery.data],
  );

  const postData = useCallback(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    const origin = window.location.origin;
    win.postMessage({ type: "sp-delivery-calls", calls: dashboardCalls }, origin);
    win.postMessage({ type: "sp-delivery-reps", reps: dashboardReps }, origin);
  }, [dashboardCalls, dashboardReps]);

  // The dashboard may boot before our queries resolve; it announces readiness
  // so we can push the newest calls/reps as soon as the frame is listening.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string } | null;
      if (data?.type === "sp-delivery-ready") postData();
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [postData]);

  useEffect(() => {
    postData();
  }, [postData]);

  if (isLoading) return null;
  if (!me) return <Navigate to="/login" replace />;
  if (me.role === "inventory_manager") return <Navigate to="/vehicles" replace />;
  if (isStaff) return <Navigate to="/admin" replace />;

  const params = new URLSearchParams({
    embed: "1",
    user: me.name || me.email,
    role: me.role,
  });

  return (
    <div className="flex flex-1 flex-col">
      <PageHeader overline="Dispatch" title="Delivery Dashboard" />
      <div className="flex-1 overflow-hidden rounded-xl border border-border bg-background">
        <iframe
          ref={iframeRef}
          src={`${DASHBOARD_PATH}?${params.toString()}`}
          title="Delivery Dashboard"
          className="h-[calc(100vh-16rem)] min-h-[640px] w-full"
          onLoad={postData}
        />
      </div>
    </div>
  );
}
