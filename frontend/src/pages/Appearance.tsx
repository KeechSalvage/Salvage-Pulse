import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ImagePlus, Loader2, Moon, Sun, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Overline, PageHeader, Panel } from "@/components/common";
import BrandLogo from "@/components/BrandLogo";
import { apiDelete, apiPut, apiUpload, errorMessage } from "@/lib/api";
import { useBranding, useSetMyMode } from "@/lib/branding";
import { useMe } from "@/lib/hooks";
import { ACCENT_PRESETS, applyBranding } from "@/lib/theme";
import { cn } from "@/lib/utils";
import type { Branding, BrandingUpdate } from "@/lib/types";

/** Everyone: this user's own light/dark choice, saved to the account. */
function MyThemePanel({ b }: { b: Branding }) {
  const set = useSetMyMode();
  return (
    <Panel className="mb-6" testId="my-theme-panel">
      <Overline>My appearance</Overline>
      <p className="mt-1 max-w-2xl text-sm text-slate-400">
        Pick light or dark for yourself. This follows your account on every device. The company accent colour is set by the owner.
      </p>

      <p className="mt-5 font-mono text-[11px] uppercase tracking-wider text-slate-500">My mode</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {(["dark", "light"] as const).map((m) => (
          <button
            key={m}
            type="button"
            data-testid={`my-theme-mode-${m}`}
            disabled={set.isPending}
            onClick={() => set.mutate(m)}
            className={cn(
              "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors duration-150",
              b.mode === m ? "border-amber-500 bg-amber-500/10 text-white" : "border-border text-slate-300 hover:border-slate-500",
            )}
          >
            {m === "dark" ? <Moon className="size-4" /> : <Sun className="size-4" />}
            {m === "dark" ? "Dark" : "Light"}
          </button>
        ))}
      </div>
    </Panel>
  );
}

/** Owner: the company logo and accent colour. */
export default function Appearance() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const isOwner = me?.role === "owner";
  const { data: b } = useBranding();
  const [accent, setAccent] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // Sync the owner form from the saved company accent.
  const savedAccent = b?.yard_accent;
  useEffect(() => {
    if (savedAccent !== undefined) setAccent(savedAccent);
  }, [savedAccent]);

  // Live preview of the company accent in this owner's own light/dark mode.
  useEffect(() => {
    if (!b || !isOwner) return;
    applyBranding({ ...b, accent, mode: b.mode });
  }, [accent, b, isOwner]);

  const saved = (msg: string) => (r: Branding) => {
    qc.setQueryData(["branding"], r);
    toast.success(msg);
  };
  const save = useMutation({
    mutationFn: () => apiPut<Branding>("/branding", { accent } satisfies BrandingUpdate),
    onSuccess: saved("Company accent saved — your whole team sees it now"),
    onError: (e) => toast.error(errorMessage(e, "Couldn't save")),
  });
  const upload = useMutation({
    mutationFn: (f: File) => {
      const form = new FormData();
      form.append("file", f);
      return apiUpload<Branding>("/branding/logo", form);
    },
    onSuccess: saved("Logo uploaded"),
    onError: (e) => toast.error(errorMessage(e, "Upload failed")),
  });
  const remove = useMutation({
    mutationFn: () => apiDelete<Branding>("/branding/logo"),
    onSuccess: saved("Logo removed — showing the Salvage Pulse logo"),
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!b) return null;
  const dirty = accent !== b.yard_accent;

  return (
    <>
      <PageHeader overline="Settings" title="Appearance" />
      <MyThemePanel b={b} />
      {isOwner && (
        <>
          <div className="mb-3">
            <Overline>Company branding</Overline>
            <p className="mt-1 text-sm text-slate-400">The logo and accent colour everyone sees. Staff still choose their own light or dark mode.</p>
          </div>
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        <Panel className="xl:col-span-5" testId="appearance-logo-panel">
          <Overline>Company logo</Overline>
          <p className="mt-1 text-sm text-slate-400">Shown in the sidebar, the top bar on phones, the browser tab and your daily and watchlist emails.</p>
          <div className="mt-5 flex items-center gap-5">
            <div className="grid h-24 w-40 place-items-center rounded-xl border border-dashed border-slate-700 bg-surface p-3">
              <BrandLogo branding={b} className="max-h-16 w-auto" testId="appearance-logo-preview" />
            </div>
            <div className="flex flex-col gap-2">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                data-testid="appearance-logo-input"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) upload.mutate(f);
                  e.target.value = "";
                }}
              />
              <Button data-testid="appearance-logo-upload" disabled={upload.isPending} onClick={() => fileRef.current?.click()}>
                {upload.isPending ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-4" />} {b.logo_url ? "Replace logo" : "Upload logo"}
              </Button>
              {b.logo_url && (
                <Button variant="ghost" data-testid="appearance-logo-remove" disabled={remove.isPending} onClick={() => remove.mutate()}>
                  <Trash2 className="size-4" /> Remove
                </Button>
              )}
              <p className="text-xs text-slate-500">PNG, JPG or WebP, under 1 MB. A wide logo on a transparent background looks best.</p>
            </div>
          </div>
        </Panel>

        <Panel className="xl:col-span-7" testId="appearance-theme-panel">
          <Overline>Company accent colour</Overline>
          <p className="mt-1 text-sm text-slate-400">Only the owner can change this. It applies to everyone; staff still choose their own light or dark mode in My appearance above.</p>
          <div className="mt-4 flex flex-wrap items-center gap-2.5">
            {ACCENT_PRESETS.map((p) => (
              <button
                key={p.name}
                type="button"
                title={p.name}
                data-testid={`appearance-accent-${p.name.toLowerCase().replace(/\s+/g, "-")}`}
                onClick={() => setAccent(p.hex)}
                style={{ backgroundColor: p.hex || "#3A6AF0" }}
                className={cn("grid size-9 place-items-center rounded-full ring-offset-2 ring-offset-card transition-transform duration-150 hover:scale-110", accent === p.hex && "ring-2 ring-white")}
              >
                {accent === p.hex && <Check className="size-4 text-black/80" />}
              </button>
            ))}
            <label className="ml-1 flex items-center gap-2 rounded-full border border-border py-1 pl-1 pr-3 text-sm text-slate-400" title="Pick any colour">
              <input
                type="color"
                data-testid="appearance-accent-custom"
                value={accent || "#3A6AF0"}
                onChange={(e) => setAccent(e.target.value.toUpperCase())}
                className="size-7 cursor-pointer rounded-full border-0 bg-transparent p-0"
              />
              Custom <span className="font-mono text-xs">{accent || "#3A6AF0"}</span>
            </label>
          </div>

          <div className="mt-6 rounded-xl border border-border bg-surface p-4" data-testid="appearance-preview">
            <p className="font-mono text-[10px] uppercase tracking-wider text-slate-500">Preview</p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button size="sm">Primary button</Button>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 font-mono text-xs text-amber-300">Badge</span>
              <span className="text-sm text-amber-400">Highlighted text</span>
              <span className="h-2 w-24 overflow-hidden rounded-full bg-slate-800">
                <span className="block h-full w-2/3 rounded-full bg-amber-500" />
              </span>
            </div>
          </div>

          <div className="mt-6 flex items-center gap-3">
            <Button data-testid="appearance-save" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
              {save.isPending && <Loader2 className="size-4 animate-spin" />} Save for the whole yard
            </Button>
            {dirty && (
              <Button variant="ghost" data-testid="appearance-reset" onClick={() => setAccent(b.yard_accent)}>
                Undo changes
              </Button>
            )}
          </div>
        </Panel>
          </div>
        </>
      )}
    </>
  );
}
