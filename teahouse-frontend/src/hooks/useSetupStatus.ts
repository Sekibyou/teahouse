import { useCallback, useEffect, useRef, useState } from "react"
import {
  llmProvidersApi,
  llmModelsApi,
  llmSlotsApi,
  modelProfilesApi,
  directorPromptPresetsApi,
} from "@/lib/api"
import { useSettingsDialogStore } from "@/stores/settingsDialogStore"
import { useWizardSkipStore } from "@/stores/wizardSkipStore"
import type { LLMProvider, LLMModel, SlotBindings, ModelProfile, DirectorPromptPreset } from "@/lib/types"

export interface SetupStatus {
  loading: boolean
  /** 存在启用的供应商 */
  providerReady: boolean
  /** 存在启用的模型 */
  modelReady: boolean
  /** 导演 + 正文两个槽位都绑定了启用模型 */
  slotsReady: boolean
  /** 推荐项：有**自建**参数预设（内置的不算——内置只是兜底，建议按自己口味建一份） */
  profileReady: boolean
  /** 推荐项：有**自建**导演提示词预设（同上，内置的不算） */
  presetReady: boolean
  /** 用户点过「跳过」的推荐步骤（跳过即按完成计入进度，但不代表真配了） */
  skipped: Record<string, boolean>
  /** 跳过某个推荐步骤 */
  skipStep: (key: keyof SetupReadyFlags) => void
  /** 清单全绿 = 硬门槛（供应商 + 模型 + 槽位）+ 两个推荐项（做了或跳过） */
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

  // 内置预设人人都有，用它判「就绪」等于永远绿灯；这里只认自建的，
  // 向导才有意义（引导用户按自己的口味建一份），不想建就点跳过。
  const profileReady = profiles.some((p) => !p.is_builtin)
  const presetReady = presets.some((p) => !p.is_builtin)

  const skipped = useWizardSkipStore((s) => s.skipped)
  const skipStep = useWizardSkipStore((s) => s.skipStep)

  const complete =
    providerReady &&
    modelReady &&
    slotsReady &&
    (profileReady || !!skipped.profileReady) &&
    (presetReady || !!skipped.presetReady)

  return {
    loading,
    providerReady,
    modelReady,
    slotsReady,
    profileReady,
    presetReady,
    skipped,
    skipStep,
    complete,
    refresh,
  }
}
