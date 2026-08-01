# 插件 UI 设计指南

插件前端是完全独立的 HTML 页面，通过 iframe + `srcdoc` 渲染，与主程序 CSS 隔离。
`PluginPanel` 会自动注入基准主题样式，提供
[color-scheme](https://developer.mozilla.org/en-US/docs/Web/CSS/color-scheme)、背景色、文字色、
输入框颜色——插件只需使用继承变量即可获得可读的默认外观。

## 自动注入的主题变量

`PluginPanel` 在加载插件 HTML 时自动注入以下 `:root` 样式：

| 属性 | Light | Dark |
|---|---|---|
| `color-scheme` | `light` | `dark` |
| `background-color` | `#ffffff` | `#171717` |
| `color` | `#171717` | `#e5e5e5` |

输入框 (`input, textarea, select`) 也会被注入对应的 dark/light 样式。

**插件应使用 `background: transparent` 和 `color: inherit`**，这样无需任何额外工作就能继承正确的主题色。

## 主程序颜色 Token

如果插件希望与主程序 UI 保持更精确的视觉一致，可参考以下颜色映射。
主程序使用 shadcn/ui + Tailwind CSS v4，颜色空间为 OKLCH。

| Token | Light | Dark | 用途 |
|---|---|---|---|
| `--background` | `#ffffff` | `#171717` | 页面/面板背景 |
| `--foreground` | `#171717` | `#fafafa` | 主文字色 |
| `--muted` | `#f7f7f7` | `#404040` | 次级背景 |
| `--muted-foreground` | `#737373` | `#a3a3a3` | 次级文字、提示 |
| `--border` | `#e5e5e5` | `#404040` | 边框 |
| `--input` | `#e5e5e5` | `#404040` | 输入框边框 |
| `--primary` | `#1e293b` | `#fafafa` | 主色（按钮背景等） |
| `--primary-foreground` | `#fafafa` | `#1e293b` | 主色上的文字 |
| `--destructive` | `#dc2626` | `#dc2626` | 危险操作（删除等） |
| `--destructive-foreground` | `#fafafa` | `#fafafa` | 危险操作上的文字 |
| `--ring` | `#1e293b` | `#6b7280` | 焦点环 |

> 颜色值来自 OKLCH 的 sRGB 近似。主程序的精确值见 `teahouse-frontend/src/styles/globals.css`。

## 主题切换

如需在插件内部检测主题变化，可通过 postMessage `init` 事件携带的 `theme` 字段：

```js
window.addEventListener('message', (e) => {
  const d = e.data;
  if (d.type === 'init') {
    console.log('当前主题:', d.theme); // "dark" | "light"
  }
});
```

PluginPanel 注入的 `:root` 样式已自动处理了颜色切换，大多数情况下插件无需手动检测主题。

## UI 片段

以下是主程序常用 UI 元素的 CSS 近似实现，可直接复制使用。

### 按钮

```css
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  height: 2rem;
  padding: 0 0.625rem;
  border: 1px solid transparent;
  border-radius: 6px;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
  outline: none;
  white-space: nowrap;
}
.btn:disabled {
  opacity: 0.5;
  cursor: default;
}

/* 主按钮 */
.btn-primary {
  background: #1e293b;
  color: #fafafa;
}
.btn-primary:hover { opacity: 0.9; }

/* outline 按钮 */
.btn-outline {
  background: transparent;
  border-color: #e5e5e5;
  color: inherit;
}
.btn-outline:hover { background: rgba(128,128,128,0.1); }

/* ghost 按钮 */
.btn-ghost {
  background: transparent;
  color: inherit;
}
.btn-ghost:hover { background: rgba(128,128,128,0.1); }

/* 危险按钮 */
.btn-destructive {
  background: rgba(220,38,38,0.1);
  color: #dc2626;
}
.btn-destructive:hover { background: rgba(220,38,38,0.2); }
```

### 输入框

```css
.input {
  width: 100%;
  padding: 0.5rem 0.625rem;
  border: 1px solid rgba(128,128,128,0.3);
  border-radius: 6px;
  font-size: 0.813rem;
  background: transparent;
  color: inherit;
  outline: none;
}
.input:focus {
  border-color: #6366f1;
  box-shadow: 0 0 0 3px rgba(99,102,241,0.2);
}
```

### 标签/徽章

```css
.badge {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.125rem 0.375rem;
  border-radius: 4px;
  font-size: 0.625rem;
  font-weight: 500;
  background: rgba(128,128,128,0.1);
  color: inherit;
  opacity: 0.7;
}
```

### 提示文字

```css
.hint {
  font-size: 0.688rem;
  opacity: 0.5;
}

.muted-text {
  color: inherit;
  opacity: 0.7;
}
```

### 卡片/面板

```css
.card {
  border: 1px solid rgba(128,128,128,0.2);
  border-radius: 8px;
  padding: 1rem;
}
```

## 布局建议

- 插件内容区域使用 `padding: 16px`，与主程序内边距一致
- 垂直间距使用 `8px / 12px / 16px` 的步进，避免过大的间距
- 最大宽度不设限制，iframe 容器会自动管理尺寸
- 不要在插件内使用 `position: fixed` 做全屏遮罩——iframe 边界会裁剪

## postMessage 协议

插件通过 `window.parent.postMessage()` 与主程序通信：

| 方向 | type | 说明 |
|---|---|---|
| 插件 → 宿主 | `ready` | 插件加载完成，携带 `pluginId` |
| 宿主 → 插件 | `init` | 初始化响应，携带 `pluginId` 和 `theme` |
| 插件 → 宿主 | `getData` | 读取存储的配置，携带 `key` |
| 宿主 → 插件 | `data` | 返回配置数据，携带 `key` 和 `value` |
| 插件 → 宿主 | `setData` | 保存配置，携带 `key` 和 `value` |
| 宿主 → 插件 | `saved` | 保存成功确认 |
| 宿主 → 插件 | `error` | 错误信息，携带 `message` |
