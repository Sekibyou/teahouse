/**
 * BBCode 解析器
 *
 * 支持标准 BBCode 标签和自定义动画特效
 *
 * 标准标签:
 * - [b]粗体[/b]
 * - [i]斜体[/i]
 * - [u]下划线[/u]
 * - [s]删除线[/s]
 * - [color=#fff]颜色[/color]
 * - [size=20]字号[/size]
 *
 * 动画特效:
 * - [shake]抖动[/shake]
 * - [fade]淡入淡出[/fade]
 * - [bounce]弹跳[/bounce]
 * - [wave]波浪[/wave]
 * - [rainbow]彩虹[/rainbow]
 * - [glow]发光[/glow]
 */

/**
 * BBCode 标签定义
 */
interface BBCodeTag {
  /** 标签名称（小写） */
  name: string;
  /** 是否支持参数（如 [color=#fff]） */
  hasParam?: boolean;
  /** 转换为 HTML 的函数 */
  toHtml: (content: string, param?: string) => string;
}

/**
 * 标准 BBCode 标签
 */
const STANDARD_TAGS: BBCodeTag[] = [
  {
    name: 'b',
    toHtml: (content) => `<strong>${content}</strong>`,
  },
  {
    name: 'i',
    toHtml: (content) => `<em>${content}</em>`,
  },
  {
    name: 'u',
    toHtml: (content) => `<u>${content}</u>`,
  },
  {
    name: 's',
    toHtml: (content) => `<s>${content}</s>`,
  },
  {
    name: 'color',
    hasParam: true,
    toHtml: (content, param) => {
      const color = param || '#ffffff';
      return `<span style="color: ${escapeHtml(color)}">${content}</span>`;
    },
  },
  {
    name: 'size',
    hasParam: true,
    toHtml: (content, param) => {
      const size = param || '16';
      return `<span style="font-size: ${escapeHtml(size)}px">${content}</span>`;
    },
  },
];

/**
 * 动画特效标签
 *
 * 支持参数化配置，使用 CSS 变量实现动态效果
 * 参数格式：[tag param1=value1 param2=value2]content[/tag]
 */
const ANIMATION_TAGS: BBCodeTag[] = [
  {
    name: 'shake',
    hasParam: true,
    toHtml: (content, param) => {
      const style = parseAnimationParams(param, {
        rate: '0.5s',      // 抖动速度
        level: '2',        // 抖动幅度（像素）
      });
      return `<span class="bbcode-shake" style="${style}">${content}</span>`;
    },
  },
  {
    name: 'fade',
    hasParam: true,
    toHtml: (content, param) => {
      const style = parseAnimationParams(param, {
        rate: '2s',        // 淡入淡出速度
        min: '0.3',        // 最小透明度
      });
      return `<span class="bbcode-fade" style="${style}">${content}</span>`;
    },
  },
  {
    name: 'bounce',
    hasParam: true,
    toHtml: (content, param) => {
      const style = parseAnimationParams(param, {
        rate: '0.6s',      // 弹跳速度
        level: '10',       // 弹跳高度（像素）
      });
      return `<span class="bbcode-bounce" style="${style}">${content}</span>`;
    },
  },
  {
    name: 'wave',
    hasParam: true,
    toHtml: (content, param) => {
      const style = parseAnimationParams(param, {
        rate: '1s',        // 波浪速度
        level: '5',        // 波浪幅度（像素）
      });
      // 将内容拆分成字符，但保留 HTML 标签
      const chars = splitContentIntoChars(content);
      const wrappedChars = chars.map((item, index) => {
        if (item.isTag) {
          // HTML 标签直接保留
          return item.content;
        } else {
          // 文本字符包裹在 span 中，添加动画延迟
          const delay = `calc(var(--bbcode-rate, 1s) * ${index} / 10)`;
          return `<span class="bbcode-wave-char" style="animation-delay: ${delay}">${item.content === ' ' ? '&nbsp;' : escapeHtml(item.content)}</span>`;
        }
      }).join('');
      return `<span class="bbcode-wave" style="${style}">${wrappedChars}</span>`;
    },
  },
  {
    name: 'rainbow',
    hasParam: true,
    toHtml: (content, param) => {
      const style = parseAnimationParams(param, {
        rate: '3s',        // 彩虹速度
      });
      return `<span class="bbcode-rainbow" style="${style}">${content}</span>`;
    },
  },
  {
    name: 'glow',
    hasParam: true,
    toHtml: (content, param) => {
      const style = parseAnimationParams(param, {
        rate: '2s',        // 发光速度
        color: 'currentColor', // 发光颜色
        level: '20',       // 发光强度（像素）
      });
      return `<span class="bbcode-glow" style="${style}">${content}</span>`;
    },
  },
  {
    name: 'pulse',
    hasParam: true,
    toHtml: (content, param) => {
      const style = parseAnimationParams(param, {
        rate: '1s',        // 脉冲速度
        level: '1.1',      // 缩放比例
      });
      return `<span class="bbcode-pulse" style="${style}">${content}</span>`;
    },
  },
  {
    name: 'typing',
    toHtml: (content) => `<span class="bbcode-typing">${content}</span>`,
  },
];

