import { useState, useCallback, useEffect } from "react"
import { useTranslation } from "react-i18next"
import { Loader2 } from "lucide-react"
import { SlotCard } from "@/components/SlotCard"
import { llmSlotsApi, llmModelsApi, modelProfilesApi, directorPromptPresetsApi } from "@/lib/api"
import type { SlotBindings, SlotBinding, LLMModel, ModelProfile, DirectorPromptPreset } from "@/lib/types"

export function SlotsPanel() {
  const { t } = useTranslation("settings")
  const [slotBindings, setSlotBindings] = useState<SlotBindings>({ director: { model_id: null, profile_id: null, prompt_preset_id: null }, writer: { model_id: null, profile_id: null, prompt_preset_id: null } })
  const [slotsLoading, setSlotsLoading] = useState(false)
  const [models, setModels] = useState<LLMModel[]>([])
  const [profiles, setProfiles] = useState<ModelProfile[]>([])
  const [presets, setPresets] = useState<DirectorPromptPreset[]>([])

  const load = useCallback(async () => {
    setSlotsLoading(true)
    const [sRes, mRes, profRes, presRes] = await Promise.all([
      llmSlotsApi.getAll(), llmModelsApi.list(), modelProfilesApi.list(), directorPromptPresetsApi.list(),
    ])
    if (sRes.ok) setSlotBindings(sRes.data!.slots)
    if (mRes.ok) setModels(mRes.data!.models)
    if (profRes.ok) setProfiles(profRes.data!.profiles)
    if (presRes.ok) setPresets(presRes.data!.presets)
    setSlotsLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const handleSlotChange = (slotId: "director" | "writer") => (binding: SlotBinding) => {
    setSlotBindings(prev => ({ ...prev, [slotId]: binding }))
  }

  return (
    <div className="p-5 h-full flex flex-col">
      {slotsLoading ? (
        <div className="flex items-center justify-center flex-1"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="flex flex-col gap-4 flex-1 overflow-y-auto">
          <SlotCard
            slotId="director"
            label={t("slot.director")}
            binding={slotBindings.director}
            models={models}
            profiles={profiles}
            presets={presets}
            onChange={handleSlotChange("director")}
          />
          <SlotCard
            slotId="writer"
            label={t("slot.writer")}
            binding={slotBindings.writer}
            models={models}
            profiles={profiles}
            onChange={handleSlotChange("writer")}
          />
        </div>
      )}
    </div>
  )
}
