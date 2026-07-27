import { createRoot } from 'react-dom/client'
import './index.css'
import { AppRouter } from './router'
import { Toaster } from 'sonner'
import { ErrorBoundary } from './components/ErrorBoundary'

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <Toaster position="top-center" richColors />
    <AppRouter />
  </ErrorBoundary>,
)
