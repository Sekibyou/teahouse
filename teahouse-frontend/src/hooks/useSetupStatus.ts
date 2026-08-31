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

  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    // silent：不翻 loading——弹窗内的悬浮向导在轮询刷新时不能闪加载态（否则面板卸载/重挂，
    // expanded 与庆祝状态被重置）。仅首次拉取 / 关闭时刷新才翻 loading。
    if (!opts?.silent) setLoading(true)
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
    if (!opts?.silent) setLoading(false)
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

  // 弹窗打开期间静默轮询：用户在设置里配置（建供应商/导入模型/绑槽位/建预设）时，
  // 悬浮向导的进度能实时跟上，不必等关闭弹窗。silent 刷新不翻 loading，面板不会闪退。
  useEffect(() => {
    if (!settingsOpen) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      await refresh({ silent: true })
      if (cancelled) return
      timer = setTimeout(poll, 2000)
    }
    poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
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
