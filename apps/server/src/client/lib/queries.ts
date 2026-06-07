import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { authClient } from "@/lib/endpoint";
import { api, type EventsParams } from "./api";

export const useSession = authClient.useSession;

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
