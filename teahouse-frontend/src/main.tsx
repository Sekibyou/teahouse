import { createRoot } from 'react-dom/client'
import './index.css'
import { AppRouter } from './router'
import { Toaster } from 'sonner'
import { ErrorBoundary } from './components/ErrorBoundary'
import { useIsMobile } from './hooks/useMediaQuery'
import { initI18n } from './i18n/config'

function AppToaster() {
  const isMobile = useIsMobile()
  return (
    <Toaster
      position={isMobile ? 'bottom-center' : 'top-center'}
      richColors
      // 移动端悬浮球分布在左下(bottom-6 left-3)与右上(top-3 right-3)，
      // 用 bottom-center 抬到中下部中央，避开上下两处密集交互区
      mobileOffset={isMobile ? { bottom: 96 } : undefined}
    />
  )
}

async function bootstrap() {
  await initI18n()

  createRoot(document.getElementById('root')!).render(
    <ErrorBoundary>
      <AppToaster />
      <AppRouter />
    </ErrorBoundary>,
  )
}

bootstrap()

// 仅生产构建注册 Service Worker（dev 下 Vite 热更新会与之冲突）。
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}
