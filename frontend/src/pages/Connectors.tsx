import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Loader2, Phone, RefreshCw, Webhook } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Overline, PageHeader, Panel, fmtDate } from "@/components/common";
import { apiDelete, apiGet, apiPost, errorMessage } from "@/lib/api";
import type { AuthUrl, ConnectorStatus, SyncResult } from "@/lib/types";

const SAMPLE = `{
  "call_id": "abc-123",
  "start_time": "2026-10-23T14:05:00Z",
  "direction": "inbound",
  "from": "+18605550123",
  "caller_name": "Ridgeline Collision",
  "agent_email": "tyler@yourdomain.com",
  "duration": 184,
  "result": "Accepted",
  "recording_url": "https://…",
  "transcript": "optional — if sent, AI scores the call"
}`;

export default function Connectors() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const { data } = useQuery({ queryKey: ["connectors"], queryFn: () => apiGet<ConnectorStatus>("/connect/status") });
  const refresh = () => qc.invalidateQueries({ queryKey: ["connectors"] });
  useEffect(() => {
    const r = params.get("ringcentral");
    if (r) {
      if (r === "connected") toast.success("RingCentral connected — click Sync now to pull the last 30 days");
      else toast.error("RingCentral connection was cancelled");
      setParams({}, { replace: true });
    }
  }, [params, setParams]);
  const connect = useMutation({
    mutationFn: () => apiGet<AuthUrl>("/connect/ringcentral/start"),
    onSuccess: (r) => window.location.assign(r.authorize_url),
    onError: (e) => toast.error(errorMessage(e, "Couldn't start RingCentral sign-in")),
  });
  const sync = useMutation({
    mutationFn: () => apiPost<SyncResult>("/connect/ringcentral/sync"),
    onSuccess: (r) => {
      toast.success(`Synced: ${r.imported} new calls, ${r.updated} updated`);
      refresh();
      qc.invalidateQueries({ queryKey: ["overview"] });
    },
    onError: (e) => toast.error(errorMessage(e, "Sync failed")),
  });
  const disconnect = useMutation({ mutationFn: () => apiDelete<ConnectorStatus>("/connect/ringcentral"), onSuccess: refresh });
  const rotate = useMutation({
    mutationFn: () => apiPost<ConnectorStatus>("/connect/webhook/rotate"),
    onSuccess: () => {
      toast.success("New webhook link created — the old one stops working");
      refresh();
    },
  });
  const rc = data?.ringcentral;
  const copy = (t: string) => navigator.clipboard.writeText(t).then(() => toast.success("Copied"));

  return (
    <>
      <PageHeader overline="Integrations" title="Phone connectors" />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Panel testId="ringcentral-panel">
          <Overline>RingCentral</Overline>
          <h3 className="mt-1 flex items-center gap-2 text-xl font-bold text-white">
            <Phone className="size-5 text-sky-400" /> Automatic call sync
          </h3>
          <p className="mt-2 text-sm text-slate-400">
            Sign in with a RingCentral admin account once. New calls (who, when, direction, duration, result, recording) sync every 30 minutes, and reps are matched by name.
          </p>
          {rc && !rc.configured && (
            <p data-testid="ringcentral-not-configured" className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
              RingCentral isn't switched on for the platform yet. Until then, use the webhook or upload a RingCentral export on the Upload Call page.
            </p>
          )}
          {rc?.connected ? (
            <div className="mt-4 space-y-3">
              <p data-testid="ringcentral-connected" className="text-sm text-emerald-300">
                Connected by {rc.connected_by}. {rc.last_sync_at ? `Last sync ${fmtDate(rc.last_sync_at)} — ${rc.last_result}` : rc.last_result}
              </p>
              <div className="flex gap-3">
                <Button data-testid="ringcentral-sync-button" disabled={sync.isPending} onClick={() => sync.mutate()}>
                  {sync.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Sync now
                </Button>
                <Button variant="ghost" data-testid="ringcentral-disconnect-button" onClick={() => disconnect.mutate()}>
                  Disconnect
                </Button>
              </div>
            </div>
          ) : (
            <Button className="mt-4" data-testid="ringcentral-connect-button" disabled={!rc?.configured || connect.isPending} onClick={() => connect.mutate()}>
              {connect.isPending && <Loader2 className="size-4 animate-spin" />} Connect RingCentral
            </Button>
          )}
        </Panel>

        <Panel testId="webhook-panel">
          <Overline>Any phone system</Overline>
          <h3 className="mt-1 flex items-center gap-2 text-xl font-bold text-white">
            <Webhook className="size-5 text-sky-400" /> Universal webhook
          </h3>
          <p className="mt-2 text-sm text-slate-400">
            Zoom Phone, Dialpad, 8x8, Aircall, Nextiva, 3CX, Zapier or Make: send each finished call as JSON (one call, a list, or {"{ calls: [...] }"}) to this private link. Common field names are recognised automatically.
          </p>
          {data && (
            <div className="mt-4 flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
              <code data-testid="webhook-url" className="flex-1 truncate font-mono text-xs text-slate-200">{data.webhook_url}</code>
              <button data-testid="webhook-copy-button" onClick={() => copy(data.webhook_url)} className="text-slate-400 hover:text-white" title="Copy link">
                <Copy className="size-4" />
              </button>
            </div>
          )}
          <Button variant="ghost" size="sm" className="mt-2" data-testid="webhook-rotate-button" onClick={() => rotate.mutate()}>
            Create a new link
          </Button>
          <p className="mt-3 font-mono text-[11px] uppercase tracking-wider text-slate-500">Example body (POST, JSON)</p>
          <pre className="mt-1 max-h-60 overflow-auto rounded-lg bg-surface p-3 font-mono text-[11px] text-slate-300">{SAMPLE}</pre>
        </Panel>
      </div>
    </>
  );
}
