import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { authClient } from "@/lib/endpoint";
import { api, type EventsParams, type SessionsParams } from "./api";

export function useSession() {
	return useQuery({
		queryKey: ["session"],
		queryFn: async () => {
			const { data, error } = await authClient.getSession();
			if (error) throw error;
			return data;
		},
		retry: false,
		staleTime: 5 * 60 * 1000,
	});
}

export function useEvents(params: EventsParams = {}) {
	return useQuery({
		queryKey: ["events", params],
		queryFn: () => api.getEvents(params),
		placeholderData: keepPreviousData,
		refetchInterval: 10_000,
	});
}

export function useEvent(id: string) {
	return useQuery({
		queryKey: ["event", id],
		queryFn: () => api.getEvent(id),
		enabled: !!id,
	});
}

export function useEventStats() {
	return useQuery({
		queryKey: ["eventStats"],
		queryFn: () => api.getEventStats(),
		refetchInterval: 10_000,
	});
}

export function useSessions(params: SessionsParams = {}) {
	return useQuery({
		queryKey: ["sessions", params],
		queryFn: () => api.getSessions(params),
		placeholderData: keepPreviousData,
		refetchInterval: 10_000,
	});
}

export function useSessionDetail(entityKey: string) {
	return useQuery({
		queryKey: ["sessionDetail", entityKey],
		queryFn: () => api.getSessionDetail(entityKey),
		enabled: !!entityKey,
	});
}
