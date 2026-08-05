# 插件配置 UI 指南

插件系统的配置面板是**声明式**的：插件在 `plugin.json` 里声明 `config` schema，宿主前端统一渲染成表单。插件**不再支持**自由 HTML iframe 前端。

## 为什么声明式

- 插件定位为**网络桥接器**，配置需求是"label + 输入/开关/下拉"这类参数收集，声明式天然覆盖。
- 高度自适应：宿主按内容渲染，不再有 iframe 的 280px 固定高度问题。
- 样式/交互统一：复用宿主 shadcn 组件，跨插件视觉一致。
- **配置阶段零网络零动作**：配置面板只收集参数，不触发后端、不发网络。网络活动发生在实例运行时：

| 场景 | 怎么处理 |
|---|---|
| 单次往返（测试连接、调一次 API） | 导演直接调插件 tool，结果进对话/输出 |
| 持续网络活动（轮询、流、状态） | 插件写变量 → 沙盒 `Teahouse.getVars()` 实时渲染 |

## config schema

`plugin.json` 的 `config` 字段是**元件数组**，每项一个配置。渲染顺序即数组顺序。

```jsonc
{
  "id": "mock-service",
  "...": "...",
  "config": [
    {
      "key": "url",
      "type": "text",
      "label": "Echo 服务 URL",
      "default": "http://127.0.0.1:9999/",
      "help": "第三方 echo 服务地址"
    },
    {
      "key": "token",
      "type": "password",
      "label": "Token",
      "default": ""
    }
  ]
}
```

### 通用字段（所有元件）

| 字段 | 类型 | 说明 |
|---|---|---|
| `key` | string (必填) | 写入 plugin_data 的键名 |
| `type` | string (必填) | 元件类型，见下表 |
| `label` | string (必填) | 输入框左侧显示的文字 |
| `default` | string\|number\|boolean | 展开时若 plugin_data 无此键，用它初始化 |
| `help` | string (可选) | label 下方的说明文字 |

### 元件类型

| type | 渲染 | 额外字段 |
|---|---|---|
| `text` | 单行文本输入 | — |
| `password` | 密码输入（掩码） | — |
| `number` | 数字输入 | `min`、`max` |
| `textarea` | 多行文本输入 | — |
| `switch` | 开关（布尔） | 存 `"true"` / `"false"` |
| `select` | 下拉单选 | `options: [{value, label}]` |

### select 示例

```jsonc
{
  "key": "protocol",
  "type": "select",
  "label": "协议",
  "default": "https",
  "options": [
    { "value": "http", "label": "HTTP" },
    { "value": "https", "label": "HTTPS" }
  ]
}
```

## 配置面板时序

1. **展开配置面板** → 宿主 GET `plugin_data` 取最新值快照，初始化表单（缺省字段用元件 `default`）。
2. **用户编辑** → 只改本地 draft，**不落库**。
3. **点保存** → 一次性 PUT 全部字段。
4. **关闭面板** → 丢弃 draft。

### 未保存修改提醒

宿主实时比对"当前表单"与"展开时快照"。若有修改，保存按钮旁显示一行「有未保存修改」，**不拦截**、不弹窗、不做退出防护。

## permission：frontend

`permissions` 里的 `frontend` 表示"该插件有声明式配置面板"。保留该标记是为了向后兼容；宿主据此决定是否显示"展开配置面板"按钮。

## 数据读写

插件后端通过 `PluginContext.get_data()/set_data()` 读取配置，与配置面板共享同一份 `plugin_data`（按插件+用户隔离、加密存储）。
