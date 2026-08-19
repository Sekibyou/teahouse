// 同源部署（后端托管前端）:空字符串 = 相对路径,自动指向当前 origin。
// 可用 VITE_API_BASE_URL 覆写指向跨源。
const DEFAULT = import.meta.env.VITE_API_BASE_URL || ""

export function getApiBaseUrl(): string {
  return DEFAULT
}
