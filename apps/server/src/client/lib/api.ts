import { endpoint } from "@/lib/endpoint";

export type EventsParams = {
	page?: number;
	limit?: number;
	status?: string;
	event?: string;
	repo?: string;
};

export const api = {
	async getEvents(params: EventsParams = {}) {
		const query: Record<string, string> = {};
		if (params.page != null) query.page = String(params.page);
		if (params.limit != null) query.limit = String(params.limit);
		if (params.status) query.status = params.status;
		if (params.event) query.event = params.event;
		if (params.repo) query.repo = params.repo;

		const res = await endpoint.events.$get({ query });
		if (!res.ok) throw new Error(`Failed to fetch events: ${res.status}`);
		return res.json();
	},

	async getEvent(id: string) {
		const res = await endpoint.events[":id"].$get({ param: { id } });
		if (!res.ok) throw new Error(`Failed to fetch event: ${res.status}`);
		return res.json();
	},

	async getEventStats() {
		const res = await endpoint.events.stats.$get();
		if (!res.ok) throw new Error(`Failed to fetch stats: ${res.status}`);
		return res.json();
	},
};
