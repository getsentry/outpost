export function formatTimeAgo(dateStr: string): string {
	const date = new Date(dateStr);
	if (Number.isNaN(date.getTime())) return "-";

	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffSecs = Math.floor(diffMs / 1000);
	const diffMins = Math.floor(diffSecs / 60);
	const diffHours = Math.floor(diffMins / 60);
	const diffDays = Math.floor(diffHours / 24);

	if (diffSecs < 60) return `${diffSecs}s ago`;
	if (diffMins < 60) return `${diffMins}m ago`;
	if (diffHours < 24) return `${diffHours}h ago`;
	return `${diffDays}d ago`;
}

export function formatTime(dateStr: string): string {
	return new Date(dateStr).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

export function formatDate(dateStr: string | null): string {
	if (!dateStr) return "-";
	return new Date(dateStr).toLocaleString();
}

const PR_EVENTS = new Set([
	"pull_request",
	"pull_request_review",
	"pull_request_review_comment",
	"pull_request_review_thread",
]);

export function parseEntityKey(entityKey: string): { owner: string; repo: string; number: number } | null {
	const match = entityKey.match(/^(.+?)\/(.+?)#(\d+)$/);
	if (!match) return null;
	return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

export function entityGitHubUrl(entityKey: string, event: string): string | null {
	const parsed = parseEntityKey(entityKey);
	if (!parsed) return null;
	const type = PR_EVENTS.has(event) ? "pull" : "issues";
	return `https://github.com/${parsed.owner}/${parsed.repo}/${type}/${parsed.number}`;
}

export function repoGitHubUrl(repo: string): string {
	return `https://github.com/${repo}`;
}
