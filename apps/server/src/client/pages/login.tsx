import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useSession } from "@/client/lib/queries";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function LoginPage() {
	const navigate = useNavigate();
	const { data: session, isLoading } = useSession();

	useEffect(() => {
		if (session?.user) {
			navigate("/", { replace: true });
		}
	}, [session, navigate]);

	if (isLoading) {
		return null;
	}

	const handleGoogleLogin = () => {
		window.location.href = "/auth/sign-in/social?provider=google&callbackURL=/";
	};

	return (
		<div className="flex min-h-screen items-center justify-center bg-background p-4">
			<Card className="w-full max-w-sm">
				<CardHeader className="text-center">
					<CardTitle className="text-xl">Outpost</CardTitle>
					<CardDescription>Sign in to access the webhook events dashboard</CardDescription>
				</CardHeader>
				<CardContent>
					<Button className="w-full" onClick={handleGoogleLogin}>
						Sign in with Google
					</Button>
				</CardContent>
			</Card>
		</div>
	);
}
