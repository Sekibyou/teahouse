/**
 * 中文资源字典。第一阶段 key 值 = 中文原文，作为未来多语言翻译的基础。
 * 组件替换过程中逐步填充各命名空间。
 *
 * 每个命名空间独立成文件，便于并行组件改造互不冲突；此处统一聚合导出。
 */
import { zhCommon } from "./common"
import { zhSettings } from "./settings"
import { zhWorkspace } from "./workspace"
import { zhChat } from "./chat"
import { zhGit } from "./git"
import { zhSession } from "./session"
import { zhLogin } from "./login"
import { zhPlugin } from "./plugin"
import { zhMisc } from "./misc"

export const resourceZh = {
  common: zhCommon,
  settings: zhSettings,
  workspace: zhWorkspace,
  chat: zhChat,
  git: zhGit,
  session: zhSession,
  login: zhLogin,
  plugin: zhPlugin,
  misc: zhMisc,
}