/**
 * 所有支持的标签
 */
const ALL_TAGS = [...STANDARD_TAGS, ...ANIMATION_TAGS];

/**
 * 转义 HTML 特殊字符
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * 将内容拆分成字符和 HTML 标签
 *
 * 例如: "hello<span>world</span>" ->
 * [
 *   { isTag: false, content: 'h' },
 *   { isTag: false, content: 'e' },
 *   { isTag: false, content: 'l' },
 *   { isTag: false, content: 'l' },
 *   { isTag: false, content: 'o' },
 *   { isTag: true, content: '<span>' },
 *   { isTag: false, content: 'w' },
 *   { isTag: false, content: 'o' },
 *   { isTag: false, content: 'r' },
 *   { isTag: false, content: 'l' },
 *   { isTag: false, content: 'd' },
 *   { isTag: true, content: '</span>' }
 * ]
 */
function splitContentIntoChars(content: string): Array<{ isTag: boolean; content: string }> {
  const result: Array<{ isTag: boolean; content: string }> = [];
  let currentIndex = 0;

  while (currentIndex < content.length) {
    // 查找下一个 HTML 标签
    const tagStart = content.indexOf('<', currentIndex);

    if (tagStart === -1) {
      // 没有更多标签，将剩余字符逐个添加
      for (let i = currentIndex; i < content.length; i++) {
        result.push({ isTag: false, content: content[i] });
      }
      break;
    }

    // 添加标签前的字符
    for (let i = currentIndex; i < tagStart; i++) {
      result.push({ isTag: false, content: content[i] });
    }

    // 查找标签结束
    const tagEnd = content.indexOf('>', tagStart);
    if (tagEnd === -1) {
      // 没有找到标签结束，将剩余部分作为文本处理
      for (let i = tagStart; i < content.length; i++) {
        result.push({ isTag: false, content: content[i] });
      }
      break;
    }

    // 添加标签
    result.push({ isTag: true, content: content.slice(tagStart, tagEnd + 1) });

    currentIndex = tagEnd + 1;
  }

  return result;
}

/**
 * 解析动画参数
 *
 * 支持格式：
 * - [shake rate=0.5s level=5]  - 多个参数用空格分隔
 * - rate=0.5s level=5          - 直接传入参数字符串
 *
 * @param paramStr 参数字符串
 * @param defaults 默认值
 * @returns CSS 变量样式字符串
 */
function parseAnimationParams(
  paramStr: string | undefined,
  defaults: Record<string, string>
): string {
  if (!paramStr) {
    // 没有参数，使用默认值
    return Object.entries(defaults)
      .map(([key, value]) => `--bbcode-${key}: ${escapeHtml(value)}`)
      .join('; ');
  }

  // 解析参数：rate=0.5s level=5
  const params: Record<string, string> = {};
  const regex = /(\w+)=([^\s]+)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(paramStr)) !== null) {
    const key = match[1];
    const value = match[2];
    params[key] = value;
  }

  // 合并默认值和用户参数
  const merged = { ...defaults, ...params };

  // 生成 CSS 变量
  return Object.entries(merged)
    .map(([key, value]) => `--bbcode-${key}: ${escapeHtml(value)}`)
    .join('; ');
}

/**
 * BBCode 标签匹配结果
 */
interface BBCodeMatch {
  /** 完整匹配字符串 */
  fullMatch: string;
  /** 标签名称 */
  tagName: string;
  /** 标签参数（如果有） */
  param?: string;
  /** 标签内容 */
  content: string;
  /** 起始位置 */
  startIndex: number;
  /** 结束位置 */
  endIndex: number;
}

/**
 * 解析 BBCode 标签
 *
 * 支持嵌套标签
 *
 * @param text 原始文本
 * @returns 解析后的 HTML
 */
export function parseBBCode(text: string): string {
  if (!text) return '';

  // 递归处理嵌套标签
  return processText(text);
}

/**
 * 处理文本（递归）
 */
