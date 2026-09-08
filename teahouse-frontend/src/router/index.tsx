import { createBrowserRouter, RouterProvider } from "react-router-dom"
import { MainLayout } from "@/components/MainLayout"
import { SessionSelectPage } from "@/pages/SessionSelectPage"
import { InstanceDetailPage } from "@/pages/InstanceDetailPage"
import { WorkspacePage } from "@/pages/WorkspacePage"
import { ErrorBoundary } from "@/components/ErrorBoundary"

const router = createBrowserRouter([
  {
    path: "/",
    element: (
      <ErrorBoundary>
        <MainLayout />
      </ErrorBoundary>
    ),
    ErrorBoundary: () => null,
    children: [
      { index: true, element: <SessionSelectPage /> },
      { path: "instances/:id", element: <InstanceDetailPage /> },
      { path: "workspace", element: <WorkspacePage /> },
    ],
  },
])

export function AppRouter() {
  return (
    <ErrorBoundary>
      <RouterProvider router={router} />
    </ErrorBoundary>
  )
}
