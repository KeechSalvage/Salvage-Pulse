import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { apiGet } from "@/lib/api";
import { cn } from "@/lib/utils";

export function usePartCatalog() {
  return useQuery({ queryKey: ["parts", "catalog"], queryFn: () => apiGet<string[]>("/parts/catalog"), staleTime: 60 * 60_000 });
}

/** Dropdown with a search box: tick every part type that was sold. */
export function PartsPicker({ value, onChange, testId }: { value: string[]; onChange: (v: string[]) => void; testId: string }) {
  const { data } = usePartCatalog();
  const [q, setQ] = useState("");
  const safeVal = value ?? [];
  const shown = (data ?? []).filter((p) => p.toLowerCase().includes(q.trim().toLowerCase()));
  const toggle = (p: string) => onChange(safeVal.includes(p) ? safeVal.filter((x) => x !== p) : [...safeVal, p]);
  return (
    <Popover>
      <PopoverTrigger
        data-testid={testId}
        className="flex h-9 min-w-44 max-w-full items-center gap-2 rounded-md border border-border bg-surface px-3 text-left text-sm text-white transition-colors duration-150 hover:border-slate-500"
      >
        <span className={cn("min-w-0 flex-1 truncate", !safeVal.length && "text-slate-500")}>{safeVal.length ? safeVal.join(", ") : "Part types sold"}</span>
        <ChevronDown className="size-3.5 shrink-0 text-slate-400" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-2">
        <Input autoFocus data-testid={`${testId}-search`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search parts…" className="h-8" />
        <ul className="max-h-60 overflow-y-auto" data-testid={`${testId}-options`}>
          {shown.map((p) => {
            const on = safeVal.includes(p);
            return (
              <li key={p}>
                <button
                  type="button"
                  data-testid={`${testId}-option-${p.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
                  onClick={() => toggle(p)}
                  className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors duration-100 hover:bg-slate-800", on ? "text-white" : "text-slate-300")}
                >
                  <span className={cn("grid size-4 place-items-center rounded border", on ? "border-emerald-400 bg-emerald-500/20" : "border-slate-600")}>
                    {on && <Check className="size-3 text-emerald-300" />}
                  </span>
                  {p}
                </button>
              </li>
            );
          })}
          {shown.length === 0 && <li className="px-2 py-1.5 text-xs text-slate-500">No part matches “{q}”.</li>}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/** Sold price box + part types dropdown + save. Used wherever "Sold" is a choice. */
export function SaleForm({
  price, parts, onSave, onCancel, saving, saveLabel = "Save sale", testPrefix, requirePrice = false,
}: {
  price: number | null;
  parts: string[];
  onSave: (price: number | null, parts: string[]) => void;
  onCancel?: () => void;
  saving?: boolean;
  saveLabel?: string;
  testPrefix: string;
  requirePrice?: boolean;
}) {
  const [val, setVal] = useState(price ? String(price) : "");
  const [picked, setPicked] = useState(parts ?? []);
  const num = val.trim() ? Number(val) : null;
  const bad = num !== null && (!Number.isFinite(num) || num < 0 || num > 100000);
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!bad) onSave(num, picked);
      }}
    >
      <div className="relative">
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-slate-500">$</span>
        <Input
          data-testid={`${testPrefix}-price`}
          inputMode="decimal"
          value={val}
          onChange={(e) => setVal(e.target.value.replace(/[^0-9.]/g, ""))}
          placeholder="Sold price"
          className={cn("h-9 w-32 pl-6", bad && "border-red-500")}
        />
      </div>
      <PartsPicker value={picked} onChange={setPicked} testId={`${testPrefix}-parts`} />
      <Button size="sm" type="submit" data-testid={`${testPrefix}-save`} disabled={bad || saving || (requirePrice && !num)}>{saveLabel}</Button>
      {onCancel && (
        <Button size="sm" variant="ghost" type="button" data-testid={`${testPrefix}-cancel`} onClick={onCancel}><X className="size-3.5" /></Button>
      )}
    </form>
  );
}
