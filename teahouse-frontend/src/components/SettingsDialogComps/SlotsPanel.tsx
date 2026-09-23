import { useState, useCallback, useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { SlotCard, SlotCardSkeleton } from "@/components/SlotCard"
import { useIsMobile } from "@/hooks/useMediaQuery"
import { llmSlotsApi, llmModelsApi, modelProfilesApi, directorPromptPresetsApi } from "@/lib/api"
import type { SlotBindings, SlotBinding, LLMModel, ModelProfile, DirectorPromptPreset } from "@/lib/types"

export function SlotsPanel() {
  const { t } = useTranslation("settings")
  const isMobile = useIsMobile()
  const [slotBindings, setSlotBindings] = useState<SlotBindings>({ director: { model_id: null, profile_id: null, prompt_preset_id: null }, writer: { model_id: null, profile_id: null, prompt_preset_id: null }, dm: { model_id: null, profile_id: null, prompt_preset_id: null } })
  const [booted, setBooted] = useState(false)
  const [optionsLoading, setOptionsLoading] = useState(false)
  const [models, setModels] = useState<LLMModel[]>([])
  const [profiles, setProfiles] = useState<ModelProfile[]>([])
  const [presets, setPresets] = useState<DirectorPromptPreset[]>([])

  // 纯拉取，自身不碰任何 loading 态——加载表现由调用方决定（首屏骨架 / 展开下拉框内的 spinner）。
  // token 守卫：并发时只认最后一次，避免先发的慢响应回来把新数据覆盖成旧的。
  const tokenRef = useRef(0)
  const fetchData = useCallback(async () => {
    const token = ++tokenRef.current
    const [sRes, mRes, profRes, presRes] = await Promise.all([
      llmSlotsApi.getAll(), llmModelsApi.list(), modelProfilesApi.list(), directorPromptPresetsApi.list(),
    ])
    if (token !== tokenRef.current) return
    if (sRes.ok) setSlotBindings(sRes.data!.slots)
    if (mRes.ok) setModels(mRes.data!.models)
    if (profRes.ok) setProfiles(profRes.data!.profiles)
    if (presRes.ok) setPresets(presRes.data!.presets)
  }, [])

  // 首屏拉一次；拉取期间渲染同高骨架，数据到达时 section 高度不跳（高度一跳就会让外层
  // 滚动列表的 activeSection 重算，进而反复触发刷新——那是本面板曾经的老毛病）
  useEffect(() => {
    let alive = true
    fetchData().then(() => { if (alive) setBooted(true) })
    return () => { alive = false }
  }, [fetchData])

  // 展开任一下拉框时刷新，保证别处新导入的模型/参数预设/导演预设立即可选。
  // 展开是低频动作，故刷新时机就挂在它上面；spinner 只出现在展开的那个下拉框内部。
  const pendingRef = useRef(0)
  const refreshOptions = useCallback(async () => {
    pendingRef.current += 1
    setOptionsLoading(true)
    await fetchData()
    pendingRef.current -= 1
    if (pendingRef.current === 0) setOptionsLoading(false)
  }, [fetchData])

  const handleSlotChange = (slotId: "director" | "writer" | "dm") => (binding: SlotBinding) => {
    setSlotBindings(prev => ({ ...prev, [slotId]: binding }))
  }

  return (
    <div className="p-5">
      <div className={`grid ${isMobile ? "grid-cols-1" : "grid-cols-2"} gap-4 content-start`}>
        {!booted ? (
          <>
            <SlotCardSkeleton withPreset />
            <SlotCardSkeleton />
            <SlotCardSkeleton />
          </>
        ) : (
          <>
            <SlotCard
              slotId="director"
              label={t("slot.director")}
              binding={slotBindings.director}
              models={models}
              profiles={profiles}
              presets={presets}
              optionsLoading={optionsLoading}
              onChange={handleSlotChange("director")}
              onRefresh={refreshOptions}
            />
            <SlotCard
              slotId="writer"
              label={t("slot.writer")}
              binding={slotBindings.writer}
              models={models}
              profiles={profiles}
              optionsLoading={optionsLoading}
              onChange={handleSlotChange("writer")}
              onRefresh={refreshOptions}
            />
            {/* DM（运行时导演）：提示词来自实例 dm.yaml，故无预设选择器；未绑定时回退 director 槽 */}
            <SlotCard
              slotId="dm"
              label={t("slot.dm")}
              binding={slotBindings.dm}
              models={models}
              profiles={profiles}
              optionsLoading={optionsLoading}
              onChange={handleSlotChange("dm")}
              onRefresh={refreshOptions}
            />
          </>
        )}
      </div>
    </div>
  )
}
