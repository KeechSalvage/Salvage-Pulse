import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import type { Keyword, Meta, OrgInfo, User } from "@/lib/types";

export const useMe = (): UseQueryResult<User> =>
  useQuery({ queryKey: ["me"], queryFn: () => apiGet<User>("/auth/me"), retry: false, staleTime: 60_000 });

export const useMeta = (): UseQueryResult<Meta> =>
  useQuery({ queryKey: ["meta"], queryFn: () => apiGet<Meta>("/meta"), staleTime: Infinity });

export const useReps = (enabled: boolean = true, includeManagers: boolean = false): UseQueryResult<User[]> =>
  useQuery({ queryKey: ["reps", { includeManagers }], queryFn: () => apiGet<User[]>(`/users/reps${includeManagers ? "?include_managers=true" : ""}`), enabled });

/** Managers: every rep including those whose login is turned off (Reps page, call-library filter). */
export const useAllReps = (enabled: boolean = true): UseQueryResult<User[]> =>
  useQuery({ queryKey: ["reps", "all"], queryFn: () => apiGet<User[]>("/users/reps?include_disabled=true"), enabled });

export const useKeywords = (): UseQueryResult<Keyword[]> =>
  useQuery({ queryKey: ["keywords"], queryFn: () => apiGet<Keyword[]>("/keywords") });

export const useOrg = (enabled: boolean = true): UseQueryResult<OrgInfo> =>
  useQuery({ queryKey: ["org"], queryFn: () => apiGet<OrgInfo>("/org/me"), enabled, retry: false });