function processText(text: string): string {
  // 查找所有标签的匹配
  const matches: BBCodeMatch[] = [];

  for (const tag of ALL_TAGS) {
    const tagMatches = findTagMatches(text, tag);
    matches.push(...tagMatches);
  }

  // 如果没有匹配，直接返回
  if (matches.length === 0) {
    return text;
  }

  // 按起始位置排序
  matches.sort((a, b) => a.startIndex - b.startIndex);

  // 过滤掉重叠的匹配（保留最外层的标签）
  const filteredMatches = filterOverlappingMatches(matches);

  // 处理匹配（从后往前，避免索引偏移）
  let result = text;
  for (let i = filteredMatches.length - 1; i >= 0; i--) {
    const match = filteredMatches[i];
    const tag = ALL_TAGS.find(t => t.name === match.tagName);
    if (!tag) continue;

    // 递归处理内容（支持嵌套）
    const processedContent = processText(match.content);

    // 转换为 HTML
    const html = tag.toHtml(processedContent, match.param);

    // 替换原文本
    result =
      result.slice(0, match.startIndex) +
      html +
      result.slice(match.endIndex);
  }

  return result;
}

/**
 * 过滤重叠的匹配（保留最外层的标签）
 *
 * 例如：[a][b]text[/b][/a] 会匹配到两个：
 * - [a]...[/a] (0-17)
 * - [b]...[/b] (3-14)
 * 只保留外层的 [a]...[/a]，内层的 [b] 会在递归时处理
 */
function filterOverlappingMatches(matches: BBCodeMatch[]): BBCodeMatch[] {
  if (matches.length <= 1) return matches;

  const result: BBCodeMatch[] = [];

  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    let isOverlapped = false;

    // 检查是否被其他匹配完全包含
    for (let j = 0; j < matches.length; j++) {
      if (i === j) continue;

      const other = matches[j];

      // 如果 current 被 other 完全包含，则跳过 current
      if (
        other.startIndex <= current.startIndex &&
        other.endIndex >= current.endIndex &&
        !(other.startIndex === current.startIndex && other.endIndex === current.endIndex)
      ) {
        isOverlapped = true;
        break;
      }
    }

    if (!isOverlapped) {
      result.push(current);
    }
  }

  return result;
}

/**
 * 查找指定标签的所有匹配
 *
 * 使用平衡括号匹配算法，支持相同标签的嵌套
 *
 * 支持三种格式：
 * 1. [tag]content[/tag] - 无参数
 * 2. [tag=param]content[/tag] - 旧式单参数
 * 3. [tag param1=value1 param2=value2]content[/tag] - 新式多参数
 */
function findTagMatches(text: string, tag: BBCodeTag): BBCodeMatch[] {
  const matches: BBCodeMatch[] = [];
  let searchStart = 0;

  while (searchStart < text.length) {
    // 查找开始标签的三种形式
    const openTagPatterns = [];

    if (tag.hasParam) {
      // 新式多参数: [tag param1=value1]
      openTagPatterns.push({
        pattern: new RegExp(`\\[${tag.name}\\s+([^\\]]+)\\]`, 'i'),
        type: 'multi-param' as const,
      });
      // 旧式单参数: [tag=param]
      openTagPatterns.push({
        pattern: new RegExp(`\\[${tag.name}=([^\\]]+)\\]`, 'i'),
        type: 'single-param' as const,
      });
    }
    // 无参数: [tag]
    openTagPatterns.push({
      pattern: new RegExp(`\\[${tag.name}\\]`, 'i'),
      type: 'no-param' as const,
    });

    // 查找最近的开始标签
    let nearestMatch: {
      match: RegExpMatchArray;
      type: 'multi-param' | 'single-param' | 'no-param';
      index: number;
    } | null = null;

    for (const { pattern, type } of openTagPatterns) {
      const match = text.slice(searchStart).match(pattern);
      if (match && match.index !== undefined) {
        const absoluteIndex = searchStart + match.index;
        if (!nearestMatch || absoluteIndex < nearestMatch.index) {
          nearestMatch = { match, type, index: absoluteIndex };
        }
      }
    }

    if (!nearestMatch) break;

    const openTagIndex = nearestMatch.index;
    const openTagLength = nearestMatch.match[0].length;
    const param = nearestMatch.match[1]; // 参数（如果有）

    // 使用平衡括号匹配查找对应的结束标签
    const closeTag = `[/${tag.name}]`;
    let depth = 1;
    let currentIndex = openTagIndex + openTagLength;

    while (currentIndex < text.length && depth > 0) {
      // 查找下一个开始标签或结束标签
      const nextOpenIndex = text.indexOf(`[${tag.name}`, currentIndex);
      const nextCloseIndex = text.indexOf(closeTag, currentIndex);

      // 验证 nextOpenIndex 是否是完整的开始标签
      let validOpenIndex = -1;
      if (nextOpenIndex !== -1) {
        const afterTag = text[nextOpenIndex + tag.name.length + 1];
        if (afterTag === ']' || afterTag === '=' || afterTag === ' ') {
          validOpenIndex = nextOpenIndex;
        }
      }

      if (nextCloseIndex === -1) {
        // 没有找到结束标签
        break;
      }

      if (validOpenIndex !== -1 && validOpenIndex < nextCloseIndex) {
        // 找到嵌套的开始标签
        depth++;
        currentIndex = validOpenIndex + tag.name.length + 2;
      } else {
        // 找到结束标签
        depth--;
        if (depth === 0) {
          // 找到匹配的结束标签
          const content = text.slice(openTagIndex + openTagLength, nextCloseIndex);
          matches.push({
            fullMatch: text.slice(openTagIndex, nextCloseIndex + closeTag.length),
            tagName: tag.name,
            param,
            content,
            startIndex: openTagIndex,
            endIndex: nextCloseIndex + closeTag.length,
          });
          searchStart = nextCloseIndex + closeTag.length;
          break;
        } else {
          currentIndex = nextCloseIndex + closeTag.length;
        }
      }
    }

    if (depth > 0) {
      // 没有找到匹配的结束标签，跳过这个开始标签
      searchStart = openTagIndex + openTagLength;
    }
  }

  return matches;
}

