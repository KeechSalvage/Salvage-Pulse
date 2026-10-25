import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPut } from "@/lib/api";
import { applyBranding } from "@/lib/theme";
import type { Branding, ThemeModeUpdate } from "@/lib/types";

/** The signed-in user's yard branding; applies it (mode, accent, favicon) whenever it changes. */
export function useBranding(enabled = true) {
  const q = useQuery({ queryKey: ["branding"], queryFn: () => apiGet<Branding>("/branding"), enabled, staleTime: 5 * 60_000 });
  useEffect(() => {
    if (q.data) applyBranding(q.data);
  }, [q.data]);
  return q;
}

/** Switch this user's own dark/light mode (saved to their account). */
export function useSetMyMode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mode: ThemeModeUpdate["mode"]) => apiPut<Branding>("/me/theme", { mode } satisfies ThemeModeUpdate),
    onSuccess: (b) => qc.setQueryData(["branding"], b),
  });
}
