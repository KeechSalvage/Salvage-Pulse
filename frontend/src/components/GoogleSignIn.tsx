import { useEffect, useRef, useState, useCallback } from "react";
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

/** Legacy hash callback handler rendered by App while the URL holds #session_id=... */
async function exchange(sessionId: string): Promise<{ user: User; message: string }> {
  const pending = takePendingSignup();
  if (!pending) {
    const user = await apiPost<User>("/auth/google", { session_id: sessionId } satisfies GoogleSessionRequest);
    return { user, message: `Welcome back, ${user.name.split(" ")[0]}` };
  }
  const r = await apiPost<GoogleSignupResult>("/auth/google/signup", {
    session_id: sessionId,
    ...pending,
  } satisfies GoogleSignupRequest);
  return {
    user: r.user,
    message: r.created ? "Your free day has started — no card needed" : "You already had an account, so we signed you in",
  };
}

export function GoogleCallback({ hash }: { hash: string }) {
  const nav = useNavigate();
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const sessionId = new URLSearchParams(hash.replace(/^#/, "")).get("session_id") ?? "";
    const failTo = sessionStorage.getItem(PENDING_SIGNUP) ? "/signup" : "/login";
    exchange(sessionId)
      .then(({ user, message }) => {
        beginSession();
        queryClient.setQueryData(["me"], user);
        toast.success(message);
        nav(homeFor(user.role), { replace: true });
      })
      .catch((e) => {
        toast.error(errorMessage(e, "Google sign-in failed"), { duration: 8000 });
        nav(failTo, { replace: true });
      });
  }, [hash, nav]);
  return (
    <div data-testid="google-callback" className="flex h-screen items-center justify-center bg-background">
      <div className="relative h-1 w-48 overflow-hidden rounded bg-slate-800">
        <div className="scan-bar absolute inset-y-0 w-1/3 bg-amber-500" />
      </div>
    </div>
  );
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
  const [pickerOpen, setPickerOpen] = useState(false);
  const [loadingUser, setLoadingUser] = useState<string | null>(null);

  const { data: config } = useQuery<GoogleAuthConfig>({
    queryKey: ["google-config"],
    queryFn: () => apiGet<GoogleAuthConfig>("/auth/google/config"),
    staleTime: 60_000,
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

  const selectAccount = async (userId: string) => {
    setLoadingUser(userId);
    try {
      const pending = takePendingSignup();
      if (!pending) {
        const user = await apiPost<User>("/auth/google", {
          user_id: userId,
        } satisfies GoogleSessionRequest);
        setPickerOpen(false);
        handleAuthenticatedUser(user);
      } else {
        const r = await apiPost<GoogleSignupResult>("/auth/google/signup", {
          user_id: userId,
          ...pending,
        } satisfies GoogleSignupRequest & { user_id: string });
        setPickerOpen(false);
        handleAuthenticatedUser(r.user, r.created);
      }
    } catch (err) {
      toast.error(errorMessage(err, "Sign-in failed"));
    } finally {
      setLoadingUser(null);
    }
  };

  const triggerGoogleAuth = useCallback((pendingData?: PendingSignup) => {
    if (onBeforeStart && !onBeforeStart()) {
      return;
    }

    const effectiveSignup = pendingData ?? signup;
    if (effectiveSignup) {
      sessionStorage.setItem(PENDING_SIGNUP, JSON.stringify(effectiveSignup));
    } else {
      sessionStorage.removeItem(PENDING_SIGNUP);
    }

    if (config?.configured && config.client_id) {
      if (typeof window !== "undefined" && window.google?.accounts?.oauth2) {
        try {
          const client = window.google.accounts.oauth2.initTokenClient({
            client_id: config.client_id,
            scope: "openid email profile",
            prompt: "select_account",
            callback: async (resp: { access_token?: string; error?: string }) => {
              if (resp.error) {
                toast.error(`Google authentication error: ${resp.error}`);
                return;
              }
              if (!resp.access_token) return;
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
          });
          client.requestAccessToken();
          return;
        } catch (err) {
          console.error("GIS client init error:", err);
        }
      }
    }

    // Fallback: If not configured with GOOGLE_CLIENT_ID or script blocked, open account chooser modal
    setPickerOpen(true);
  }, [config, handleAuthenticatedUser, onBeforeStart, signup]);

  // Listen for programmatic startGoogleSignIn calls
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      triggerGoogleAuth(detail);
    };
    window.addEventListener("sp:trigger-google-sign-in", handler);
    return () => window.removeEventListener("sp:trigger-google-sign-in", handler);
  }, [triggerGoogleAuth]);

  const handleClick = () => {
    if (onClick) {
      onClick();
    } else {
      triggerGoogleAuth();
    }
  };

  const accounts = config?.accounts ?? [];

  return (
    <>
      <button
        type="button"
        data-testid={testId}
        onClick={handleClick}
        className="flex h-11 w-full items-center justify-center gap-3 rounded-md border border-slate-700 bg-card text-[15px] font-medium text-slate-100 transition-colors duration-150 hover:border-slate-500 hover:bg-slate-800/60"
      >
        <GoogleIcon />
        {label}
      </button>

      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="sm:max-w-md max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-lg text-white">
              <GoogleIcon />
              Choose an account
            </DialogTitle>
            <DialogDescription className="text-slate-400">
              Select an account to sign in to Salvage Pulse.
            </DialogDescription>
          </DialogHeader>

          {!config?.configured && (
            <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-200">
              <AlertCircle className="size-4 shrink-0 mt-0.5 text-amber-400" />
              <div>
                <span className="font-semibold">Preview / Demo Mode</span>: Google OAuth Client ID is not configured in <code className="rounded bg-black/40 px-1 py-0.5 font-mono">.env</code>. Select any user account below to test that role.
              </div>
            </div>
          )}

          <div className="mt-2 space-y-2">
            {accounts.map((acc) => {
              const isLoading = loadingUser === acc.id;
              return (
                <button
                  key={acc.id}
                  type="button"
                  data-testid={`google-account-${acc.email}`}
                  disabled={Boolean(loadingUser)}
                  onClick={() => selectAccount(acc.id)}
                  className="flex w-full items-center justify-between rounded-lg border border-slate-800 bg-slate-900/60 p-3 text-left transition-all hover:border-amber-500/40 hover:bg-slate-800/80 disabled:opacity-50"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-slate-800 border border-slate-700 text-slate-300 font-semibold text-sm">
                      {acc.name ? acc.name.charAt(0).toUpperCase() : <UserIcon className="size-4" />}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-medium text-white">{acc.name}</p>
                        {getRoleBadge(acc.role)}
                      </div>
                      <p className="truncate text-xs text-slate-400">{acc.email}</p>
                    </div>
                  </div>
                  {isLoading ? (
                    <Loader2 className="size-4 shrink-0 animate-spin text-amber-400" />
                  ) : (
                    <Shield className="size-4 shrink-0 text-slate-600" />
                  )}
                </button>
              );
            })}
          </div>

          <div className="mt-4 border-t border-slate-800 pt-3 text-[11px] text-slate-500">
            To connect official Google logins, add <code className="rounded bg-slate-900 px-1 py-0.5 text-slate-400">GOOGLE_CLIENT_ID</code> to your backend environment.
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
