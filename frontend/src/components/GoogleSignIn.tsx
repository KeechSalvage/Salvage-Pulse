import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { homeFor } from "@/components/AppShell";
import { apiGet, apiPost, errorMessage } from "@/lib/api";
import { queryClient } from "@/lib/queryClient";
import { beginSession } from "@/lib/session";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, Shield, User as UserIcon, AlertCircle } from "lucide-react";
import type {
  GoogleAuthConfig,
  GoogleSessionRequest,
  GoogleSignupRequest,
  GoogleSignupResult,
  User,
} from "@/lib/types";

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            prompt?: string;
            callback: (response: { access_token?: string; error?: string }) => void;
            error_callback?: (error: { type?: string; message?: string }) => void;
          }) => {
            requestAccessToken: () => void;
          };
        };
      };
    };
  }
}

// Yard details typed on /signup survive the trip to Google here (this tab only; never sent anywhere else).
const PENDING_SIGNUP = "sp_google_signup";
type PendingSignup = Omit<GoogleSignupRequest, "session_id" | "access_token" | "id_token">;

/** Initiate Google sign-in; triggers event so the mounted GoogleButton handles it cleanly */
export function startGoogleSignIn(signup?: PendingSignup): void {
  if (signup) {
    sessionStorage.setItem(PENDING_SIGNUP, JSON.stringify(signup));
  } else {
    sessionStorage.removeItem(PENDING_SIGNUP);
  }
  window.dispatchEvent(new CustomEvent("sp:trigger-google-sign-in", { detail: signup }));
}

function takePendingSignup(): PendingSignup | null {
  const raw = sessionStorage.getItem(PENDING_SIGNUP);
  sessionStorage.removeItem(PENDING_SIGNUP);
  try {
    const p = raw ? (JSON.parse(raw) as PendingSignup) : null;
    return p?.yard_name ? p : null;
  } catch {
    return null;
  }
}

function googleOauth2() {
  return typeof window !== "undefined" ? window.google?.accounts?.oauth2 : undefined;
}

/** Wait for the async/defer GIS script instead of failing on an early click. */
function waitForGoogleIdentityServices(timeoutMs = 6000): Promise<boolean> {
  if (googleOauth2()) return Promise.resolve(true);
  if (typeof window === "undefined") return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    let poll = 0;
    let timer = 0;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      window.clearInterval(poll);
      window.clearTimeout(timer);
      resolve(ok);
    };
    poll = window.setInterval(() => {
      if (googleOauth2()) finish(true);
    }, 100);
    timer = window.setTimeout(() => finish(false), timeoutMs);
  });
}

function handleGoogleError(error: string): void {
  // The user closing the account picker is not an error worth shouting about.
  if (error === "popup_closed" || error === "user_cancelled" || error === "access_denied") {
    return;
  }
  if (error === "origin_mismatch" || error === "invalid_client") {
    toast.error(
      `Google rejected this site (${error}). Ask your administrator to add ${window.location.origin} to the OAuth client's Authorized JavaScript origins.`,
      { duration: 12000 }
    );
    return;
  }
  toast.error(`Google authentication error: ${error}`, { duration: 8000 });
}

const GoogleIcon = () => (
  <svg viewBox="0 0 48 48" className="size-5 shrink-0" aria-hidden="true">
    <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
    <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
    <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
    <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
  </svg>
);

function getRoleBadge(role: string) {
  switch (role) {
    case "owner":
      return <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[11px] font-medium text-amber-400">Owner</span>;
    case "sales_manager":
    case "inventory_manager":
    case "manager":
      return <span className="rounded bg-blue-500/20 px-1.5 py-0.5 text-[11px] font-medium text-blue-400">Manager</span>;
    case "rep":
    case "sales_rep":
      return <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[11px] font-medium text-emerald-400">Sales Rep</span>;
    case "master":
      return <span className="rounded bg-purple-500/20 px-1.5 py-0.5 text-[11px] font-medium text-purple-400">Master Admin</span>;
    default:
      return <span className="rounded bg-slate-700/50 px-1.5 py-0.5 text-[11px] font-medium text-slate-300">{role}</span>;
  }
}

