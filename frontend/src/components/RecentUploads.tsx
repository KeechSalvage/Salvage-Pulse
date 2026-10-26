import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { FileAudio, FileText, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Overline, Panel } from "@/components/common";
import { apiDelete, apiGet, errorMessage } from "@/lib/api";
import { useMe } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import type { RecentUpload } from "@/lib/types";
import { isManagerLike } from "@/lib/types";

const when = (s: string) => new Date(s).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const STATUS: Record<string, string> = { processing: "text-sky-300", analyzed: "text-emerald-300", failed: "text-red-300" };

/** Upload Call page: the last 5 uploads (reps: their own; managers: the yard's), each removable (restorable for 7 days). */
export default function RecentUploads() {
  const qc = useQueryClient();
  const isManager = isManagerLike(useMe().data?.role);
  const { data } = useQuery({
    queryKey: ["calls", "uploads", "recent"],
    queryFn: () => apiGet<RecentUpload[]>("/calls/uploads/recent"),
    refetchInterval: (q) => (q.state.data?.some((u) => u.status === "processing") ? 4000 : false),
  });
  const remove = useMutation({
    mutationFn: (u: RecentUpload) => apiDelete(`/calls/uploads/${u.id}`),
    onSuccess: (_, u) => (toast.success(`Removed the call with ${u.customer_name}${isManager ? " — restore it from Clean-up within 7 days" : ""}`), qc.invalidateQueries({ queryKey: ["calls"] }), qc.invalidateQueries({ queryKey: ["overview"] })),
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!data?.length) return null;
  return (
    <Panel testId="recent-uploads" className="mb-6">
      <Overline>{isManager ? "Last 5 uploads in your yard" : "Your last 5 uploads"}</Overline>
      <ul className="mt-3 divide-y divide-border">
        {data.map((u) => {
          const Icon = u.source === "audio" ? FileAudio : FileText;
          return (
            <li key={u.id} data-testid={`recent-upload-${u.id}`} className="flex flex-wrap items-center gap-3 py-2 text-sm">
              <Icon className="size-4 shrink-0 text-slate-500" />
              <Link to={`/calls/${u.id}`} data-testid={`recent-upload-open-${u.id}`} className="font-medium text-white underline-offset-2 hover:underline">{u.customer_name}</Link>
              <span className="text-xs text-slate-500">{u.rep_name}{u.category ? ` · ${u.category}` : ""}</span>
              <span className={cn("flex items-center gap-1 font-mono text-[11px] capitalize", STATUS[u.status] ?? "text-slate-400")}>
                {u.status === "processing" && <Loader2 className="size-3 animate-spin" />}{u.status}
              </span>
              <span className="ml-auto font-mono text-[11px] text-slate-500">{when(u.created_at)}</span>
              <button type="button" aria-label={`Remove the call with ${u.customer_name}`} data-testid={`recent-upload-remove-${u.id}`} disabled={remove.isPending}
                onClick={() => window.confirm(`Remove the uploaded call with ${u.customer_name}?`) && remove.mutate(u)}
                className="rounded p-1 text-slate-500 transition-colors duration-150 hover:bg-red-500/10 hover:text-red-300">
                <Trash2 className="size-4" />
              </button>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
