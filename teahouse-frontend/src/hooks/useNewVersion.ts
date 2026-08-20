import { useEffect, useState } from "react"

// 「新版本」检测：比对本地构建版本（__APP_VERSION__，由 vite 注入）与
// GitHub 最新 release tag。纯前端，不动后端。
//
// 说明：GitHub API 允许 CORS（Access-Control-Allow-Origin: *），浏览器可直连。
// 任何失败（离线 / 非 GitHub 分发 / 被墙）都静默降级为「无更新」，不打扰游玩；
// 仅当能确认存在更新的 release 时才亮起按钮。

const REPO = "Sekibyou/teahouse"
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`
const RELEASES_URL = `https://github.com/${REPO}/releases`

// 简单版本比较：支持 "1.0.0"-like 的三段数字；非纯数字段（如预发布 "1.0.1-beta"）
// 按「新版比旧版大」的宽松规则处理：数字相同则照常返回 false。
function isNewer(latest: string, current: string): boolean {
  const norm = (v: string) =>
    v.replace(/^v/i, "").split(/[\.\-\+]/).map((s) => (s ? parseInt(s, 10) : 0))
  const a = norm(latest)
  const b = norm(current)
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const x = a[i] || 0
    const y = b[i] || 0
    if (x > y) return true
    if (x < y) return false
  }
  return false
}

export interface NewVersionState {
  hasUpdate: boolean
  latestVersion: string | null
  // fresh=true 表示本次已真实请求过（区分「还没查」与「查了没更新」）
  checked: boolean
  url: string
}

export function useNewVersion(): NewVersionState {
  const [state, setState] = useState<NewVersionState>({
    hasUpdate: false,
    latestVersion: null,
    checked: false,
    url: RELEASES_URL,
  })

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)

    ;(async () => {
      try {
        const res = await fetch(LATEST_API, { signal: controller.signal })
        if (!res.ok) return
        const data = await res.json()
        const tag: string | undefined = data?.tag_name
        if (!tag || cancelled) return
        const hasUpdate = isNewer(tag, __APP_VERSION__)
        setState({
          hasUpdate,
          latestVersion: tag,
          checked: true,
          url: RELEASES_URL,
        })
      } catch {
        // 离线 / 网络失败 / 非 GitHub 分发：静默，不亮按钮
      } finally {
        clearTimeout(timer)
      }
    })()

    return () => {
      cancelled = true
      controller.abort()
      clearTimeout(timer)
    }
  }, [])

  return state
}
