import type { SetupReadyFlags } from "@/hooks/useSetupStatus"

export type WizardTab = "models" | "profiles" | "presets" | "slots"

/**
 * 向导清单的一步。**全部步骤都计入完成度分母**（x/5）：
 * - 未标 `skippable` = 硬门槛，必须真配好才能过；
 * - 标了 `skippable` = 推荐项（引擎有内置兜底），可点「跳过」直接算完成、不阻塞，
 *   但同样给一个跳转按钮，方便想建自己那份的用户一键过去。
 */
export interface WizardStep {
  key: keyof SetupReadyFlags
  tab: WizardTab
  /** i18n key（misc 命名空间），文案见 wizard.steps.<key> */
  titleKey: string
  descKey: string
  /** 跳转按钮文案的 i18n key，缺省用 wizard.goConfig */
  actionLabelKey?: string
  skippable?: boolean
}

export const WIZARD_STEPS: WizardStep[] = [
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
    actionLabelKey: "wizard.goSpecify",
  },
  {
    key: "profileReady",
    tab: "profiles",
    titleKey: "wizard.steps.profileReady.title",
    descKey: "wizard.steps.profileReady.desc",
    actionLabelKey: "wizard.goCreate",
    skippable: true,
  },
  {
    key: "presetReady",
    tab: "presets",
    titleKey: "wizard.steps.presetReady.title",
    descKey: "wizard.steps.presetReady.desc",
    actionLabelKey: "wizard.goCreate",
    skippable: true,
  },
]
