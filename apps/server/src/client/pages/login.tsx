import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { CircleNotch, List } from "@phosphor-icons/react";
import { authClient } from "@/lib/endpoint";
import { useSession } from "@/client/lib/queries";

export default function LoginPage() {
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();
	const redirect = searchParams.get("redirect") ?? "/";
	const { data: session, isLoading: sessionLoading } = useSession();
	const [isLoading, setIsLoading] = useState(false);

	useEffect(() => {
		if (session?.user) {
			navigate(redirect, { replace: true });
		}
	}, [session, navigate, redirect]);

	if (sessionLoading) {
		return null;
	}

	const handleGoogleLogin = async () => {
		setIsLoading(true);
		await authClient.signIn.social({
			provider: "google",
			callbackURL: `${window.location.origin}${redirect}`,
		});
	};

	return (
		<div className="flex min-h-screen flex-col items-center justify-center bg-background px-4 dark:bg-zinc-950">
			<div className="w-full max-w-sm">
				<section className="space-y-6 rounded-lg bg-card p-8 ring-1 ring-border">
					<div className="flex flex-col items-center space-y-3 text-center">
						<div className="flex size-10 items-center justify-center bg-primary text-primary-foreground">
							<List className="size-5" weight="bold" />
						</div>
						<h1 className="text-xl font-semibold tracking-tight">
							Welcome to Outpost
						</h1>
						<p className="text-sm text-muted-foreground">
							Webhook events dashboard for GitHub App integrations
						</p>
					</div>

					<button
						type="button"
						onClick={handleGoogleLogin}
						disabled={isLoading}
						className="inline-flex w-full items-center justify-center gap-2 bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
					>
						{isLoading ? (
							<CircleNotch className="size-5 animate-spin" />
						) : (
							<svg className="size-5" viewBox="0 0 24 24" aria-label="Google">
								<path
									d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
									fill="#4285F4"
								/>
								<path
									d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
									fill="#34A853"
								/>
								<path
									d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
									fill="#FBBC05"
								/>
								<path
									d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
									fill="#EA4335"
								/>
							</svg>
						)}
						{isLoading ? "Signing in..." : "Continue with Google"}
					</button>
				</section>
			</div>
		</div>
	);
}
