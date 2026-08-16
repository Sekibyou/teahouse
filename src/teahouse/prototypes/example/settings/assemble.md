${@note 
    # 设定组装器

    > **用途**：Generate 配置的组装器中转文件。yaml 只写「历史正文 + 用户正文要求」，本文件中转承载**设定与生成要求**的全部组织逻辑（含 `{{}}` 文件引用、`${}` 变量、条件切片）。yaml 用 `{{settings/assemble.md}}` 整文件引用本文件，通过 resolve_variables 的多轮循环递归展开嵌套 `{{}}`。
    >
    > **位置**：放在 `settings/`（创作者预置、入 git），不随总结变动。**路径基准**：本文件内占位符路径一律相对实例根目录（`static_settings` 在 `settings/static_settings/`，`dyn_settings` 带 `settings/` 前缀）。
}

————生成要求开始————
{{settings/static_settings/chapter-requirements.md}}
————生成要求结束————

————设定开始————
{{settings/dyn_settings/characters.md}}
{{settings/static_settings/world.md}}
————设定结束————

${@note 
    如果要让正文直接维护变量的话，需要移除掉注释
    ————变量维护要求开始————
    {{settings/static_settings/variable-ops.md}}
    {{settings/key-vars.md}}
    ————变量维护要求结束————
    说明：key-vars.md 是作者声明的「正文 AI 需要看到并维护的变量清单」示例，
    随剧情强相关，按本实例实际变量增删；默认不启用，需要时移除本注释块引用它。
}
