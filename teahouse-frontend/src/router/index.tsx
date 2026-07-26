import { createBrowserRouter, RouterProvider } from "react-router-dom"
import { MainLayout } from "@/components/MainLayout"
import { SessionSelectPage } from "@/pages/SessionSelectPage"
import { WorkspacePage } from "@/pages/WorkspacePage"
import { SettingsPage } from "@/pages/SettingsPage"
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
      { path: "workspace", element: <WorkspacePage /> },
      { path: "settings", element: <SettingsPage /> },
    ],
  },
])

export function AppRouter() {
  return (
    <ErrorBoundary>
      <RouterProvider router={router} fallbackElement={null} />
    </ErrorBoundary>
  )
}
