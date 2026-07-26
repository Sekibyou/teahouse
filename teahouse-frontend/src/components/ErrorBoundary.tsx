import { Component, type ErrorInfo, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"

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
    const text = `${this.state.error?.message || "未知错误"}\n\n${this.state.error?.stack || ""}`
    navigator.clipboard.writeText(text)
    toast.success("已复制到剪贴板")
  }

  render() {
    if (!this.state.hasError) return this.props.children

    return (
      <div className="flex min-h-dvh items-center justify-center bg-background p-6">
        <div className="w-full max-w-3xl space-y-6 rounded-xl border bg-card p-8 text-card-foreground shadow-sm">
          <div className="space-y-2">
            <h2 className="text-xl font-semibold tracking-tight">应用出错了</h2>
            <p className="text-base text-muted-foreground">
              {this.state.error?.message || "发生了未知错误"}
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Button variant="outline" onClick={this.handleReset}>
              重试
            </Button>
            <Button onClick={this.handleReload}>刷新页面</Button>
          </div>

          {this.state.error?.stack && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-muted-foreground">错误详情</span>
                <Button variant="ghost" size="sm" onClick={this.handleCopyError}>
                  复制
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
