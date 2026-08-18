import { useState, useEffect, useMemo } from "react"
import { toast } from "sonner"
import type { SlotBinding, LLMModel, ModelProfile, DirectorPromptPreset } from "@/lib/types"
import { llmSlotsApi } from "@/lib/api"

interface SlotCardProps {
  slotId: "director" | "writer"
  label: string
  binding: SlotBinding
  models: LLMModel[]
  profiles: ModelProfile[]
  presets?: DirectorPromptPreset[]
  onChange: (binding: SlotBinding) => void
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

export function SlotCard({ slotId, label, binding, models, profiles, presets, onChange }: SlotCardProps) {
  const [selectedModelId, setSelectedModelId] = useState<string>(binding.model_id || "")
  const [selectedProfileId, setSelectedProfileId] = useState<string>(binding.profile_id || "")
  const [selectedPresetId, setSelectedPresetId] = useState<string>(binding.prompt_preset_id || "")
  const [matchedProfileIds, setMatchedProfileIds] = useState<Set<string>>(new Set())
  const [matchedPresetIds, setMatchedPresetIds] = useState<Set<string>>(new Set())
  const [userPickedProfile, setUserPickedProfile] = useState(false)
  const [userPickedPreset, setUserPickedPreset] = useState(false)

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

  const handleModelChange = (modelId: string) => {
    setSelectedModelId(modelId)
    setUserPickedProfile(false)
    setUserPickedPreset(false)
    onChange({ model_id: modelId || null, profile_id: null, prompt_preset_id: null })
  }

  const handleProfileChange = (profileId: string) => {
    setSelectedProfileId(profileId)
    setUserPickedProfile(true)
    onChange({ ...binding, profile_id: profileId || null })
  }

  const handlePresetChange = (presetId: string) => {
    setSelectedPresetId(presetId)
    setUserPickedPreset(true)
    onChange({ ...binding, prompt_preset_id: presetId || null })
  }

  const handleSave = async () => {
    const modelId = selectedModelId || null
    const profileId = selectedProfileId || null
    const presetId = showPresets ? (selectedPresetId || null) : null
    if (!modelId) {
      toast.error("请先选择一个模型")
      return
    }
    const result = await llmSlotsApi.setSlot(slotId, {
      model_id: modelId,
      profile_id: profileId,
      prompt_preset_id: presetId,
    })
    if (result.ok) {
      onChange({ model_id: modelId, profile_id: profileId, prompt_preset_id: presetId })
      toast.success(`${label} 槽位已保存`)
    } else {
      toast.error(result.error || "保存失败")
    }
  }

  const enabledModels = models.filter(m => m.is_enabled)

  return (
    <div className="border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="font-semibold text-sm">{label}</h4>
      </div>

      {/* Model select */}
      <div>
        <label className="text-xs text-muted-foreground mb-1 block">模型</label>
        <select
          className="w-full border rounded px-2 py-1 text-sm bg-background"
          value={selectedModelId}
          onChange={e => handleModelChange(e.target.value)}
        >
          <option value="">-- None --</option>
          {enabledModels.map(m => (
            <option key={m.id} value={m.id}>
              {m.name} ({m.provider_name})
            </option>
          ))}
        </select>
      </div>

      {/* Profile select */}
      <div>
        <label className="text-xs text-muted-foreground mb-1 block">参数预设</label>
        <select
          className="w-full border rounded px-2 py-1 text-sm bg-background"
          value={effectiveProfileId}
          onChange={e => handleProfileChange(e.target.value)}
        >
          {profiles.map(p => (
            <option
              key={p.id}
              value={p.id}
              style={matchedProfileIds.has(p.id) ? { color: "#b8860b", fontWeight: 600 } : undefined}
            >
              {p.name}
            </option>
          ))}
        </select>
      </div>

      {/* Prompt preset select (director only) */}
      {showPresets && (
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">导演提示词预设</label>
          <select
            className="w-full border rounded px-2 py-1 text-sm bg-background"
            value={effectivePresetId}
            onChange={e => handlePresetChange(e.target.value)}
          >
            {presets!.map(p => (
              <option key={p.id} value={p.id}
                style={matchedPresetIds && matchedPresetIds.has(p.id) ? { color: "#b8860b", fontWeight: 600 } : undefined}
              >
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="flex justify-end">
        <button
          className="bg-primary text-primary-foreground rounded px-4 py-1.5 text-sm hover:bg-primary/90"
          onClick={handleSave}
        >
          保存
        </button>
      </div>
    </div>
  )
}
