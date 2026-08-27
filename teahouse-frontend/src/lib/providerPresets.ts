/**
 * 主流 API 供应商一键预设。
 *
 * 每个预设提供 name / api_url（基础 URL）/ api_format，用户点击徽章后自动填充创建表单，
 * 只需粘贴 api_key 即可一键创建供应商。
 *
 * ⚠️ api_url 这里给的是【基础 URL】（如 https://api.deepseek.com），而非完整端点。
 * 后端 normalize_api_url（src/teahouse/routes/llm_providers.py）会根据 api_format 与
 * 是否已含版本路径，自动派生出两个链接：
 *   - 聊天端点：   https://api.deepseek.com/v1/chat/completions
 *   - 模型列表：   https://api.deepseek.com/v1/models（由前端 computeModelFetchUrl 派生）
 *
 * 对于版本化 base（智谱 /v4、火山 /v3、千帆 /v2、通义 compatible-mode/v1、Gemini /v1beta/），
 * normalize 会识别 `/vN` 路径直接追加端点，不会错误地再补一层 `/v1`。
 */

export type ProviderApiFormat = "openai" | "openai_strict" | "anthropic"

export interface ProviderPreset {
  /** 稳定 key，如 "deepseek" */
  id: string
  /** 品牌显示名（专有名词，直写即可，不走 i18n） */
  label: string
  /** 徽章缩写（1~2 字符） */
  short: string
  /** 品牌色 hex，徽章底色 */
  color: string
  /** 前景色（默认白） */
  fg?: string
  /** 基础 URL（后端自动派生聊天/模型端点） */
  api_url: string
  api_format: ProviderApiFormat
  /** 获取 API key 的官网链接（hover 提示用） */
  officialUrl: string
}

export interface ProviderGroup {
  key: string
  name: string
  items: ProviderPreset[]
}

export const PROVIDER_GROUPS: ProviderGroup[] = [
  {
    key: "domestic",
    name: "provider.groupDomestic",
    items: [
      { id: "deepseek", label: "DeepSeek", short: "深", color: "#4D6BFE", api_url: "https://api.deepseek.com", api_format: "openai", officialUrl: "https://platform.deepseek.com" },
      { id: "kimi", label: "Kimi（月之暗面）", short: "K", color: "#101014", fg: "#FFFFFF", api_url: "https://api.moonshot.cn", api_format: "openai", officialUrl: "https://platform.moonshot.cn" },
      { id: "zhipu", label: "智谱 GLM", short: "智", color: "#3859FF", api_url: "https://open.bigmodel.cn/api/paas/v4", api_format: "openai", officialUrl: "https://open.bigmodel.cn" },
      { id: "dashscope", label: "通义千问 DashScope", short: "通", color: "#00B4FF", api_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", api_format: "openai", officialUrl: "https://bailian.console.aliyun.com" },
      { id: "ark", label: "火山方舟·豆包", short: "火", color: "#FF4D4F", api_url: "https://ark.cn-beijing.volces.com/api/v3", api_format: "openai", officialUrl: "https://console.volcengine.com/ark" },
      { id: "minimax", label: "MiniMax", short: "M", color: "#00BFA5", api_url: "https://api.minimax.chat", api_format: "openai", officialUrl: "https://platform.minimaxi.com" },
      { id: "stepfun", label: "阶跃星辰 StepFun", short: "跃", color: "#7C3AED", api_url: "https://api.stepfun.com", api_format: "openai", officialUrl: "https://platform.stepfun.com" },
      { id: "siliconflow", label: "硅基流动 SiliconFlow", short: "硅", color: "#5B5BD6", api_url: "https://api.siliconflow.cn", api_format: "openai", officialUrl: "https://cloud.siliconflow.cn" },
      { id: "hunyuan", label: "腾讯混元 Hunyuan", short: "混", color: "#006EFF", api_url: "https://api.hunyuan.cloud.tencent.com", api_format: "openai", officialUrl: "https://cloud.tencent.com/product/hunyuan" },
      { id: "qianfan", label: "百度千帆 Qianfan", short: "千", color: "#2932E1", api_url: "https://qianfan.baidubce.com/v2", api_format: "openai", officialUrl: "https://qianfan.cloud.baidu.com" },
      { id: "spark", label: "讯飞星火 Spark", short: "星", color: "#FF7D00", api_url: "https://spark-api-open.xf-yun.com", api_format: "openai", officialUrl: "https://xinghuo.xfyun.cn" },
    ],
  },
  {
    key: "international",
    name: "provider.groupInternational",
    items: [
      { id: "openai", label: "OpenAI", short: "O", color: "#000000", fg: "#FFFFFF", api_url: "https://api.openai.com", api_format: "openai", officialUrl: "https://platform.openai.com" },
      { id: "anthropic", label: "Anthropic Claude", short: "C", color: "#D97757", api_url: "https://api.anthropic.com", api_format: "anthropic", officialUrl: "https://console.anthropic.com" },
      { id: "gemini", label: "Google Gemini", short: "G", color: "#4285F4", api_url: "https://generativelanguage.googleapis.com/v1beta/openai", api_format: "openai", officialUrl: "https://aistudio.google.com" },
      { id: "openrouter", label: "OpenRouter", short: "OR", color: "#6E56CF", api_url: "https://openrouter.ai/api", api_format: "openai", officialUrl: "https://openrouter.ai" },
      { id: "groq", label: "Groq", short: "G", color: "#F55036", api_url: "https://api.groq.com/openai", api_format: "openai", officialUrl: "https://console.groq.com" },
      { id: "xai", label: "xAI Grok", short: "X", color: "#1C1C1E", fg: "#FFFFFF", api_url: "https://api.x.ai", api_format: "openai", officialUrl: "https://console.x.ai" },
    ],
  },
]
