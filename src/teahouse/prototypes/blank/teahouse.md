# 实例配置

## 工作内容定义

/* 此处写导演的工作内容，比如：设定助手，前端搭建等等 */

## 楼层配置

/* 每一楼大约多少字，如果是创作型的原型的话则可以不用写 */

## 总结规则

/* 总结频率建议，如果是创作型的原型的话则可以不用写 */

## 输出块 label 命名规则

/* 输出块的 label 命名规范，也就是 output 命令输出的块的 label 字段，需与前端渲染和筛选进行对齐 */

## Generate Payload 配置文件

每次调用 Generate 都需要一个 YAML 配置文件（`source_file` 参数），用于组织发送给正文模型的消息结构。配置文件支持 `{{path}}` 占位符引用文件内容，占位符在 Generate 执行时自动展开。

### 工作流

1. **首次创作**：从 `settings/generate-config-default.yaml` 复制到 `temp/generate-config-{N}-1.yaml`
2. **续写**：复制上一楼层的 config 到新文件名，修改引用范围和变量状态描述
3. **返工**：同一楼层版本号递增，如 `generate-config-{N}-2.yaml` → `generate-config-{N}-3.yaml`
4. **Generate 调用**：`Generate(source_file="temp/generate-config-{N}-{V}.yaml", path="temp/draft-{N}-{V}.md")`

### 文件清理

楼层确认提交后：
- 删除旧版本 config 文件，仅保留最新版本
- 将最新 config 改名为 `generate-config-{N+1}-1.yaml`（下一楼层的起点）

### dump_payload_path 参数

`dump_payload_path` 是可选 **dry-run** 参数，填入路径后把展开占位符后的完整 Payload JSON 写入该路径并**立即返回，不调用正文模型**。用于调试时查看实际发给模型的 payload 内容。**不建议主动使用**，除非用户明确要求调试。

## 用户意图 → Skill 路由