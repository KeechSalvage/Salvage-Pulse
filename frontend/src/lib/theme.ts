import type { Branding } from "@/lib/types";

/** Runtime theming: dark/light class on <html>, accent palette (re-maps Tailwind's amber scale), favicon. */
const KEY = "sp-theme";
const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;
const DEFAULT_FAVICON = "/salvage-pulse-icon.png";

type Cached = { mode: "dark" | "light"; accent: string; logo: string };

const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const toHex = (rgb: number[]) => `#${rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;
const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);

/** Shades of the accent: lighter towards white below 500, darker towards black above. In light mode the
 * 100–400 shades (used for accent *text*) go darker instead so they stay readable on white. */
export function accentPalette(accent: string, mode: "dark" | "light"): Record<string, string> {
  const base = hex(accent);
  const white = [255, 255, 255];
  const black = [0, 0, 0];
  const lighten: Record<number, number> = { 50: 0.92, 100: 0.82, 200: 0.64, 300: 0.45, 400: 0.22 };
  const darken: Record<number, number> = { 600: 0.16, 700: 0.32, 800: 0.46, 900: 0.58, 950: 0.72 };
  const lightText: Record<number, number> = { 100: 0.55, 200: 0.45, 300: 0.32, 400: 0.22 };
  const out: Record<string, string> = {};
  for (const s of SHADES) {
    let rgb = base;
    if (mode === "light" && lightText[s] !== undefined) rgb = mix(base, black, lightText[s]);
    else if (lighten[s] !== undefined) rgb = mix(base, white, lighten[s]);
    else if (darken[s] !== undefined) rgb = mix(base, black, darken[s]);
    out[`--color-amber-${s}`] = toHex(rgb);
  }
  return out;
}

/** Black or white text on the accent, whichever reads better. */
const onAccent = (accent: string) => {
  const [r, g, b] = hex(accent).map((v) => v / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? "#090D14" : "#FFFFFF";
};

function apply({ mode, accent, logo }: Cached) {
  const root = document.documentElement;
  root.classList.toggle("dark", mode === "dark");
  root.classList.toggle("light", mode === "light");
  const vars = accent ? accentPalette(accent, mode) : {};
  for (const s of SHADES) {
    const k = `--color-amber-${s}`;
    if (vars[k]) root.style.setProperty(k, vars[k]);
    else root.style.removeProperty(k);
  }
  for (const k of ["--primary", "--ring", "--sidebar-primary", "--sidebar-ring", "--chart-1"]) {
    if (accent) root.style.setProperty(k, accent);
    else root.style.removeProperty(k);
  }
  if (accent) {
    root.style.setProperty("--primary-foreground", onAccent(accent));
    root.style.setProperty("--sidebar-primary-foreground", onAccent(accent));
  } else {
    root.style.removeProperty("--primary-foreground");
    root.style.removeProperty("--sidebar-primary-foreground");
  }
  let icon = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
  if (!icon) {
    icon = document.createElement("link");
    icon.rel = "icon";
    document.head.appendChild(icon);
  }
  icon.href = logo || DEFAULT_FAVICON;
}

// The cache holds only display preferences (dark/light, accent colour, public logo URL) — no tokens or personal data.
function readCache(): Cached | null {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "null") as Cached | null;
  } catch (err) {
    console.warn("Saved theme was unreadable; using the default look.", err);
    localStorage.removeItem(KEY);
    return null;
  }
}

export function applyBranding(b: Branding) {
  const c: Cached = { mode: b.mode, accent: b.accent, logo: b.logo_url };
  localStorage.setItem(KEY, JSON.stringify(c));
  apply(c);
}

/** Before first paint: re-apply the last theme on this device so there's no dark→light flash. */
export function applyCachedTheme() {
  const c = readCache();
  if (c) apply(c);
}

/** Signed-out pages (login/sign-up) use the Salvage Pulse brand but keep the device's dark/light choice. */
export function resetBrandingKeepMode() {
  apply({ mode: readCache()?.mode ?? "dark", accent: "", logo: "" });
}

export const ACCENT_PRESETS = [
  { name: "Salvage Pulse blue", hex: "" },
  { name: "Safety orange", hex: "#F97316" },
  { name: "Signal red", hex: "#EF4444" },
  { name: "Highway green", hex: "#22C55E" },
  { name: "Teal", hex: "#14B8A6" },
  { name: "Sky blue", hex: "#0EA5E9" },
  { name: "Amber", hex: "#F59E0B" },
  { name: "Steel", hex: "#64748B" },
];
