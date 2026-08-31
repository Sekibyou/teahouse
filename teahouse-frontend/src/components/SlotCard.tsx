import { useState, useEffect, useMemo, useRef } from "react"
import { toast } from "sonner"
import { AlertCircle } from "lucide-react"
import type { SlotBinding, LLMModel, ModelProfile, DirectorPromptPreset } from "@/lib/types"
import { llmSlotsApi } from "@/lib/api"
import { profileDisplayName, presetDisplayName } from "@/lib/builtinNames"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { SavedBadge } from "@/components/SavedBadge"
import { useTranslation } from "react-i18next"

interface SlotCardProps {
  slotId: "director" | "writer"
  label: string
  binding: SlotBinding
  models: LLMModel[]
  profiles: ModelProfile[]
  presets?: DirectorPromptPreset[]
  onChange: (binding: SlotBinding) => void
  /** 任意下拉框展开时调用，用于刷新最新数据（模型/参数预设/导演预设可能在本弹窗其他页或外部新增） */
  onRefresh?: () => void
}

interface MatchedIds {
  profileIds: Set<string>
  presetIds: Set<string>
}

function computeMatches(modelName: string | undefined, profiles: ModelProfile[], presets?: DirectorPromptPreset[]): MatchedIds {
  const profileIds = new Set<string>()
  const presetIds = new Set<string>()
  if (!modelName) return { profileIds, presetIds }
  for (const p of profiles) {
    if (p.match_pattern) {
      try {
        if (new RegExp(p.match_pattern, "i").test(modelName)) profileIds.add(p.id)
      } catch {}
    }
  }
  if (presets) {
    for (const p of presets) {
      if (p.match_pattern) {
        try {
          if (new RegExp(p.match_pattern, "i").test(modelName)) presetIds.add(p.id)
        } catch {}
      }
    }
  }
  return { profileIds, presetIds }
}

/** 供应商徽章 + 模型名，下拉选项与选中项共用一套渲染 */
function ModelLabel({ model }: { model: LLMModel }) {
  return (
    <>
      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
        {model.provider_name}
      </span>
      <span className="truncate">{model.name}</span>
    </>
  )
}

