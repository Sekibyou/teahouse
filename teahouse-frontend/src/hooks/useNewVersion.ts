import { useEffect, useState } from "react"
import { versionApi } from "@/lib/api"

// 「新版本」检测：比对当前运行版本（后端 /v1/status，唯一权威 = pyproject.toml）
// 与 GitHub 最新 release tag。纯前端（调用后端 + 直连 GitHub），不动后端。
//
// 说明：GitHub API 允许 CORS（Access-Control-Allow-Origin: *），浏览器可直连。
// 任何失败（离线 / 非 GitHub 分发 / 被墙 / 后端不可达）都静默降级为「无更新」，
// 不打扰游玩；仅当能确认存在更新的 release 时才亮起按钮。

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
  version: string | null // 当前运行版本（后端权威 /v1/status）
  latestVersion: string | null
  // fresh=true 表示本次已真实请求过（区分「还没查」与「查了没更新」）
  checked: boolean
  url: string
}

export function useNewVersion(): NewVersionState {
  const [state, setState] = useState<NewVersionState>({
    hasUpdate: false,
    version: null,
    latestVersion: null,
    checked: false,
    url: RELEASES_URL,
  })

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)

    ;(async () => {
      // 并行拉取：GitHub 最新 tag + 后端当前版本。任一失败都静默降级。
      const [latestRes, versionRes] = await Promise.all([
        fetch(LATEST_API, { signal: controller.signal }).then(
          (r) => (r.ok ? r.json() : null),
          () => null,
        ),
        versionApi.get(),
      ])
      clearTimeout(timer)
      if (cancelled) return

      const tag: string | undefined = latestRes?.tag_name
      const current = versionRes?.ok ? versionRes.data?.version ?? null : null
      if (!tag || !current) return

      const hasUpdate = isNewer(tag, current)
      setState({
        hasUpdate,
        version: current,
        latestVersion: tag,
        checked: true,
        url: RELEASES_URL,
      })
    })()

    return () => {
      cancelled = true
      controller.abort()
      clearTimeout(timer)
    }
  }, [])

  return state
}
