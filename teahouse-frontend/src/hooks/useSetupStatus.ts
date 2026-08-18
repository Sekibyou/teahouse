import { useCallback, useEffect, useRef, useState } from "react"
import {
  llmProvidersApi,
  llmModelsApi,
  llmSlotsApi,
  modelProfilesApi,
  directorPromptPresetsApi,
} from "@/lib/api"
import { useSettingsDialogStore } from "@/stores/settingsDialogStore"
import type { LLMProvider, LLMModel, SlotBindings, ModelProfile, DirectorPromptPreset } from "@/lib/types"

export interface SetupStatus {
  loading: boolean
  /** 存在启用的供应商 */
  providerReady: boolean
  /** 存在启用的模型 */
  modelReady: boolean
  /** 导演 + 正文两个槽位都绑定了启用模型 */
  slotsReady: boolean
  /** 推荐项：有可用参数预设（内置或自建） */
  profileReady: boolean
  /** 推荐项：有可用导演提示词预设（内置或自建） */
  presetReady: boolean
  /** 硬门槛全绿 = 供应商 + 模型 + 槽位 */
  complete: boolean
  refresh: () => Promise<void>
}

/** 仅包含各步骤的 ready 布尔，用于 checklist 数据驱动的 key 与索引。 */
export type SetupReadyFlags = Pick<
  SetupStatus,
  "providerReady" | "modelReady" | "slotsReady" | "profileReady" | "presetReady"
>

export function useSetupStatus(): SetupStatus {
  const [loading, setLoading] = useState(true)
  const [providers, setProviders] = useState<LLMProvider[]>([])
  const [enabledModels, setEnabledModels] = useState<LLMModel[]>([])
  const [slots, setSlots] = useState<SlotBindings | null>(null)
  const [profiles, setProfiles] = useState<ModelProfile[]>([])
  const [presets, setPresets] = useState<DirectorPromptPreset[]>([])

  const refresh = useCallback(async () => {
    setLoading(true)
    const [pRes, mRes, sRes, profRes, presRes] = await Promise.all([
      llmProvidersApi.list(),
      llmModelsApi.listEnabled(),
      llmSlotsApi.getAll(),
      modelProfilesApi.list(),
      directorPromptPresetsApi.list(),
    ])
    if (pRes.ok) setProviders(pRes.data!.providers)
    if (mRes.ok) setEnabledModels(mRes.data!.models)
    if (sRes.ok) setSlots(sRes.data!.slots)
    if (profRes.ok) setProfiles(profRes.data!.profiles)
    if (presRes.ok) setPresets(presRes.data!.presets)
    setLoading(false)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // Refresh after the settings dialog closes, so the checklist flips to green
  // as soon as the user finishes configuring (mirrors ChatPanel's re-sync).
  const settingsOpen = useSettingsDialogStore((s) => s.open)
  const prevSettingsOpenRef = useRef(settingsOpen)
  useEffect(() => {
    if (prevSettingsOpenRef.current && !settingsOpen) {
      refresh()
    }
    prevSettingsOpenRef.current = settingsOpen
  }, [settingsOpen, refresh])

  const providerReady = providers.some((p) => p.is_enabled)
  const modelReady = enabledModels.length > 0

  const enabledIds = new Set(enabledModels.map((m) => m.id))

  const slotBoundToEnabled = (modelId: string | null | undefined): boolean =>
    !!modelId && enabledIds.has(modelId)
  const slotsReady =
    !!slots &&
    slotBoundToEnabled(slots.director?.model_id) &&
    slotBoundToEnabled(slots.writer?.model_id)

  const profileReady = profiles.length > 0
  const presetReady = presets.length > 0

  const complete = providerReady && modelReady && slotsReady

  return { loading, providerReady, modelReady, slotsReady, profileReady, presetReady, complete, refresh }
}
