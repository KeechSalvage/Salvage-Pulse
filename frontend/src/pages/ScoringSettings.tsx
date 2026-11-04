import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  SlidersHorizontal,
  RotateCcw,
  Save,
  CheckCircle2,
  AlertTriangle,
  Info,
  Sparkles,
  Bot,
  Lock,
  MapPin,
} from "lucide-react";
import { apiGet, apiPut } from "@/lib/api";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useSites } from "@/components/Sites";
import type { ScoringSettings } from "@/lib/types";
import { useMe } from "@/lib/hooks";

export default function ScoringSettings() {
  const queryClient = useQueryClient();
  const { data: me } = useMe();
  const canEdit =
    me?.role === "owner" ||
    me?.role === "sales_manager" ||
    me?.role === "manager" ||
    me?.role === "master" ||
    me?.role === "admin";

  const sites = useSites();
  const [siteId, setSiteId] = useState("");
  const { data, isLoading } = useQuery<ScoringSettings>({
    queryKey: ["scoring-settings", siteId],
    queryFn: () => apiGet<ScoringSettings>(`/settings/scoring${siteId ? `?site_id=${encodeURIComponent(siteId)}` : ""}`),
  });

  const [useDefault, setUseDefault] = useState<boolean>(true);
  const [weights, setWeights] = useState<Record<string, number>>({});
  const [criteria, setCriteria] = useState<Record<string, string>>({});
  const [instructions, setInstructions] = useState("");
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const locationName = siteId ? (sites.data?.sites ?? []).find((s) => s.id === siteId)?.name ?? "this location" : "the whole yard";

  useEffect(() => {
    if (data) {
      setUseDefault(!data.custom_scoring);
      setWeights(data.weights || data.defaults);
      setCriteria(data.criteria || data.default_criteria || {});
      setInstructions(data.instructions || "");
    }
  }, [data]);

  const updateMutation = useMutation({
    mutationFn: (body: {
      site_id: string;
      custom_scoring: boolean;
      weights: Record<string, number>;
      criteria: Record<string, string>;
      instructions: string;
    }) => apiPut<ScoringSettings & { recalculated_calls?: number }>("/settings/scoring", body),
    onSuccess: (updated) => {
      queryClient.setQueryData(["scoring-settings", siteId], updated);
      queryClient.invalidateQueries({ queryKey: ["meta"] });
      queryClient.invalidateQueries({ queryKey: ["calls"] });
      queryClient.invalidateQueries({ queryKey: ["analytics"] });
      const count = updated.recalculated_calls ?? 0;
      setSaveSuccess(
        count > 0
          ? `AI evaluation saved for ${locationName}. Recalculated ${count} call${count === 1 ? "" : "s"}.`
          : `AI evaluation saved for ${locationName}.`
      );
      setErrorMessage(null);
      setTimeout(() => setSaveSuccess(null), 4500);
    },
    onError: (err: any) => {
      setErrorMessage(err?.body?.detail || err?.message || "Failed to save scoring weights");
    },
  });

  if (isLoading || !data) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="size-8 animate-spin rounded-full border-4 border-amber-500 border-t-transparent" />
      </div>
    );
  }

  // Calculate current sum of weights if custom
  const currentTotal = useDefault
    ? 100
    : Object.values(weights).reduce((acc, curr) => acc + (Number(curr) || 0), 0);

  const available = 100 - currentTotal;
  const isBalanced = currentTotal === 100;

  const handleWeightChange = (key: string, val: number) => {
    const clamped = Math.max(0, Math.min(100, Math.round(val)));
    setWeights((prev) => ({
      ...prev,
      [key]: clamped,
    }));
  };

  const handleResetToDefaults = () => {
    setWeights(data.defaults);
    setCriteria(data.default_criteria || {});
    setInstructions("");
    setErrorMessage(null);
    updateMutation.mutate({
      site_id: siteId,
      custom_scoring: false,
      weights: data.defaults,
      criteria: data.default_criteria || {},
      instructions: "",
    });
  };

  const handleToggleDefault = (checked: boolean) => {
    if (!canEdit) return;
    setUseDefault(checked);
    setErrorMessage(null);
    if (checked) {
      setCriteria(data.default_criteria || {});
      setInstructions("");
      updateMutation.mutate({
        site_id: siteId,
        custom_scoring: false,
        weights: data.defaults,
        criteria: data.default_criteria || {},
        instructions: "",
      });
    }
  };

  const handleSave = () => {
    if (!useDefault && !isBalanced) {
      setErrorMessage(`Total weight must equal 100%. Currently at ${currentTotal}%.`);
      return;
    }
    setErrorMessage(null);
    updateMutation.mutate({
      site_id: siteId,
      custom_scoring: !useDefault,
      weights,
      criteria,
      instructions,
    });
  };

  return (
    <div className="max-w-4xl space-y-8 pb-12" data-testid="scoring-settings-page">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2">
          <div className="flex size-9 items-center justify-center rounded-lg bg-amber-500/10 text-amber-400">
            <SlidersHorizontal className="size-5" />
          </div>
          <h2 className="font-heading text-2xl font-bold text-white">AI Call Evaluation</h2>
        </div>
        <p className="mt-1 text-sm text-slate-400">
          Customize how much each sales performance category contributes to the 0–100 overall call score and exactly what the AI evaluates.
          Use the yard default, or tailor it to one location without changing any other location or yard.
        </p>
      </div>

      {canEdit && (sites.data?.sites ?? []).length > 1 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4" data-testid="scoring-location-scope">
          <MapPin className="size-4 text-sky-300" />
          <div className="mr-auto">
            <p className="text-sm font-semibold text-white">Evaluation scope</p>
            <p className="text-xs text-slate-400">Choose the whole yard or one location. Other locations and yards keep their own settings.</p>
          </div>
          <select
            data-testid="scoring-location-select"
            value={siteId}
            onChange={(e) => setSiteId(e.target.value)}
            className="h-10 min-w-56 rounded-md border border-border bg-surface px-2 text-sm text-white"
          >
            <option value="">Yard default — all locations</option>
            {(sites.data?.sites ?? []).map((site) => (
              <option key={site.id} value={site.id}>{site.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* Default vs Custom Toggle Card */}
      <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-white">Default Scoring Weights</span>
              <span
                className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                  useDefault
                    ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                    : "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                }`}
              >
                {useDefault ? "Active: Standard Yard Preset" : "Custom Scoring Active"}
              </span>
            </div>
            <p className="text-sm text-slate-400 max-w-xl">
              Turn off default scoring to tailor the exact percentage weight of each category.
              When custom scoring is enabled, you can see exactly what the AI evaluates for every metric.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-xs font-medium text-slate-400">
              {useDefault ? "Default On" : "Custom Mode"}
            </span>
            <Switch
              id="scoring-default-toggle"
              testId="scoring-default-toggle"
              checked={useDefault}
              onCheckedChange={handleToggleDefault}
              disabled={!canEdit || updateMutation.isPending}
            />
          </div>
        </div>

        {/* Informational notice when defaults are ON */}
        {useDefault && (
          <div className="mt-5 rounded-lg border border-slate-700/60 bg-slate-800/40 p-4 text-sm text-slate-300">
            <div className="flex items-start gap-3">
              <Info className="mt-0.5 size-5 shrink-0 text-amber-400" />
              <div>
                <p className="font-medium text-white">Standard Preset Active (100% Total)</p>
                <p className="mt-1 text-xs text-slate-400">
                  Greeting &amp; Brand is weighted at <strong>10%</strong>, and each of the other 6 categories
                  (Needs Discovery, Product Knowledge, Upsell &amp; Cross-sell, Objection Handling, Closing &amp; Next Steps,
                  Courtesy &amp; Professionalism) is weighted at <strong>15%</strong>.
                  Turn off the toggle switch above to fine-tune weights for your sales reps and inspect AI evaluation criteria.
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Custom Weights Configuration Section (Visible when Default toggle is turned OFF) */}
      {!useDefault && (
        <div className="space-y-6">
          <div className="rounded-xl border border-border bg-card p-5" data-testid="scoring-instructions-panel">
            <div className="flex items-center gap-2">
              <Bot className="size-4 text-amber-400" />
              <h3 className="font-semibold text-white">Location-specific AI instructions</h3>
            </div>
            <p className="mt-1 text-xs text-slate-400">
              Optional guidance for this location, e.g. “Always confirm the delivery address” or “This location sells wholesale only.”
            </p>
            <Textarea
              data-testid="scoring-instructions"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              disabled={!canEdit}
              placeholder="Add any location-specific evaluation guidance…"
              className="mt-3 min-h-[90px] bg-surface text-sm"
              maxLength={4000}
            />
          </div>
          {/* Active Allocation Indicator Banner */}
          <div
            className={`sticky top-4 z-10 flex flex-col gap-3 rounded-xl border p-4 shadow-lg backdrop-blur sm:flex-row sm:items-center sm:justify-between ${
              isBalanced
                ? "border-emerald-500/40 bg-card/95 text-emerald-300"
                : available > 0
                ? "border-amber-500/40 bg-card/95 text-amber-300"
                : "border-rose-500/40 bg-card/95 text-rose-300"
            }`}
          >
            <div className="flex items-center gap-3">
              {isBalanced ? (
                <CheckCircle2 className="size-6 shrink-0 text-emerald-400" />
              ) : (
                <AlertTriangle className="size-6 shrink-0 text-amber-400" />
              )}
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-white">Total Weight Allocated:</span>
                  <span
                    className={`font-mono text-base font-bold ${
                      isBalanced
                        ? "text-emerald-400"
                        : available > 0
                        ? "text-amber-400"
                        : "text-rose-400"
                    }`}
                  >
                    {currentTotal}% / 100%
                  </span>
                </div>
                <p className="text-xs text-slate-400">
                  {isBalanced ? (
                    <span className="text-emerald-400 font-medium">
                      All 100% accounted for. Ready to save!
                    </span>
                  ) : available > 0 ? (
                    <span>
                      <strong className="text-amber-400">{available}%</strong> remaining to allocate across categories.
                    </span>
                  ) : (
                    <span>
                      Over by <strong className="text-rose-400">{Math.abs(available)}%</strong>. Please reduce weights to reach 100%.
                    </span>
                  )}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleResetToDefaults}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-slate-800/80 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-700 hover:text-white transition-colors"
                title="Reset sliders to standard defaults"
              >
                <RotateCcw className="size-3.5" />
                Reset Defaults
              </button>
            </div>
          </div>

          {/* Metric Cards List */}
          <div className="grid gap-4">
            {(data?.metrics ?? []).map((m) => {
              const currentVal = weights[m.key] ?? m.weight;
              return (
                <div
                  key={m.key}
                  className="rounded-xl border border-border bg-card p-5 transition-colors hover:border-slate-700"
                >
                  <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                    {/* Category Title & AI Evaluates Description */}
                    <div className="flex-1 space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-white text-base">{m.name}</span>
                        <span className="rounded bg-slate-800 px-2 py-0.5 font-mono text-xs text-slate-400">
                          default: {m.weight}%
                        </span>
                      </div>
                      <p className="text-xs text-slate-400">{m.description}</p>

                      {/* AI Evaluation Criteria Box */}
                      {!useDefault ? (
                        <div className="mt-2.5 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs">
                          <div className="flex items-center gap-1.5 font-medium text-amber-400 mb-1">
                            <Bot className="size-3.5" />
                            <span>What the AI evaluates for this scope:</span>
                          </div>
                          <Textarea
                            data-testid={`scoring-criteria-${m.key}`}
                            value={criteria[m.key] ?? m.ai_criteria ?? ""}
                            onChange={(e) => setCriteria((prev) => ({ ...prev, [m.key]: e.target.value }))}
                            disabled={!canEdit}
                            className="mt-2 min-h-[70px] bg-surface text-xs text-slate-200"
                            maxLength={4000}
                          />
                        </div>
                      ) : m.ai_criteria ? (
                        <div className="mt-2.5 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs">
                          <div className="flex items-center gap-1.5 font-medium text-amber-400 mb-1">
                            <Bot className="size-3.5" />
                            <span>What the AI Evaluates:</span>
                          </div>
                          <p className="text-slate-300 leading-relaxed">{m.ai_criteria}</p>
                        </div>
                      ) : null}
                    </div>

                    {/* Weight Controls */}
                    <div className="flex shrink-0 items-center gap-3 md:w-56 md:flex-col md:items-end">
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min={0}
                          max={100}
                          value={currentVal}
                          onChange={(e) => handleWeightChange(m.key, parseInt(e.target.value) || 0)}
                          disabled={!canEdit}
                          className="w-16 rounded-lg border border-border bg-slate-800 px-2.5 py-1 text-right font-mono text-sm font-semibold text-white focus:border-amber-400 focus:outline-none"
                        />
                        <span className="font-mono text-sm font-bold text-slate-400">%</span>
                      </div>

                      {/* Slider Control */}
                      <input
                        type="range"
                        min={0}
                        max={50}
                        step={1}
                        value={currentVal}
                        onChange={(e) => handleWeightChange(m.key, parseInt(e.target.value) || 0)}
                        disabled={!canEdit}
                        className="h-2 w-full cursor-pointer accent-amber-500"
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Error Message */}
      {errorMessage && (
        <div className="flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">
          <AlertTriangle className="size-4 shrink-0 text-rose-400" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* Save Success Banner */}
      {saveSuccess && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-300">
          <CheckCircle2 className="size-4 shrink-0 text-emerald-400" />
          <span>{saveSuccess}</span>
        </div>
      )}

      {/* Action Footer */}
      <div className="flex items-center justify-between border-t border-border pt-5">
        <p className="text-xs text-slate-500">
          {canEdit
            ? "Only Owners and Sales Managers can change scoring weights."
            : "You have view-only access to scoring settings."}
        </p>

        {canEdit && (
          <button
            type="button"
            onClick={handleSave}
            disabled={updateMutation.isPending || (!useDefault && !isBalanced)}
            className="flex items-center gap-2 rounded-lg bg-amber-500 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Save className="size-4" />
            {updateMutation.isPending ? "Saving..." : "Save AI Evaluation"}
          </button>
        )}
      </div>
    </div>
  );
}