/**
 * HTML 和 Markdown 渲染工具
 *
 * 使用 marked 解析 Markdown，使用 DOMPurify 防止 XSS 攻击
 * 支持 HTML 和 Markdown 混合使用
 *
 * 基于 teahouse_old 的实现方案
 */

import { marked } from 'marked';
import DOMPurify, { type Config as DOMPurifyConfig } from 'dompurify';
import { applyTextStyleRules } from '@/lib/applyTextStyleRules';
import { parseBBCode } from '@/lib/bbcodeParser';
import type { TextStyleRule } from '@/lib/types';

// DOMPurify 安全配置（基于 teahouse_old 的配置）
const DOMPURIFY_CONFIG: DOMPurifyConfig = {
  ALLOWED_TAGS: [
    // 文本格式
    'p', 'br', 'span', 'div',
    'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'mark', 'sub', 'sup',
    // 标题
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    // 列表
    'ul', 'ol', 'li',
    // 引用和代码
    'blockquote', 'pre', 'code',
    // 链接
    'a',
    // 表格
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    // 可折叠内容
    'details', 'summary',
    // 其他
    'hr',
  ],
  ALLOWED_ATTR: [
    'class', 'id', 'style',
    'href', 'target', 'rel',
    'colspan', 'rowspan',
    'open',  // details 标签的展开状态属性
    'data-tip-text',  // BBCode [tip] —— 气泡提示文案，纯数据属性，无执行风险；由 getBBCodeTooltipScript() 读取
  ],
  // 防止 javascript: 等危险协议
  ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|data):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
};

// 配置 marked 选项
marked.setOptions({
  breaks: true,        // 支持 GFM 换行（单个换行符转为 <br>）
  gfm: true,           // 启用 GitHub Flavored Markdown
});

/**
 * BBCode 生成的是内联 <span>，marked 不会处理内部的换行。
 * 此函数对多行 BBCode span 内部递归将 \n 替换为 <br>\n，
 * 使内部内容在 marked 渲染时正常换行。
 *
 * 单行 span（如 [b]/[i]）不受影响。
 * 代码块内容（包含 ```）跳过，由 preprocessHtmlBlocks 处理。
 */
function highlightMultilineSpans(html: string): string {
  const SPAN_RE = /(<span\b[^>]*>)([\s\S]*?)(<\/span>)/gi;

  return html.replace(SPAN_RE, (full, openTag, inner, closeTag) => {
    if (!inner.includes('\n')) return full;

    // 递归处理嵌套 span
    const processedInner = highlightMultilineSpans(inner);

    // 跳过代码块——让 marked 单独处理
    if (processedInner.includes('```')) return `${openTag}${processedInner}${closeTag}`;

    // 将 \n 替换为 <br>\n，marked 会保留 <br>
    const withBreaks = processedInner.replace(/\n/g, '<br>\n');

    return `${openTag}${withBreaks}${closeTag}`;
  });
}

/**
 * 预处理 HTML 块元素内部的 Markdown
 *
 * marked.js 默认不会解析 HTML 块元素（如 <details>）内部的 Markdown 语法
 * 此函数会递归处理这些块元素内部的内容
 *
 * @param text - 原始文本
 * @returns 预处理后的文本
 */
function preprocessHtmlBlocks(text: string): string {
  // 匹配 <details>...</details> 块（支持嵌套）
  // 使用非贪婪匹配，但需要处理嵌套情况
  const detailsRegex = /<details(\s[^>]*)?>[\s\S]*?<\/details>/gi;

  return text.replace(detailsRegex, (match) => {
    // 提取 opening tag
    const openTagMatch = match.match(/^<details(\s[^>]*)?>/i);
    if (!openTagMatch) return match;

    const openTag = openTagMatch[0];
    const closeTag = '</details>';

    // 提取内部内容
    let inner = match.slice(openTag.length, match.length - closeTag.length);

    // 处理 <summary> 标签
    const summaryRegex = /^(\s*<summary>)([\s\S]*?)(<\/summary>)/i;
    const summaryMatch = inner.match(summaryRegex);

    let summaryPart = '';
    let contentPart = inner;

    if (summaryMatch) {
      // summary 内部也需要解析 Markdown
      const summaryContent = summaryMatch[2];
      const parsedSummaryContent = marked.parse(summaryContent.trim(), { async: false }) as string;
      // 移除 marked 生成的外层 <p> 标签（如果有）
      const cleanSummaryContent = parsedSummaryContent.replace(/^<p>([\s\S]*)<\/p>\s*$/i, '$1').trim();
      summaryPart = `<summary>${cleanSummaryContent}</summary>`;
      contentPart = inner.slice(summaryMatch[0].length);
    }

    // 递归处理内部内容中的其他 HTML 块
    contentPart = preprocessHtmlBlocks(contentPart);

    // 解析内部内容的 Markdown
    const parsedContent = marked.parse(contentPart.trim(), { async: false }) as string;

    return `${openTag}${summaryPart}${parsedContent}${closeTag}`;
  });
}

