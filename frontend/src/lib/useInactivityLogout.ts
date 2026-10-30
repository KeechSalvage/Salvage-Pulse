import { useEffect, useRef } from "react";
import { endSession } from "./session";
import { toast } from "sonner";

const INACTIVITY_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
const ACTIVITY_EVENTS: (keyof WindowEventMap)[] = [
  "mousedown",
  "mousemove",
  "keydown",
  "scroll",
  "touchstart",
  "click",
];

const LAST_ACTIVITY_KEY = "sp_last_activity_ts";

export function useInactivityLogout(enabled: boolean = true) {
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const recordActivity = () => {
      try {
        localStorage.setItem(LAST_ACTIVITY_KEY, String(Date.now()));
      } catch {
        // localStorage unavailable in private mode fallback
      }
    };

    const checkInactivity = () => {
      try {
        const raw = localStorage.getItem(LAST_ACTIVITY_KEY);
        const lastActivity = raw ? Number(raw) : Date.now();
        if (Date.now() - lastActivity >= INACTIVITY_TIMEOUT_MS) {
          toast.error("You have been signed out due to 1 hour of inactivity.");
          localStorage.removeItem(LAST_ACTIVITY_KEY);
          void endSession("/login?reason=inactivity");
        }
      } catch {
        // ignore
      }
    };

    // Initialize last activity timestamp if absent
    if (!localStorage.getItem(LAST_ACTIVITY_KEY)) {
      recordActivity();
    }

    // Throttle activity updates to at most once every 10 seconds to avoid spamming localStorage
    let throttleTimeout: number | null = null;
    const handleUserActivity = () => {
      if (throttleTimeout) return;
      recordActivity();
      throttleTimeout = window.setTimeout(() => {
        throttleTimeout = null;
      }, 10_000);
    };

    ACTIVITY_EVENTS.forEach((event) => {
      window.addEventListener(event, handleUserActivity, { passive: true });
    });

    // Check periodically every 15 seconds
    const interval = window.setInterval(checkInactivity, 15_000);

    return () => {
      ACTIVITY_EVENTS.forEach((event) => {
        window.removeEventListener(event, handleUserActivity);
      });
      window.clearInterval(interval);
      if (throttleTimeout) {
        window.clearTimeout(throttleTimeout);
      }
    };
  }, [enabled]);
}
