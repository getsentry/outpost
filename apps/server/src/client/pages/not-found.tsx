import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";

export default function NotFoundPage() {
	const navigate = useNavigate();

	return (
		<div className="flex flex-col items-center justify-center gap-4 py-24">
			<h1 className="text-4xl font-bold">404</h1>
			<p className="text-sm text-muted-foreground">Page not found</p>
			<Button variant="outline" size="sm" onClick={() => navigate("/")}>
				Back to dashboard
			</Button>
		</div>
	);
}