/**
 * 渲染文本内容（支持 HTML、Markdown 和 BBCode 混合）
 *
 * 处理流程：
 * 1. 解析 BBCode 标签（先处理，避免与 Markdown 冲突）
 * 2. 预处理 HTML 块元素（如 <details>）内部的 Markdown
 * 3. 使用 marked 解析 Markdown（会保留 HTML 标签）
 * 4. 使用 DOMPurify 清洗 HTML（防止 XSS）
 * 5. 应用文本样式规则（符号着色，在 HTML 解析之后）
 *
 * @param text - 原始文本（可包含 HTML 标签、Markdown 语法和 BBCode）
 * @param textStyleRules - 文本样式规则列表（可选）
 * @returns 安全的 HTML 字符串
 */
// renderText 缓存（避免重复处理相同文本）
const _renderTextCache = new Map<string, string>();
const _RENDER_TEXT_CACHE_MAX = 500;

// 文本样式规则指纹缓存
let _rulesFingerprint = '';
let _lastRulesRef: TextStyleRule[] | undefined;

function getRulesFingerprint(rules?: TextStyleRule[]): string {
  if (!rules || rules.length === 0) return '';
  if (rules === _lastRulesRef) return _rulesFingerprint;
  _lastRulesRef = rules;
  _rulesFingerprint = rules
    .filter(r => r.enabled)
    .map(r => `${r.start_symbol}|${r.end_symbol}|${r.start_html}|${r.end_html}|${r.order}`)
    .join('__');
  return _rulesFingerprint;
}

/**
 * 清除 renderText 缓存（在样式规则变更时调用）
 */
export function clearRenderTextCache(): void {
  _renderTextCache.clear();
  _lastRulesRef = undefined;
  _rulesFingerprint = '';
}

export function renderText(text: string, textStyleRules?: TextStyleRule[]): string {
  if (!text) return '';

  // 检查缓存
  const cacheKey = text + '\0' + getRulesFingerprint(textStyleRules);
  const cached = _renderTextCache.get(cacheKey);
  if (cached !== undefined) return cached;

  // 0. 预处理：禁用 Markdown 列表语法。在列表标记符（数字. / - / *）后插入
  //    零宽空格，视觉无差异但 marked 不会将其识别为 <ol>/<ul>，避免缩进。
  //    需要列表时请自行使用缩进或 HTML。
  const text0 = text
    .replace(/^(\d+)\.(\s)/gm, '$1.​$2')
    .replace(/^([-*])(\s)/gm, '$1​$2')
    // 去掉行首的 4 空格 / tab 缩进，防止 marked 将其识别为代码块 (<pre><code>)。
    // BBCode 内容通常会带缩进（导演输出），但 marked 的 4 空格规则会导致
    // BBCode 生成的 HTML 被转义为实体。
    .replace(/^( {4}|\t)/gm, '');

  // 1. 解析 BBCode（在 Markdown 之前，避免冲突）
  let html = parseBBCode(text0);

  // 1.5 对多行 BBCode span 内部做 \n → <br> 转换，使内部内容在 marked
  //    渲染时正常换行。单行 span 不受影响。
  html = highlightMultilineSpans(html);

  // 2. 应用文本样式规则（在 Markdown 之前，避免 marked 将 " 转义为 &quot;
  //    导致规则匹配失败。此时 BBCode 已转为 HTML 标签。）
  let styledHtml = html;
  if (textStyleRules && textStyleRules.length > 0) {
    const enabledRules = textStyleRules
      .filter(rule => rule.enabled)
      .sort((a, b) => a.order - b.order);

    if (enabledRules.length > 0) {
      styledHtml = applyTextStyleRules(html, enabledRules);
    }
  }

  // 3. 预处理 HTML 块元素（如 <details>）内部的 Markdown
  const preprocessedHtml = preprocessHtmlBlocks(styledHtml);

  // 4. 使用 marked 解析 Markdown（marked 自动保留 HTML 标签）
  const result = marked.parse(preprocessedHtml, { async: false }) as string;

  // 写入缓存（LRU：超出上限时删除最旧条目）
  if (_renderTextCache.size >= _RENDER_TEXT_CACHE_MAX) {
    const firstKey = _renderTextCache.keys().next().value;
    if (firstKey !== undefined) _renderTextCache.delete(firstKey);
  }
  _renderTextCache.set(cacheKey, result);

  return result;
}

/**
 * 仅解析 Markdown（不支持 HTML 标签）
 *
 * @param text - Markdown 文本
 * @returns 安全的 HTML 字符串
 */
export function parseMarkdown(text: string): string {
  if (!text) return '';

  const parsedHtml = marked.parse(text, { async: false }) as string;
  const sanitizedHtml = DOMPurify.sanitize(parsedHtml, {
    ...DOMPURIFY_CONFIG,
    // 移除所有 HTML 标签，只保留 Markdown 生成的标签
    ALLOWED_TAGS: DOMPURIFY_CONFIG.ALLOWED_TAGS,
  }) as unknown as string;

  return sanitizedHtml;
}

/**
 * 转义 HTML 特殊字符（用于纯文本显示）
 *
 * @param text - 原始文本
 * @returns 转义后的文本
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * 反转义 HTML 特殊字符
 *
 * @param text - 转义后的文本
 * @returns 原始文本
 */
export function unescapeHtml(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}

// ===== 旧版兼容函数（保持向后兼容） =====

/**
 * @deprecated 使用 renderText 代替
 * 清理 HTML，只保留安全标签和属性
 */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, DOMPURIFY_CONFIG) as unknown as string;
}