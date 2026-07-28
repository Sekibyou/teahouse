# 插件模板目录

此目录存放全局插件模板。用户通过「设置 → 管理插件 → 导入插件」上传 .zip 包后，插件会被安装到 `data/{用户名}/plugins/` 下。

如需手动安装，直接将插件文件夹复制到 `data/{用户名}/plugins/` 即可。

## 插件结构

```
my-plugin/
  plugin.json      必需 — 元数据、权限声明、工具定义
  backend.py       可选 — 后端钩子和工具执行器
  frontend/        可选 — 前端配置面板
    index.html
```

## 测试

开发阶段可使用 `mock-service` 插件测试：

1. 复制 `tests/mock-service-plugin/` 到 `data/{用户名}/plugins/`
2. 启动 mock echo 服务：`python tests/mock_echo_server.py`
3. 在「设置 → 管理插件」中启用并配置 token

详见 `tests/sandbox-design.md` 中的插件系统设计文档。
