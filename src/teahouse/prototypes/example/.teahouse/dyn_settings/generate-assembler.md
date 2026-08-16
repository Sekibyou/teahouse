${@note 
    # 正文生成组装器

    > **用途**：Generate 配置的组装器中转文件。yaml 只写「历史正文 + 用户正文要求」，本文件中转承载**设定与变量维护要求**的全部组织逻辑（含 `{{}}` 文件引用、`${}` 变量、条件切片）。yaml 用 `{{.teahouse/dyn_settings/generate-assembler.md}}` 整文件引用本文件，通过 resolve_variables 的多轮循环递归展开嵌套 `{{}}`。
    >
    > **位置**：放在 `.teahouse/dyn_settings/`（创作者预置、入 git），不随总结变动。**路径基准**：本文件内占位符路径一律相对实例根目录（static_settings 在根，dyn_settings 带完整 `.teahouse/` 前缀）。
}

————生成要求开始————
{{static_settings/完整章节生成要求.md}}
————生成要求结束————

————设定开始————
{{.teahouse/dyn_settings/characters.md}}
{{static_settings/world.md}}
————设定结束————

${@note 
    如果要让正文直接维护变量的话，需要移除掉注释
    ————变量维护要求开始————
    {{static_settings/正文变量维护规则.md}}
    {{.teahouse/dyn_settings/正文助手维护的变量.md}}
    ————变量维护要求结束————
}
