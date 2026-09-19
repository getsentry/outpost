import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom"
import ContainerDetailPage from "@/client/pages/container-detail"
import DashboardPage from "@/client/pages/dashboard"
import EventDetailPage from "@/client/pages/event-detail"
import EventsPage from "@/client/pages/events"
import LoginPage from "@/client/pages/login"
import NotFoundPage from "@/client/pages/not-found"
import SessionsPage from "@/client/pages/sessions"
import { AuthGuard } from "@/components/auth-guard"
import { ErrorBoundary } from "@/components/error-boundary"
import Layout from "@/components/layout"

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
            <Route path="runs" element={<SessionsPage />} />
            <Route path="runs/detail" element={<ContainerDetailPage />} />
            <Route path="runs/:entityKey" element={<ContainerDetailPage />} />
            <Route path="containers/*" element={<ContainersRedirect />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  )
}

// Redirect legacy /containers/* URLs (bookmarks, shared links) to /runs/*.
function ContainersRedirect() {
  const location = useLocation()
  const target = location.pathname.replace(/^\/containers/, "/runs")
  return <Navigate to={`${target}${location.search}${location.hash}`} replace />
}

export default App
