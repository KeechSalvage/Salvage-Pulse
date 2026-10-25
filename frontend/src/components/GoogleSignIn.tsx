import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { homeFor } from "@/components/AppShell";
import { apiPost, errorMessage } from "@/lib/api";
import { queryClient } from "@/lib/queryClient";
import { beginSession } from "@/lib/session";
import type { GoogleSessionRequest, GoogleSignupRequest, GoogleSignupResult, User } from "@/lib/types";

// Yard details typed on /signup survive the trip to Google here (this tab only; never sent anywhere else).
const PENDING_SIGNUP = "sp_google_signup";
type PendingSignup = Omit<GoogleSignupRequest, "session_id">;

/** Send the browser to Emergent's managed Google sign-in; it returns to this site with #session_id=… */
export function startGoogleSignIn(signup?: PendingSignup): void {
  if (signup) sessionStorage.setItem(PENDING_SIGNUP, JSON.stringify(signup));
  else sessionStorage.removeItem(PENDING_SIGNUP);
  // REMINDER: DO NOT HARDCODE THE URL, OR ADD ANY FALLBACKS OR REDIRECT URLS, THIS BREAKS THE AUTH
  const redirectUrl = window.location.origin + "/";
  window.location.href = `https://auth.emergentagent.com/?redirect=${encodeURIComponent(redirectUrl)}`;
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

/** Sign in — or, coming back from the sign-up page, create the yard first. */
async function exchange(sessionId: string): Promise<{ user: User; message: string }> {
  const pending = takePendingSignup();
  if (!pending) {
    const user = await apiPost<User>("/auth/google", { session_id: sessionId } satisfies GoogleSessionRequest);
    return { user, message: `Welcome back, ${user.name.split(" ")[0]}` };
  }
  const r = await apiPost<GoogleSignupResult>("/auth/google/signup", { session_id: sessionId, ...pending } satisfies GoogleSignupRequest);
  return {
    user: r.user,
    message: r.created ? "Your free day has started — no card needed" : "You already had an account, so we signed you in",
  };
}

/** Rendered by App while the URL holds #session_id=…: swaps it for our own session cookie, then goes home. */
export function GoogleCallback({ hash }: { hash: string }) {
  const nav = useNavigate();
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return; // StrictMode double-run guard: the session_id is single-use
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

export function GoogleButton({ label = "Continue with Google", testId = "login-google-button", onClick }: { label?: string; testId?: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick ?? (() => startGoogleSignIn())}
      className="flex h-11 w-full items-center justify-center gap-3 rounded-md border border-slate-700 bg-card text-[15px] font-medium text-slate-100 transition-colors duration-150 hover:border-slate-500 hover:bg-slate-800/60"
    >
      <svg viewBox="0 0 48 48" className="size-5" aria-hidden="true">
        <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
        <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
        <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
        <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
      </svg>
      {label}
    </button>
  );
}