export function SlotCard({ slotId, label, binding, models, profiles, presets, onChange, onRefresh }: SlotCardProps) {
  const { t } = useTranslation("misc")
  const [selectedModelId, setSelectedModelId] = useState<string>(binding.model_id || "")
  const [selectedProfileId, setSelectedProfileId] = useState<string>(binding.profile_id || "")
  const [selectedPresetId, setSelectedPresetId] = useState<string>(binding.prompt_preset_id || "")
  const [matchedProfileIds, setMatchedProfileIds] = useState<Set<string>>(new Set())
  const [matchedPresetIds, setMatchedPresetIds] = useState<Set<string>>(new Set())
  const [userPickedProfile, setUserPickedProfile] = useState(false)
  const [userPickedPreset, setUserPickedPreset] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showPresets = slotId === "director" && presets !== undefined

  // Resolve effective profile/preset IDs (empty = default = builtin)
  const builtinProfile = useMemo(() => profiles.find(p => p.is_builtin), [profiles])
  const builtinPreset = useMemo(() => presets?.find(p => p.is_builtin), [presets])

  const effectiveProfileId = selectedProfileId || builtinProfile?.id || ""
  const effectivePresetId = selectedPresetId || builtinPreset?.id || ""

  // Sync from props when binding changes externally
  useEffect(() => {
    setSelectedModelId(binding.model_id || "")
    setSelectedProfileId(binding.profile_id || "")
    setSelectedPresetId(binding.prompt_preset_id || "")
  }, [binding.model_id, binding.profile_id, binding.prompt_preset_id])

  useEffect(() => () => { if (flashTimerRef.current) clearTimeout(flashTimerRef.current) }, [])

  // Auto-match when model changes
  useEffect(() => {
    if (!selectedModelId) {
      setMatchedProfileIds(new Set())
      setMatchedPresetIds(new Set())
      return
    }
    const model = models.find(m => m.id === selectedModelId)
    const matches = computeMatches(model?.model_name, profiles, presets)
    setMatchedProfileIds(matches.profileIds)
    setMatchedPresetIds(matches.presetIds)
    if (!userPickedProfile && !binding.profile_id) {
      const firstMatch = profiles.find(p => matches.profileIds.has(p.id))
      setSelectedProfileId(firstMatch?.id || "")
    }
    if (!userPickedPreset && !binding.prompt_preset_id && presets) {
      const firstMatch = presets.find(p => matches.presetIds.has(p.id))
      if (firstMatch && !firstMatch.is_builtin) {
        setSelectedPresetId(firstMatch.id)
      }
    }
  }, [selectedModelId, models, profiles])

  // 选取即保存：任一下拉框变更后立刻落库，失败才打扰用户
  const persist = async (next: SlotBinding) => {
    const payload: SlotBinding = {
      model_id: next.model_id || null,
      profile_id: next.profile_id || null,
      prompt_preset_id: showPresets ? (next.prompt_preset_id || null) : null,
    }
    const result = await llmSlotsApi.setSlot(slotId, payload)
    if (result.ok) {
      onChange(payload)
      setSavedFlash(true)
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
      flashTimerRef.current = setTimeout(() => setSavedFlash(false), 1600)
    } else {
      toast.error(result.error || t("slot.saveFailed"))
    }
  }

  const handleModelChange = (modelId: string) => {
    setSelectedModelId(modelId)
    setUserPickedProfile(false)
    setUserPickedPreset(false)
    // 换模型即重新自动匹配参数/提示词预设，一并写回
    const model = models.find(m => m.id === modelId)
    const matches = computeMatches(model?.model_name, profiles, presets)
    const autoProfile = profiles.find(p => matches.profileIds.has(p.id))
    const autoPreset = presets?.find(p => matches.presetIds.has(p.id) && !p.is_builtin)
    setSelectedProfileId(autoProfile?.id || "")
    setSelectedPresetId(autoPreset?.id || "")
    persist({ model_id: modelId, profile_id: autoProfile?.id || null, prompt_preset_id: autoPreset?.id || null })
  }

  const handleProfileChange = (profileId: string) => {
    setSelectedProfileId(profileId)
    setUserPickedProfile(true)
    persist({ model_id: selectedModelId, profile_id: profileId, prompt_preset_id: selectedPresetId })
  }

  const handlePresetChange = (presetId: string) => {
    setSelectedPresetId(presetId)
    setUserPickedPreset(true)
    persist({ model_id: selectedModelId, profile_id: selectedProfileId, prompt_preset_id: presetId })
  }

  const enabledModels = models.filter(m => m.is_enabled)
  const selectedModel = enabledModels.find(m => m.id === selectedModelId)
  const matchedClass = "text-amber-600 dark:text-amber-400 font-medium"

  return (
    <div className="border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between h-5">
        <h4 className="font-semibold text-sm">{label}</h4>
        <SavedBadge show={savedFlash} />
      </div>

      {/* Model select */}
      <div>
        <label className="text-xs text-muted-foreground mb-1 block">{t("slot.model")}</label>
        <Select value={selectedModelId} onValueChange={(v) => handleModelChange(v as string)} onOpenChange={(open) => { if (open) onRefresh?.() }}>
          <SelectTrigger className="w-full">
            <SelectValue>
              {selectedModel ? (
                <ModelLabel model={selectedModel} />
              ) : (
                <span className="flex items-center gap-1.5 text-destructive">
                  <AlertCircle className="h-3.5 w-3.5" />
                  {t("slot.noModel")}
                </span>
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {enabledModels.length === 0 ? (
              <div className="px-3 py-2.5 text-xs text-muted-foreground leading-relaxed">
                {t("slot.noModelEmpty")}
              </div>
            ) : (
              enabledModels.map(m => (
                <SelectItem key={m.id} value={m.id}>
                  <ModelLabel model={m} />
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
      </div>

      {/* Profile select */}
      <div>
        <label className="text-xs text-muted-foreground mb-1 block">{t("slot.profile")}</label>
        <Select value={effectiveProfileId} onValueChange={(v) => handleProfileChange(v as string)} onOpenChange={(open) => { if (open) onRefresh?.() }}>
          <SelectTrigger className="w-full">
            <SelectValue>
              <span className={matchedProfileIds.has(effectiveProfileId) ? matchedClass : undefined}>
                {(() => { const p = profiles.find(p => p.id === effectiveProfileId); return p ? profileDisplayName(p, t) : null })()}
              </span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {profiles.map(p => (
              <SelectItem key={p.id} value={p.id}>
                <span className={matchedProfileIds.has(p.id) ? matchedClass : undefined}>{profileDisplayName(p, t)}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Prompt preset select (director only) */}
      {showPresets && (
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">{t("slot.preset")}</label>
          <Select value={effectivePresetId} onValueChange={(v) => handlePresetChange(v as string)} onOpenChange={(open) => { if (open) onRefresh?.() }}>
            <SelectTrigger className="w-full">
              <SelectValue>
                <span className={matchedPresetIds.has(effectivePresetId) ? matchedClass : undefined}>
                  {(() => { const p = presets!.find(p => p.id === effectivePresetId); return p ? presetDisplayName(p, t) : null })()}
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {presets!.map(p => (
                <SelectItem key={p.id} value={p.id}>
                  <span className={matchedPresetIds.has(p.id) ? matchedClass : undefined}>{presetDisplayName(p, t)}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  )
}
