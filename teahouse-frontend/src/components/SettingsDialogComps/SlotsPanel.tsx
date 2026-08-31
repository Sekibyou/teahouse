import { useState, useCallback, useEffect } from "react"
import { useTranslation } from "react-i18next"
import { Loader2 } from "lucide-react"
import { SlotCard } from "@/components/SlotCard"
import { useIsMobile } from "@/hooks/useMediaQuery"
import { llmSlotsApi, llmModelsApi, modelProfilesApi, directorPromptPresetsApi } from "@/lib/api"
import type { SlotBindings, SlotBinding, LLMModel, ModelProfile, DirectorPromptPreset } from "@/lib/types"
import { useSettingsDialogContext } from "@/components/SettingsDialogComps/SettingsContext"

export function SlotsPanel() {
  const { t } = useTranslation("settings")
  const isMobile = useIsMobile()
  const { activeSection } = useSettingsDialogContext()
  const isActive = activeSection === "slots"
  const [slotBindings, setSlotBindings] = useState<SlotBindings>({ director: { model_id: null, profile_id: null, prompt_preset_id: null }, writer: { model_id: null, profile_id: null, prompt_preset_id: null } })
  const [slotsLoading, setSlotsLoading] = useState(false)
  const [models, setModels] = useState<LLMModel[]>([])
  const [profiles, setProfiles] = useState<ModelProfile[]>([])
  const [presets, setPresets] = useState<DirectorPromptPreset[]>([])

  // 拉取槽位绑定 + 模型/参数预设/导演预设；withLoading 控制是否显示 spinner（下拉展开时静默，避免卸载 SlotCard）
  const fetchData = useCallback(async (withLoading: boolean) => {
    if (withLoading) setSlotsLoading(true)
    const [sRes, mRes, profRes, presRes] = await Promise.all([
      llmSlotsApi.getAll(), llmModelsApi.list(), modelProfilesApi.list(), directorPromptPresetsApi.list(),
    ])
    if (sRes.ok) setSlotBindings(sRes.data!.slots)
    if (mRes.ok) setModels(mRes.data!.models)
    if (profRes.ok) setProfiles(profRes.data!.profiles)
    if (presRes.ok) setPresets(presRes.data!.presets)
    if (withLoading) setSlotsLoading(false)
  }, [])

  const load = useCallback(() => fetchData(true), [fetchData])
  const silentLoad = useCallback(() => fetchData(false), [fetchData])

  // 打开时加载一次
  useEffect(() => { load() }, [load])

  // 每次切到「槽位指定」section 时重新拉取，保证新导入的模型/参数预设/导演提示词预设立即可用
  useEffect(() => {
    if (isActive) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive])

  const handleSlotChange = (slotId: "director" | "writer") => (binding: SlotBinding) => {
    setSlotBindings(prev => ({ ...prev, [slotId]: binding }))
  }

  return (
    <div className="p-5 h-full flex flex-col">
      {slotsLoading ? (
        <div className="flex items-center justify-center flex-1"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className={`grid ${isMobile ? "grid-cols-1" : "grid-cols-2"} gap-4 flex-1 overflow-y-auto content-start`}>
          <SlotCard
            slotId="director"
            label={t("slot.director")}
            binding={slotBindings.director}
            models={models}
            profiles={profiles}
            presets={presets}
            onChange={handleSlotChange("director")}
            onRefresh={silentLoad}
          />
          <SlotCard
            slotId="writer"
            label={t("slot.writer")}
            binding={slotBindings.writer}
            models={models}
            profiles={profiles}
            onChange={handleSlotChange("writer")}
            onRefresh={silentLoad}
          />
        </div>
      )}
    </div>
  )
}
