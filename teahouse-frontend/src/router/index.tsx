import { createBrowserRouter, RouterProvider } from "react-router-dom"
import { MainLayout } from "@/components/MainLayout"

const HomePage = () => (
  <div className="h-full flex items-center justify-center text-muted-foreground">
    <div className="text-center">
      <h2 className="text-lg font-semibold text-foreground">欢迎使用 Teahouse</h2>
      <p className="mt-1 text-sm">选择左侧菜单开始创作</p>
    </div>
  </div>
)

const router = createBrowserRouter([
  {
    path: "/",
    element: <MainLayout />,
    children: [
      { index: true, element: <HomePage /> },
    ],
  },
])

export function AppRouter() {
  return <RouterProvider router={router} />
}
