import { Component, type ErrorInfo, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"
import i18n from "@/i18n/config"

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack)
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  handleReload = () => {
    window.location.reload()
  }

  handleCopyError = () => {
    const text = `${this.state.error?.message || i18n.t("misc:errorBoundary.unknownError")}\n\n${this.state.error?.stack || ""}`
    navigator.clipboard.writeText(text)
    toast.success(i18n.t("misc:errorBoundary.toastCopied"))
  }

  render() {
    if (!this.state.hasError) return this.props.children

    return (
      <div className="flex min-h-dvh items-center justify-center bg-background p-6">
        <div className="w-full max-w-3xl space-y-6 rounded-xl border bg-card p-8 text-card-foreground shadow-sm">
          <div className="space-y-2">
            <h2 className="text-xl font-semibold tracking-tight">{i18n.t("misc:errorBoundary.title")}</h2>
            <p className="text-base text-muted-foreground">
              {this.state.error?.message || i18n.t("misc:errorBoundary.unexpected")}
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Button variant="outline" onClick={this.handleReset}>
              {i18n.t("misc:errorBoundary.retry")}
            </Button>
            <Button onClick={this.handleReload}>{i18n.t("misc:errorBoundary.reload")}</Button>
          </div>

          {this.state.error?.stack && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-muted-foreground">{i18n.t("misc:errorBoundary.detail")}</span>
                <Button variant="ghost" size="sm" onClick={this.handleCopyError}>
                  {i18n.t("misc:errorBoundary.copy")}
                </Button>
              </div>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/50 p-4 font-mono text-sm text-muted-foreground">
                {this.state.error.stack}
              </pre>
            </div>
          )}
        </div>
      </div>
    )
  }
}
