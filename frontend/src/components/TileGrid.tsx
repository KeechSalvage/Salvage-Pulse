import { Fragment, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, LayoutGrid, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { apiDelete, apiGet, apiPut, errorMessage } from "@/lib/api";
import { useMe } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import type { LayoutTarget, TileLayout, TileLayoutSave } from "@/lib/types";

export interface TileDef {
  id: string; // stable kebab-case id saved in layouts
  label: string; // shown while arranging
  span?: string; // grid column classes, e.g. "xl:col-span-7"
  node: ReactNode;
}

/** Saved order first (unknown ids dropped), then any tiles the saved layout doesn't know yet, in default order. */
function applyOrder(tiles: TileDef[], order: string[]): TileDef[] {
  const byId = new Map(tiles.map((t) => [t.id, t]));
  const head = order.map((id) => byId.get(id)).filter((t): t is TileDef => !!t);
  const seen = new Set(head.map((t) => t.id));
  return [...head, ...tiles.filter((t) => !seen.has(t.id))];
}

/**
 * Arrangeable tiles. Everyone sees their layout (own → yard → default); managers get "Arrange tiles":
 * drag to reorder, choose who it applies to (whole yard or one person), save or reset.
 */
export default function TileGrid({ page, tiles, className, label = "tiles", selfArrange = false }: { page: string; tiles: TileDef[]; className: string; label?: string; selfArrange?: boolean }) {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const self = selfArrange && me?.role === "rep"; // reps arrange only their own copy
  const isManager = me?.role === "manager" || self;
  const layout = useQuery({ queryKey: ["layouts", page], queryFn: () => apiGet<TileLayout>(`/layouts/${page}`), staleTime: 60_000 });
  const [arranging, setArranging] = useState(false);
  const [pickedTarget, setTarget] = useState("yard");
  const target = self && me ? me.id : pickedTarget;
  const [draft, setDraft] = useState<string[] | null>(null);
  const targets = useQuery({ queryKey: ["layouts", page, "targets"], queryFn: () => apiGet<LayoutTarget[]>(`/layouts-targets/${page}`), enabled: arranging && isManager && !self });
  const targetLayout = useQuery({
    queryKey: ["layouts", page, "as", target],
    queryFn: () => apiGet<TileLayout>(`/layouts/${page}?as=${encodeURIComponent(target)}`),
    enabled: arranging && isManager,
  });

  const baseOrder = arranging ? (targetLayout.data?.order ?? []) : (layout.data?.order ?? []);
  const ordered = useMemo(() => applyOrder(tiles, draft ?? baseOrder), [tiles, draft, baseOrder]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const done = () => {
    setArranging(false);
    setDraft(null);
    qc.invalidateQueries({ queryKey: ["layouts", page] });
  };
  const save = useMutation({
    mutationFn: () => apiPut<TileLayout>(`/layouts/${page}`, { order: ordered.map((t) => t.id), target } satisfies TileLayoutSave),
    onSuccess: () => {
      toast.success(self ? "Your layout is saved" : target === "yard" ? "Layout saved for everyone" : `Layout saved for ${targets.data?.find((t) => t.target === target)?.name ?? "them"}`);
      done();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const reset = useMutation({
    mutationFn: () => apiDelete<TileLayout>(`/layouts/${page}?target=${encodeURIComponent(target)}`),
    onSuccess: () => {
      toast.success(target === "yard" ? "Back to the standard layout" : self ? "Back to your manager's layout" : "They now follow the yard layout");
      setDraft(null);
      qc.invalidateQueries({ queryKey: ["layouts", page] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const ids = ordered.map((t) => t.id);
    setDraft(arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id))));
  };

  return (
    <>
      {isManager && (
        <div className={cn("mb-3 mt-4 flex flex-wrap items-center justify-end gap-2", arranging && "sticky top-2 z-30 rounded-xl border border-sky-500/40 bg-card/95 p-3 shadow-lg backdrop-blur")} data-testid={`tiles-toolbar-${page}`}>
          {!arranging ? (
            <button
              type="button"
              data-testid={`tiles-arrange-${page}`}
              onClick={() => setArranging(true)}
              className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs text-slate-400 transition-colors duration-150 hover:border-sky-500/60 hover:text-white"
            >
              <LayoutGrid className="size-3.5" /> Arrange {label}
            </button>
          ) : (
            <>
              <p className="mr-auto text-sm text-slate-200">Drag {label} into the order you want.</p>
              {!self && <label className="flex items-center gap-2 text-xs text-slate-400">
                Applies to
                <select
                  data-testid={`tiles-target-${page}`}
                  value={target}
                  onChange={(e) => (setTarget(e.target.value), setDraft(null))}
                  className="h-8 rounded-md border border-border bg-surface px-2 text-sm text-white"
                >
                  {(targets.data ?? [{ target: "yard", name: "Everyone in the yard", role: "", has_custom: false }]).map((t) => (
                    <option key={t.target} value={t.target}>
                      {t.name}{t.role ? ` (${t.role})` : ""}{t.has_custom ? " · custom" : ""}
                    </option>
                  ))}
                </select>
              </label>}
              <Button size="sm" variant="ghost" data-testid={`tiles-reset-${page}`} disabled={reset.isPending} onClick={() => reset.mutate()}>
                <RotateCcw className="size-3.5" /> Reset
              </Button>
              <Button size="sm" variant="outline" data-testid={`tiles-cancel-${page}`} onClick={done}>Cancel</Button>
              <Button size="sm" data-testid={`tiles-save-${page}`} disabled={save.isPending} onClick={() => save.mutate()}>Save layout</Button>
            </>
          )}
        </div>
      )}
      {arranging ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={ordered.map((t) => t.id)} strategy={rectSortingStrategy}>
            <div className={className} data-testid={`tiles-${page}`}>
              {ordered.map((t) => <SortableTile key={t.id} tile={t} />)}
            </div>
          </SortableContext>
        </DndContext>
      ) : (
        <div className={className} data-testid={`tiles-${page}`}>
          {ordered.map((t) => (
            <Fragment key={t.id}>
              <div data-tile={t.id} className={cn(t.span, "min-w-0 empty:hidden [&>*]:h-full")}>{t.node}</div>
            </Fragment>
          ))}
        </div>
      )}
    </>
  );
}

function SortableTile({ tile }: { tile: TileDef }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tile.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-testid={`tile-drag-${tile.id}`}
      className={cn(tile.span, "relative min-w-0 touch-none rounded-xl", isDragging ? "z-20 opacity-90 ring-2 ring-sky-400" : "outline-2 outline-dashed outline-sky-500/40")}
      {...attributes}
      {...listeners}
    >
      <div className="absolute inset-x-0 top-0 z-10 flex cursor-grab items-center gap-2 rounded-t-xl bg-sky-500/90 px-3 py-1.5 text-xs font-medium text-white active:cursor-grabbing">
        <GripVertical className="size-4" /> {tile.label}
      </div>
      <div className="pointer-events-none max-h-[220px] min-h-[64px] overflow-hidden opacity-60 [&>*]:h-full">{tile.node}</div>
    </div>
  );
}
