/**
 * 内置预设（参数预设 / 导演提示词预设）的名字在后端建表时硬编码为中文，
 * 不可改名也不参与 i18n。展示时一律按 `is_builtin` 判定后取翻译，
 * 不要去匹配 name 字符串——那样一旦后端改名或老库残留就会失配。
 *
 * 传入的 t 允许来自任意命名空间：这里显式写全 `settings:` 前缀，
 * 资源在 initI18n 时已全量载入，跨命名空间取值有效。
 */
type Builtin = { is_builtin?: number | boolean | null; name: string }

type Translate = (key: string) => string

/** 参数预设显示名 */
export function profileDisplayName(p: Builtin, t: Translate): string {
  return p.is_builtin ? t("settings:profile.builtinName") : p.name
}

/** 导演提示词预设显示名 */
export function presetDisplayName(p: Builtin, t: Translate): string {
  return p.is_builtin ? t("settings:preset.builtinName") : p.name
}
