import { createBrowserRouter, RouterProvider } from "react-router-dom"
import { MainLayout } from "@/components/MainLayout"
import { SessionSelectPage } from "@/pages/SessionSelectPage"
import { WorkspacePage } from "@/pages/WorkspacePage"
import { SettingsPage } from "@/pages/SettingsPage"

const router = createBrowserRouter([
  {
    path: "/",
    element: <MainLayout />,
    children: [
      { index: true, element: <SessionSelectPage /> },
      { path: "workspace", element: <WorkspacePage /> },
      { path: "settings", element: <SettingsPage /> },
    ],
  },
])

export function AppRouter() {
  return <RouterProvider router={router} />
}
