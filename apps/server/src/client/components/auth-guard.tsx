import { Navigate } from "react-router-dom";
import { useSession } from "@/client/lib/queries";
import { Skeleton } from "@/components/ui/skeleton";

export function AuthGuard({ children }: { children: React.ReactNode }) {
	const { data, isPending, error } = useSession();

	if (isPending) {
		return (
			<div className="flex h-screen w-full items-center justify-center">
				<div className="flex flex-col items-center gap-4">
					<Skeleton className="h-8 w-48" />
					<Skeleton className="h-4 w-32" />
				</div>
			</div>
		);
	}

	if (error || !data?.user) {
		return <Navigate to="/login" replace />;
	}

	return <>{children}</>;
}
