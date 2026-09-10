import { useEffect, useState } from "react"
import { Loader2, ImageOff } from "lucide-react"
import { instancesApi } from "@/lib/api"

/**
 * 用户气泡里的附件缩略图。图片以实例内路径存于 JSONL（如 temp/pasted/xxx.png），
 * 渲染时经 readAsset 取 base64 拼成 data URI —— 与 WorkspacePage 的图片预览同一路子。
 *
 * 跨组件实例共用一个模块级缓存：历史滚动会反复重建气泡，没有缓存就会对同一张图
 * 反复发起请求。
 */
const uriCache = new Map<string, string>()

function cacheKey(instanceId: string, path: string) {
  return `${instanceId}:${path}`
}

export function MessageImage({
  instanceId,
  path,
  mime,
  index,
}: {
  instanceId: string
  path: string
  mime: string
  index: number
}) {
  const key = cacheKey(instanceId, path)
  const [uri, setUri] = useState<string | null>(() => uriCache.get(key) ?? null)
  const [failed, setFailed] = useState(false)
  const [zoomed, setZoomed] = useState(false)

  useEffect(() => {
    const cached = uriCache.get(key)
    if (cached) {
      setUri(cached)
      setFailed(false)
      return
    }
    let alive = true
    instancesApi.readAsset(instanceId, path).then((res) => {
      if (!alive) return
      if (res.ok && res.data) {
        const next = `data:${res.data.mime || mime};base64,${res.data.data}`
        uriCache.set(key, next)
        setUri(next)
      } else {
        setFailed(true)
      }
    }).catch(() => {
      if (alive) setFailed(true)
    })
    return () => { alive = false }
  }, [key, instanceId, path, mime])

  if (failed) {
    return (
      <div className="flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground/70">
        <ImageOff className="h-3 w-3" />
        <span className="font-mono break-all">{path}</span>
      </div>
    )
  }

  return (
    <>
      <button
        type="button"
        className="relative block overflow-hidden rounded-md border border-black/10 dark:border-white/10"
        onClick={() => uri && setZoomed(true)}
        title={path}
      >
        {uri ? (
          <img src={uri} alt={`图${index}`} className="max-h-40 max-w-[240px] object-contain" />
        ) : (
          <span className="flex h-20 w-28 items-center justify-center bg-muted/40">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/60" />
          </span>
        )}
        {/* 序号与导演侧 【图N】 标识一致，方便对着打字引用 */}
        <span className="absolute left-1 bottom-1 rounded bg-black/55 px-1 text-[10px] leading-tight font-mono text-white">
          {index}
        </span>
      </button>

      {zoomed && uri && (
        <ImageLightbox uri={uri} alt={`图${index}`} onClose={() => setZoomed(false)} />
      )}
    </>
  )
}

/** 全屏放大层：已发送气泡的缩略图与输入框里尚未发送的预览图共用。 */
export function ImageLightbox({ uri, alt, onClose }: { uri: string; alt?: string; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      <img src={uri} alt={alt || ""} className="max-h-full max-w-full object-contain" />
    </div>
  )
}
