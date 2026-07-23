import { createBrowserRouter, RouterProvider } from "react-router-dom"
import { MainLayout } from "@/components/MainLayout"
import { SessionSelectPage } from "@/pages/SessionSelectPage"
import { WorkspacePage } from "@/pages/WorkspacePage"

const router = createBrowserRouter([
  {
    path: "/",
    element: <MainLayout />,
    children: [
      { index: true, element: <SessionSelectPage /> },
      { path: "workspace", element: <WorkspacePage /> },
    ],
  },
])

export function AppRouter() {
  return <RouterProvider router={router} />
}
