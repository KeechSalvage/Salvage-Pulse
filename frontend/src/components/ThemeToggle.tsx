import { Moon, Sun } from "lucide-react";
import { useBranding, useSetMyMode } from "@/lib/branding";
import { cn } from "@/lib/utils";

/** Sun/moon switch: each user's own dark/light choice. */
export default function ThemeToggle({ className = "", testId = "theme-toggle" }: { className?: string; testId?: string }) {
  const { data } = useBranding();
  const set = useSetMyMode();
  const light = data?.mode === "light";
  return (
    <button
      type="button"
      data-testid={testId}
      title={light ? "Switch to dark mode" : "Switch to light mode"}
      aria-label={light ? "Switch to dark mode" : "Switch to light mode"}
      disabled={set.isPending}
      onClick={() => set.mutate(light ? "dark" : "light")}
      className={cn("grid size-8 place-items-center rounded-md border border-slate-700 text-slate-300 transition-[color,border-color,transform] duration-150 hover:border-amber-500/60 hover:text-amber-300 active:scale-90", className)}
    >
      {light ? <Moon className="size-4" /> : <Sun className="size-4" />}
    </button>
  );
}