export function GoogleButton({
  label = "Continue with Google",
  testId = "login-google-button",
  onClick,
  signup,
  onBeforeStart,
}: {
  label?: string;
  testId?: string;
  onClick?: () => void;
  signup?: PendingSignup;
  onBeforeStart?: () => boolean;
}) {
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);

  const { data: config } = useQuery<GoogleAuthConfig>({
    queryKey: ["google-config"],
    queryFn: () => apiGet<GoogleAuthConfig>("/auth/google/config"),
    staleTime: 60_000,
    retry: 1,
  });

  const handleAuthenticatedUser = useCallback((user: User, isNewSignup = false) => {
    beginSession();
    queryClient.setQueryData(["me"], user);
    toast.success(
      isNewSignup
        ? "Your free trial has started — welcome to Salvage Pulse"
        : `Signed in as ${user.name}`
    );
    nav(homeFor(user.role), { replace: true });
  }, [nav]);

  // A click can land before the config query resolves. Fetch on demand instead
  // of telling the user Google is unavailable.
  const loadConfig = useCallback(async (): Promise<GoogleAuthConfig | null> => {
    if (config) return config;
    try {
      return await queryClient.fetchQuery<GoogleAuthConfig>({
        queryKey: ["google-config"],
        queryFn: () => apiGet<GoogleAuthConfig>("/auth/google/config"),
        staleTime: 0,
        retry: 1,
      });
    } catch (err) {
      console.error("Google sign-in config request failed:", err);
      return null;
    }
  }, [config]);

  const triggerGoogleAuth = useCallback(async (pendingData?: PendingSignup) => {
    if (onBeforeStart && !onBeforeStart()) {
      return;
    }

    const effectiveSignup = pendingData ?? signup;
    if (effectiveSignup) {
      sessionStorage.setItem(PENDING_SIGNUP, JSON.stringify(effectiveSignup));
    } else {
      sessionStorage.removeItem(PENDING_SIGNUP);
    }

    setBusy(true);
    let client: { requestAccessToken: () => void } | null = null;
    try {
      const cfg = await loadConfig();
      if (!cfg) {
        toast.error("Couldn't check Google sign-in availability. Please try again, or sign in with email and password.");
        return;
      }
      if (!cfg.configured || !cfg.client_id) {
        toast.error(
          "Google sign-in isn't enabled on this server. Use email and password, or ask your administrator to configure GOOGLE_CLIENT_ID.",
          { duration: 10000 }
        );
        return;
      }

      const ready = await waitForGoogleIdentityServices();
      const oauth2 = googleOauth2();
      if (!ready || !oauth2) {
        toast.error("Google sign-in couldn't load. Check your connection or ad blocker, then refresh the page.", { duration: 10000 });
        return;
      }

      try {
        client = oauth2.initTokenClient({
          client_id: cfg.client_id,
          scope: "openid email profile",
          prompt: "select_account",
          callback: async (resp: { access_token?: string; error?: string }) => {
            if (resp.error) {
              handleGoogleError(resp.error);
              return;
            }
            if (!resp.access_token) {
              toast.error("Google did not return an access token. Please try again.");
              return;
            }
            try {
              const pending = takePendingSignup();
              if (!pending) {
                const user = await apiPost<User>("/auth/google", {
                  access_token: resp.access_token,
                } satisfies GoogleSessionRequest);
                handleAuthenticatedUser(user);
              } else {
                const r = await apiPost<GoogleSignupResult>("/auth/google/signup", {
                  access_token: resp.access_token,
                  ...pending,
                } satisfies GoogleSignupRequest);
                handleAuthenticatedUser(r.user, r.created);
              }
            } catch (e) {
              toast.error(errorMessage(e, "Google sign-in failed"), { duration: 8000 });
            }
          },
          error_callback: (err: { type?: string; message?: string }) => {
            handleGoogleError(err?.type || "unknown_error");
          },
        });
      } catch (err) {
        console.error("GIS client init error:", err);
        toast.error(
          `Google sign-in could not start: ${err instanceof Error ? err.message : String(err)}`,
          { duration: 10000 }
        );
        return;
      }
    } catch (err) {
      console.error("Google sign-in setup error:", err);
      toast.error("Google sign-in could not start. Please try again, or sign in with email and password.");
      return;
    } finally {
      setBusy(false);
    }

    client?.requestAccessToken();
  }, [handleAuthenticatedUser, loadConfig, onBeforeStart, signup]);

  // Listen for programmatic startGoogleSignIn calls
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      void triggerGoogleAuth(detail);
    };
    window.addEventListener("sp:trigger-google-sign-in", handler);
    return () => window.removeEventListener("sp:trigger-google-sign-in", handler);
  }, [triggerGoogleAuth]);

  const handleClick = () => {
    if (onClick) {
      onClick();
    } else {
      void triggerGoogleAuth();
    }
  };

  return (
    <button
      type="button"
      data-testid={testId}
      onClick={handleClick}
      disabled={busy}
      aria-busy={busy}
      className="flex h-11 w-full items-center justify-center gap-3 rounded-md border border-slate-700 bg-card text-[15px] font-medium text-slate-100 transition-colors duration-150 hover:border-slate-500 hover:bg-slate-800/60 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {busy ? <Loader2 className="size-5 animate-spin" /> : <GoogleIcon />}
      {busy ? "Connecting to Google…" : label}
    </button>
  );
}