/**
 * 获取 BBCode 动画样式 CSS
 *
 * 这个 CSS 应该被注入到消息框的样式中
 */
export function getBBCodeAnimationCSS(): string {
  return `
/* BBCode 动画特效样式 */

/* 抖动 */
@keyframes bbcode-shake {
  0%, 100% { transform: translateX(0); }
  10%, 30%, 50%, 70%, 90% { transform: translateX(calc(var(--bbcode-level, 2) * -1px)); }
  20%, 40%, 60%, 80% { transform: translateX(calc(var(--bbcode-level, 2) * 1px)); }
}
.bbcode-shake {
  display: inline-block;
  animation: bbcode-shake var(--bbcode-rate, 0.5s) ease-in-out infinite;
}

/* 淡入淡出 */
@keyframes bbcode-fade {
  0%, 100% { opacity: 1; }
  50% { opacity: var(--bbcode-min, 0.3); }
}
.bbcode-fade {
  animation: bbcode-fade var(--bbcode-rate, 2s) ease-in-out infinite;
}

/* 弹跳 */
@keyframes bbcode-bounce {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(calc(var(--bbcode-level, 10) * -1px)); }
}
.bbcode-bounce {
  display: inline-block;
  animation: bbcode-bounce var(--bbcode-rate, 0.6s) ease-in-out infinite;
}

/* 波浪 */
@keyframes bbcode-wave {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(calc(var(--bbcode-level, 5) * -1px)); }
}
.bbcode-wave {
  display: inline-block;
}
.bbcode-wave-char {
  display: inline-block;
  animation: bbcode-wave var(--bbcode-rate, 1s) ease-in-out infinite;
}

/* 彩虹 */
@keyframes bbcode-rainbow {
  0% { color: #ff0000; }
  16% { color: #ff7f00; }
  33% { color: #ffff00; }
  50% { color: #00ff00; }
  66% { color: #0000ff; }
  83% { color: #8b00ff; }
  100% { color: #ff0000; }
}
.bbcode-rainbow {
  animation: bbcode-rainbow var(--bbcode-rate, 3s) linear infinite;
}

/* 发光 */
@keyframes bbcode-glow {
  0%, 100% {
    text-shadow: 0 0 5px var(--bbcode-color, currentColor);
  }
  50% {
    text-shadow:
      0 0 calc(var(--bbcode-level, 20) * 1px) var(--bbcode-color, currentColor),
      0 0 calc(var(--bbcode-level, 20) * 1.5px) var(--bbcode-color, currentColor);
  }
}
.bbcode-glow {
  animation: bbcode-glow var(--bbcode-rate, 2s) ease-in-out infinite;
}

/* 脉冲 */
@keyframes bbcode-pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(var(--bbcode-level, 1.1)); }
}
.bbcode-pulse {
  display: inline-block;
  animation: bbcode-pulse var(--bbcode-rate, 1s) ease-in-out infinite;
}

/* 打字机效果（仅显示，不实现真正的逐字显示） */
.bbcode-typing {
  display: inline-block;
  border-right: 2px solid currentColor;
  animation: bbcode-typing-cursor 0.7s step-end infinite;
}
@keyframes bbcode-typing-cursor {
  0%, 100% { border-color: currentColor; }
  50% { border-color: transparent; }
}
`;
}

/**
 * 获取支持的 BBCode 标签列表（用于文档或帮助）
 */
export function getSupportedBBCodeTags(): string[] {
  return ALL_TAGS.map(tag => {
    if (tag.hasParam) {
      return `[${tag.name}=param]...[/${tag.name}]`;
    } else {
      return `[${tag.name}]...[/${tag.name}]`;
    }
  });
}
