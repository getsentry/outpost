import { BrowserRouter, Routes, Route } from "react-router-dom";
import { ErrorBoundary } from "@/client/components/error-boundary";
import { AuthGuard } from "@/client/components/auth-guard";
import Layout from "@/client/components/layout";
import DashboardPage from "@/client/pages/dashboard";
import EventsPage from "@/client/pages/events";
import EventDetailPage from "@/client/pages/event-detail";
import SessionsPage from "@/client/pages/sessions";
import LoginPage from "@/client/pages/login";
import NotFoundPage from "@/client/pages/not-found";

function App() {
	return (
		<ErrorBoundary>
			<BrowserRouter>
				<Routes>
					<Route path="/login" element={<LoginPage />} />
					<Route
						element={
							<AuthGuard>
								<Layout />
							</AuthGuard>
						}
					>
						<Route index element={<DashboardPage />} />
						<Route path="events" element={<EventsPage />} />
						<Route path="events/:id" element={<EventDetailPage />} />
						<Route path="sessions" element={<SessionsPage />} />
						<Route path="*" element={<NotFoundPage />} />
					</Route>
				</Routes>
			</BrowserRouter>
		</ErrorBoundary>
	);
}

export default App;
