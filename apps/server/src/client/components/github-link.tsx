import { ArrowSquareOut } from "@phosphor-icons/react";

export function GitHubLink({ href, children }: { href: string; children: React.ReactNode }) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
			onClick={(e) => e.stopPropagation()}
		>
			{children}
			<ArrowSquareOut className="size-3 shrink-0 text-muted-foreground" />
		</a>
	);
}
