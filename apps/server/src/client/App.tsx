import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthGuard } from "@/client/components/auth-guard";
import Layout from "@/client/components/layout";
import DashboardPage from "@/client/pages/dashboard";
import EventsPage from "@/client/pages/events";
import EventDetailPage from "@/client/pages/event-detail";
import LoginPage from "@/client/pages/login";

function App() {
	return (
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
				</Route>
			</Routes>
		</BrowserRouter>
	);
}

export default App;
