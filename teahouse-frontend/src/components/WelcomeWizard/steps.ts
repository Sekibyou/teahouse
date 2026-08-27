import type { SetupReadyFlags } from "@/hooks/useSetupStatus"

export type WizardTab = "models" | "profiles" | "presets" | "slots"

/** 硬门槛步骤：全绿才算配置完成，未完成时隐藏「新建实例」。 */
export interface RequiredStep {
  key: keyof SetupReadyFlags
  tab: WizardTab
  /** i18n key（misc 命名空间），文案见 wizard.steps.<key> */
  titleKey: string
  descKey: string
}

export const REQUIRED_STEPS: RequiredStep[] = [
  {
    key: "providerReady",
    tab: "models",
    titleKey: "wizard.steps.providerReady.title",
    descKey: "wizard.steps.providerReady.desc",
  },
  {
    key: "modelReady",
    tab: "models",
    titleKey: "wizard.steps.modelReady.title",
    descKey: "wizard.steps.modelReady.desc",
  },
  {
    key: "slotsReady",
    tab: "slots",
    titleKey: "wizard.steps.slotsReady.title",
    descKey: "wizard.steps.slotsReady.desc",
  },
]

/** 推荐步骤：非硬门槛，做了体验更好。 */
export interface RecommendedStep {
  key: keyof SetupReadyFlags
  tab: WizardTab
  titleKey: string
  descKey: string
}

export const RECOMMENDED_STEPS: RecommendedStep[] = [
  {
    key: "profileReady",
    tab: "profiles",
    titleKey: "wizard.steps.profileReady.title",
    descKey: "wizard.steps.profileReady.desc",
  },
  {
    key: "presetReady",
    tab: "presets",
    titleKey: "wizard.steps.presetReady.title",
    descKey: "wizard.steps.presetReady.desc",
  },
]
