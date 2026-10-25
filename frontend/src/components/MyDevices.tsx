import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, LogOut, MonitorSmartphone, Pencil, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/common";
import { apiDelete, apiGet, apiPatch, errorMessage } from "@/lib/api";
import type { DeviceNickname, ForgetDeviceResult, StaffDevice } from "@/lib/types";

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "before tracking began");

/** Settings → Devices: the manager's remembered browsers, each with "Sign out". */
export default function MyDevices() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["my-devices"], queryFn: () => apiGet<StaffDevice[]>("/auth/devices") });
  const [editing, setEditing] = useState("");
  const [name, setName] = useState("");
  const rename = useMutation({
    mutationFn: ({ id, nickname }: { id: string; nickname: string }) => apiPatch<StaffDevice[]>(`/auth/devices/${id}`, { nickname } satisfies DeviceNickname),
    onSuccess: (d, v) => {
      qc.setQueryData(["my-devices"], d);
      setEditing("");
      toast.success(v.nickname.trim() ? `Renamed to "${v.nickname.trim()}"` : "Nickname cleared");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => apiDelete<ForgetDeviceResult>(`/auth/devices/${id}`),
    onSuccess: (r) => {
      if (r.you) {
        window.location.assign("/login");
        return;
      }
      qc.setQueryData(["my-devices"], r.devices);
      toast.success("Device signed out — signing in from it again will email you");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <div className="max-w-4xl" data-testid="my-devices-page">
      <h2 className="mb-1 font-heading text-2xl font-bold text-white">Devices</h2>
      <p className="mb-4 text-sm text-slate-400">
        Browsers your account has signed in from. Don't recognise one? Sign it out, then change your password. We email you whenever a new browser signs in.
      </p>
      <Panel testId="my-devices-panel">
        <div className="mb-3 flex items-center gap-2 text-slate-300">
          <MonitorSmartphone className="size-5 text-sky-300" />
          <span data-testid="my-devices-count" className="font-mono text-xs uppercase tracking-wider text-slate-400">
            {data ? `${data.length} remembered browser${data.length === 1 ? "" : "s"}` : "Loading…"}
          </span>
        </div>
        {isLoading ? null : !data?.length ? (
          <p data-testid="my-devices-empty" className="text-sm text-slate-500">No remembered browsers yet — they appear after your next sign-in.</p>
        ) : (
          <ul className="divide-y divide-border">
            {data.map((d) => (
              <li key={d.id} data-testid={`my-device-${d.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3 transition-colors duration-150 hover:bg-white/[0.02]">
                <div className="mr-auto min-w-0">
                  {editing === d.id ? (
                    <form
                      className="mb-1 flex items-center gap-1.5"
                      onSubmit={(e) => {
                        e.preventDefault();
                        rename.mutate({ id: d.id, nickname: name });
                      }}
                    >
                      <Input autoFocus maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder='e.g. "Office PC" or "My iPhone"' data-testid={`my-device-nickname-input-${d.id}`} className="h-8 w-56" />
                      <Button type="submit" size="icon" variant="ghost" aria-label="Save nickname" data-testid={`my-device-nickname-save-${d.id}`} disabled={rename.isPending}><Check className="size-4 text-emerald-300" /></Button>
                      <Button type="button" size="icon" variant="ghost" aria-label="Cancel" data-testid={`my-device-nickname-cancel-${d.id}`} onClick={() => setEditing("")}><X className="size-4" /></Button>
                    </form>
                  ) : (
                  <p className="font-medium text-white" data-testid={`my-device-browser-${d.id}`}>
                    {d.nickname || d.browser}
                    {d.nickname && <span data-testid={`my-device-real-${d.id}`} className="ml-2 text-xs font-normal text-slate-400">{d.browser}</span>}
                    <button type="button" aria-label="Rename device" data-testid={`my-device-rename-${d.id}`} onClick={() => (setEditing(d.id), setName(d.nickname))}
                      className="ml-2 inline-flex rounded p-1 align-middle text-slate-500 transition-colors duration-150 hover:bg-white/5 hover:text-amber-300">
                      <Pencil className="size-3.5" />
                    </button>
                    {d.this_browser && (
                      <span data-testid={`my-device-this-${d.id}`} className="ml-2 rounded bg-sky-500/15 px-1.5 py-0.5 align-middle text-[10px] uppercase text-sky-300">
                        this browser
                      </span>
                    )}
                  </p>
                  )}
                  <p className="font-mono text-xs text-slate-500">
                    {d.ip || "IP unknown"} · first {when(d.first_seen)} · last {when(d.last_seen)}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant={d.this_browser ? "outline" : "destructive"}
                  data-testid={`my-device-sign-out-${d.id}`}
                  disabled={remove.isPending}
                  onClick={() =>
                    window.confirm(d.this_browser ? "Sign out this browser? You'll go back to the sign-in page." : `Sign out ${d.nickname || d.browser}? It's signed out right away.`) && remove.mutate(d.id)
                  }
                >
                  <LogOut className="size-4" /> Sign out
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
