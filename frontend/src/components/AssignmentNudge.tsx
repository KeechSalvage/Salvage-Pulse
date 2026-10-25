import { Link } from "react-router-dom";
import { useFeatureOpen } from "@/components/PremiumGate";
import { useQuery } from "@tanstack/react-query";
import { AlarmClock } from "lucide-react";
import { apiGet } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Assignment } from "@/lib/types";

export const useAssignments = (enabled = true) => {
  const open = useFeatureOpen("roleplay", enabled); // Pro and up
  return useQuery({ queryKey: ["roleplay-assignments"], queryFn: () => apiGet<Assignment[]>("/roleplay/assignments"), enabled: enabled && open });
};

/** Rep dashboard: overdue / open role-play assignments with a link to practise. */
export default function AssignmentNudge() {
  const { data } = useAssignments();
  const todo = (data ?? []).filter((a) => a.status !== "done");
  if (!todo.length) return null;
  const overdue = todo.filter((a) => a.status === "overdue");
  const hot = overdue.length > 0;
  return (
    <Link
      to="/roleplay"
      data-testid="assignment-nudge"
      className={cn(
        "mb-6 flex items-center gap-4 rounded-xl border p-4 transition-[border-color,transform] duration-150 hover:-translate-y-0.5",
        hot ? "border-red-500/50 bg-red-500/10 hover:border-red-400" : "border-sky-500/40 bg-sky-500/10 hover:border-sky-400",
      )}
    >
      <span className={cn("grid size-10 place-items-center rounded-full", hot ? "bg-red-500/20" : "bg-sky-500/20")}>
        <AlarmClock className={cn("size-5", hot ? "text-red-300" : "text-sky-300")} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-white" data-testid="assignment-nudge-title">
          {hot ? `${overdue.length} overdue role-play${overdue.length === 1 ? "" : "s"}` : `${todo.length} role-play${todo.length === 1 ? "" : "s"} to practise`}
        </p>
        <p className="truncate text-xs text-slate-400">
          {todo
            .slice(0, 3)
            .map((a) => `${a.scenario_title} (score ${a.pass_score}+ by ${new Date(`${a.due_date}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })})`)
            .join(" · ")}
        </p>
      </div>
      <span className={cn("rounded-full px-3 py-1 font-mono text-xs font-semibold", hot ? "bg-red-500 text-white" : "bg-sky-500 text-black")}>Practise</span>
    </Link>
  );
}
