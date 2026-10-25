import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Car, Check, Loader2, Pencil } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { apiPatch, errorMessage } from "@/lib/api";
import type { CallSummary, VehicleUpdate } from "@/lib/types";

/** Year / make / model (+ part) on a call — AI fills it from the transcript; reps and managers can correct it. */
export default function VehicleEditor({ call }: { call: CallSummary }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ year: "", make: "", model: "", part: "" });
  const save = useMutation({
    mutationFn: () =>
      apiPatch<CallSummary>(`/calls/${call.id}/vehicle`, {
        vehicle_year: f.year ? Number(f.year) : null,
        vehicle_make: f.make,
        vehicle_model: f.model,
        part_requested: f.part,
      } satisfies VehicleUpdate),
    onSuccess: () => {
      toast.success("Vehicle saved");
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["call", call.id] });
      qc.invalidateQueries({ queryKey: ["vehicles"] });
    },
    onError: (e) => toast.error(errorMessage(e, "Enter a year between 1960 and 2035")),
  });
  const label = [call.vehicle_year, call.vehicle_make, call.vehicle_model].filter(Boolean).join(" ") || call.vehicle;

  if (!open)
    return (
      <button
        type="button"
        data-testid="call-vehicle-edit-button"
        onClick={() => {
          setF({ year: call.vehicle_year ? String(call.vehicle_year) : "", make: call.vehicle_make, model: call.vehicle_model, part: call.part_requested });
          setOpen(true);
        }}
        className="flex items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 font-mono text-xs text-slate-300 transition-colors duration-150 hover:border-amber-500/60 hover:text-amber-200"
      >
        <Car className="size-3.5" />
        <span data-testid="call-vehicle">{label || "Add vehicle"}</span>
        {call.part_requested && <span className="text-slate-500">· {call.part_requested}</span>}
        <Pencil className="size-3 text-slate-500" />
      </button>
    );
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      data-testid="call-vehicle-form"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Input data-testid="vehicle-year-input" value={f.year} onChange={(e) => setF({ ...f, year: e.target.value.replace(/\D/g, "").slice(0, 4) })} placeholder="Year" className="h-8 w-20" />
      <Input data-testid="vehicle-make-input" value={f.make} onChange={(e) => setF({ ...f, make: e.target.value })} placeholder="Make" className="h-8 w-28" />
      <Input data-testid="vehicle-model-input" value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} placeholder="Model" className="h-8 w-32" />
      <Input data-testid="vehicle-part-input" value={f.part} onChange={(e) => setF({ ...f, part: e.target.value })} placeholder="Part" className="h-8 w-32" />
      <button type="submit" data-testid="vehicle-save-button" disabled={save.isPending} className="rounded-md bg-amber-500 p-1.5 text-black transition-opacity duration-150 hover:opacity-90">
        {save.isPending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
      </button>
    </form>
  );
}
