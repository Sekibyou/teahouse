import type { SetupReadyFlags } from "@/hooks/useSetupStatus"

export type WizardTab = "models" | "profiles" | "presets" | "slots"

/** 硬门槛步骤：全绿才算配置完成，未完成时隐藏「新建实例」。 */
export interface RequiredStep {
  key: keyof SetupReadyFlags
  tab: WizardTab
  title: string
  desc: string
}

export const REQUIRED_STEPS: RequiredStep[] = [
  {
    key: "providerReady",
    tab: "models",
    title: "添加供应商",
    desc: "配置一个 API 供应商（地址、Key、格式），作为模型的来源。",
  },
  {
    key: "modelReady",
    tab: "models",
    title: "导入模型",
    desc: "进入「模型池」从供应商拉取并导入模型，启用至少一个。",
  },
  {
    key: "slotsReady",
    tab: "slots",
    title: "指定正文模型",
    desc: "为「导演+正文」两个槽位各绑定一个已启用的模型，才能开始小说创作。",
  },
]

/** 推荐步骤：非硬门槛，做了体验更好。 */
export interface RecommendedStep {
  key: keyof SetupReadyFlags
  tab: WizardTab
  title: string
  desc: string
}

export const RECOMMENDED_STEPS: RecommendedStep[] = [
  {
    key: "profileReady",
    tab: "profiles",
    title: "配置参数预设",
    desc: "为模型设定 temperature、上下文长度等参数，正文更贴合你的风格。",
  },
  {
    key: "presetReady",
    tab: "presets",
    title: "选用导演提示词预设",
    desc: "定义导演如何驱动创作流程；内置预设可直接选用。",
  },
]
