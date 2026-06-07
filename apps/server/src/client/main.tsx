import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./index.css";
import App from "./App";

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			staleTime: 10_000,
			retry: 1,
		},
	},
});

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
			<QueryClientProvider client={queryClient}>
				<TooltipProvider>
					<App />
				</TooltipProvider>
			</QueryClientProvider>
		</ThemeProvider>
	</StrictMode>,
);
