async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, {
		...init,
		credentials: "include",
		headers: {
			"Content-Type": "application/json",
			...init?.headers,
		},
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(body || `Request failed: ${res.status}`);
	}

	return res.json() as Promise<T>;
}

export type WebhookEventSummary = {
	id: string;
	entityKey: string;
	event: string;
	action: string | null;
	deliveryId: string;
	sender: string | null;
	repo: string | null;
	installationId: number | null;
	status: string;
	createdAt: string;
	dispatchedAt: string | null;
	completedAt: string | null;
};

export type WebhookEventDetail = WebhookEventSummary & {
	payload: string;
};

export type PaginatedResponse<T> = {
	data: T[];
	pagination: {
		page: number;
		limit: number;
		total: number;
		totalPages: number;
	};
};

export type EventStats = {
	total: number;
	pending: number;
	dispatched: number;
	completed: number;
	last24h: number;
};

export type EventsParams = {
	page?: number;
	limit?: number;
	status?: string;
	event?: string;
	repo?: string;
};

export type UserSession = {
	user: {
		id: string;
		name: string;
		email: string;
		image: string | null;
	};
	session: {
		id: string;
		expiresAt: string;
	};
};

export const api = {
	getSession(): Promise<UserSession> {
		return request<UserSession>("/auth/get-session");
	},

	getEvents(params: EventsParams = {}): Promise<PaginatedResponse<WebhookEventSummary>> {
		const searchParams = new URLSearchParams();
		if (params.page != null) searchParams.set("page", String(params.page));
		if (params.limit != null) searchParams.set("limit", String(params.limit));
		if (params.status) searchParams.set("status", params.status);
		if (params.event) searchParams.set("event", params.event);
		if (params.repo) searchParams.set("repo", params.repo);
		const qs = searchParams.toString();
		return request<PaginatedResponse<WebhookEventSummary>>(`/events${qs ? `?${qs}` : ""}`);
	},

	getEvent(id: string): Promise<WebhookEventDetail> {
		return request<WebhookEventDetail>(`/events/${id}`);
	},

	getEventStats(): Promise<EventStats> {
		return request<EventStats>("/events/stats");
	},
};
