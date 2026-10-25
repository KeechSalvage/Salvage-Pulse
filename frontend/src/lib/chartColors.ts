/** One chart palette around the Salvage Pulse brand: blue for the main series (follows a yard's own accent),
 * silver for comparisons, and distinct greens/ambers/reds for good/ok/low — never two blues side by side. */
export const CHART = {
  brand: "var(--color-amber-500)", // Salvage Pulse blue, or the yard's accent
  silver: "var(--chart-silver)", // comparison / secondary series
  grid: "var(--border)",
  tick: "var(--chart-tick)",
  cursor: "var(--chart-cursor)",
  good: "#10B981",
  warn: "#F59E0B",
  bad: "#EF4444",
} as const;

/** Many-series charts (e.g. one line per rep): brand and silver first, then clearly different hues. */
export const SERIES = [CHART.brand, CHART.silver, "#34D399", "#F472B6", "#F59E0B", "#A78BFA", "#22D3EE", "#FB923C", "#64748B"] as const;

export const axisTick = { fill: CHART.tick, fontSize: 11 } as const;
