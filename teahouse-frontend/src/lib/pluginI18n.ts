export type PluginI18nDict = Record<string, Record<string, string>>

/**
 * 插件声明式 UI 文案的 i18n 解析。
 *
 * 插件作者可在 plugin.json 的 config.label/help/options[].label 以及
 * name/description 等字段写 `key:` 前缀，配合顶层
 * `i18n: { locale: { key: text } }` 字典按当前语言取文案；缺失或非
 * `key:` 前缀则原样回退（兼容旧插件与不完整字典）。
 */
export function resolvePluginText(
  value: string | undefined,
  dict: PluginI18nDict | undefined,
  lang: string,
): string {
  if (!value) return value ?? ""
  if (value.startsWith("key:") && dict) {
    const key = value.slice("key:".length)
    const langDict = dict[lang]
    if (langDict && key in langDict) return langDict[key]
  }
  return value
}
