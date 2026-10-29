import { APP_VERSION, APP_STAGE, IS_BETA } from "@/lib/version";
import { cn } from "@/lib/utils";

interface AppFooterProps {
  className?: string;
  compact?: boolean;
}

export default function AppFooter({ className, compact = false }: AppFooterProps) {
  const currentYear = new Date().getFullYear();

  if (compact) {
    return (
      <div
        data-testid="app-version-badge-compact"
        className={cn("flex items-center justify-between px-3 py-2 text-[11px] text-slate-500", className)}
      >
        <span className="truncate">Salvage Pulse AI</span>
        <div className="flex items-center gap-1.5 shrink-0">
          {IS_BETA && (
            <span
              data-testid="beta-tag-compact"
              className="rounded bg-amber-500/15 px-1 py-0.2 font-mono text-[9px] font-semibold uppercase tracking-wider text-amber-400 ring-1 ring-amber-500/30"
            >
              {APP_STAGE}
            </span>
          )}
          <span className="font-mono text-slate-400">v{APP_VERSION}</span>
        </div>
      </div>
    );
  }

  return (
    <footer
      data-testid="app-footer"
      className={cn(
        "mt-16 flex flex-col items-center justify-between gap-3 border-t border-border/40 pt-6 pb-8 text-xs text-slate-500 sm:flex-row",
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
        <span className="font-medium text-slate-300">Salvage Pulse AI</span>
        {IS_BETA && (
          <span
            data-testid="beta-tag"
            className="inline-flex items-center rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-amber-300 ring-1 ring-amber-500/30"
          >
            {APP_STAGE}
          </span>
        )}
        <span className="font-mono text-slate-400" data-testid="app-version-text">
          v{APP_VERSION}
        </span>
        <span className="hidden text-slate-700 sm:inline">·</span>
        <span className="hidden text-slate-500 sm:inline">Recycler Call Intelligence & Performance</span>
      </div>
      <p className="text-center text-[11px] text-slate-500 sm:text-right">
        &copy; {currentYear} Salvage Pulse Pro. All rights reserved.
      </p>
    </footer>
  );
}
