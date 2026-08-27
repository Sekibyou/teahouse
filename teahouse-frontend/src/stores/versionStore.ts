import { create } from "zustand"
import { versionApi } from "@/lib/api"

// 「新版本」检测：比对当前运行版本（后端 /v1/status，唯一权威 = pyproject.toml）
// 与 GitHub 最新 release tag。纯前端（调用后端 + 直连 GitHub），不动后端。
//
// 用 api.github.com 的 releases/latest 接口拿最新 tag（响应带 Access-Control-Allow-Origin: *，
// 浏览器可跨域读 JSON）。任何失败（离线 / 非 GitHub 分发 / 被墙 / 后端不可达）都静默降级为
// 「无更新」，不打扰游玩。
//
// ⚠️ 请求频率：GitHub 匿名配额只有 60 次/时，且按**出口 IP** 计（公司 / 校园 / CGNAT 全楼共享），
// 撞上就 403、最新版本显示「未知」。所以查询由 main.tsx 的 bootstrap() 在启动时**只发起一次**
// （initVersionCheck 自带幂等闸），组件一律只订阅本 store、不自己发请求；再叠一层 localStorage
// 缓存，1 小时内的启动直接读缓存、连那一次都省掉。

const REPO = "Sekibyou/teahouse"
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`
const RELEASES_URL = `https://github.com/${REPO}/releases`

const CACHE_KEY = "teahouse:latest-version"
// 成功拿到 tag：1 小时内不再查（发版频率远低于此，够用）
const OK_TTL = 60 * 60 * 1000
// 没拿到（离线 / 限流 / 被墙）：只冷却 10 分钟，让偶发失败能自愈，
// 同时把最坏情况锁死在 6 次/时，绝不可能打满配额
const FAIL_TTL = 10 * 60 * 1000

interface VersionCache {
  latest: string | null
  ts: number
}

function readCache(): VersionCache | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const c = JSON.parse(raw) as VersionCache
    if (typeof c?.ts !== "number") return null
    const age = Date.now() - c.ts
    // age < 0 = 系统时钟被回拨，当作过期重查，避免缓存卡死到未来某刻
    if (age < 0 || age > (c.latest ? OK_TTL : FAIL_TTL)) return null
    return c
  } catch {
    return null
  }
}

function writeCache(latest: string | null) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ latest, ts: Date.now() }))
  } catch {
    // 隐私模式 / 配额满时 localStorage 会抛，忽略即可（退化成每次启动查一次）
  }
}

// 拿最新 release tag，剥掉惯例的 "v" 前缀与后端当前版本（pyproject 的 "1.03"）格式统一。
// 失败与「没有 tag」一并归为 null——两者对调用方是同一件事：拿不到。
async function fetchLatestTag(signal: AbortSignal): Promise<string | null> {
  try {
    const r = await fetch(LATEST_API, { signal })
    if (!r.ok) return null
    const j = await r.json()
    return j?.tag_name?.replace(/^v/i, "") ?? null
  } catch {
    return null
  }
}

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
  latestVersion: string | null // 最新 release 版本（GitHub，查不到为 null）
  // true 表示本次启动已查过（区分「还没查」与「查了没更新/没拿到」）
  checked: boolean
  url: string
}

export const useVersionStore = create<NewVersionState>()(() => ({
  hasUpdate: false,
  version: null,
  latestVersion: null,
  checked: false,
  url: RELEASES_URL,
}))

let started = false

/**
 * 启动时调用一次（main.tsx 的 bootstrap）。重复调用是空操作。
 * 不要 await——它只负责在后台把结果写进 store，不该拖慢首屏。
 */
export function initVersionCheck() {
  if (started) return
  started = true

  void (async () => {
    const cached = readCache()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)

    // 当前版本走本地后端，便宜且必须每次启动现查（升级后要立刻反映）；
    // 最新版本能命中缓存就完全不出网。两者独立解耦：任一失败只影响各自字段。
    const [latest, versionRes] = await Promise.all([
      cached ? Promise.resolve(cached.latest) : fetchLatestTag(controller.signal),
      versionApi.get(),
    ])
    clearTimeout(timer)

    // 只有真发过请求才刷新缓存时间戳，否则命中缓存反而会把 TTL 无限续期
    if (!cached) writeCache(latest)

    const current = versionRes?.ok ? versionRes.data?.version ?? null : null
    useVersionStore.setState({
      hasUpdate: !!(latest && current && isNewer(latest, current)),
      version: current,
      latestVersion: latest,
      checked: true,
    })
  })().catch(() => {
    // 兜底：任何意外都不该冒泡成 unhandled rejection，静默保持「无更新」
    useVersionStore.setState({ checked: true })
  })
}

/** 组件侧唯一入口：只读订阅，不触发任何请求。 */
export function useNewVersion(): NewVersionState {
  return useVersionStore()
}
