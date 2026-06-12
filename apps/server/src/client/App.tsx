import { BrowserRouter, Route, Routes } from "react-router-dom"
import { AuthGuard } from "@/client/components/auth-guard"
import { ErrorBoundary } from "@/client/components/error-boundary"
import Layout from "@/client/components/layout"
import ContainerDetailPage from "@/client/pages/container-detail"
import DashboardPage from "@/client/pages/dashboard"
import EventDetailPage from "@/client/pages/event-detail"
import EventsPage from "@/client/pages/events"
import LoginPage from "@/client/pages/login"
import NotFoundPage from "@/client/pages/not-found"
import SessionsPage from "@/client/pages/sessions"

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
            <Route path="containers" element={<SessionsPage />} />
            <Route path="containers/:entityKey" element={<ContainerDetailPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  )
}

export default App
