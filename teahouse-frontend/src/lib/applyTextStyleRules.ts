/**
 * 应用文本样式规则
 *
 * 在 Markdown/HTML 渲染之后，根据规则对特定符号进行 HTML 着色
 * 支持避开已有的 HTML 标签，防止破坏 HTML 结构
 */

import type { TextStyleRule } from "@/lib/types";

/**
 * HTML 片段类型
 */
interface HtmlSegment {
  type: 'text' | 'tag';
  content: string;
  index: number; // 在原字符串中的起始位置
}

/**
 * 将 HTML 字符串分割为文本和标签片段
 *
 * 同时识别 HTML 标签 <> 和 BBCode 标签 []
 *
 * 例如: "hello <span>world</span>!" ->
 * [
 *   { type: 'text', content: 'hello ', index: 0 },
 *   { type: 'tag', content: '<span>', index: 6 },
 *   { type: 'text', content: 'world', index: 12 },
 *   { type: 'tag', content: '</span>', index: 17 },
 *   { type: 'text', content: '!', index: 24 }
 * ]
 */
function splitHtmlSegments(html: string): HtmlSegment[] {
  const segments: HtmlSegment[] = [];
  let currentIndex = 0;
  let textStart = 0;

  while (currentIndex < html.length) {
    // 查找下一个标签（HTML 或 BBCode）
    const nextHtmlTag = html.indexOf('<', currentIndex);

    // 查找下一个合法的 BBCode 标签（[后面必须紧跟字母或/，如 [b]、[color=red]、[/b]）
    // 避免把 JSON 数组的 [] 等普通方括号误判为 BBCode 标签
    let nextBBCodeTag = -1;
    let searchFrom = currentIndex;
    while (true) {
      const candidate = html.indexOf('[', searchFrom);
      if (candidate === -1) break;
      const nextChar = html[candidate + 1];
      if (nextChar && (/[a-zA-Z/]/.test(nextChar))) {
        nextBBCodeTag = candidate;
        break;
      }
      // 不是合法 BBCode 开头，继续往后找
      searchFrom = candidate + 1;
    }

    // 确定最近的标签位置
    let tagStart = -1;
    let tagType: 'html' | 'bbcode' | null = null;

    if (nextHtmlTag !== -1 && nextBBCodeTag !== -1) {
      if (nextHtmlTag < nextBBCodeTag) {
        tagStart = nextHtmlTag;
        tagType = 'html';
      } else {
        tagStart = nextBBCodeTag;
        tagType = 'bbcode';
      }
    } else if (nextHtmlTag !== -1) {
      tagStart = nextHtmlTag;
      tagType = 'html';
    } else if (nextBBCodeTag !== -1) {
      tagStart = nextBBCodeTag;
      tagType = 'bbcode';
    }

    if (tagStart === -1) {
      // 没有更多标签，剩余部分都是文本
      if (textStart < html.length) {
        segments.push({
          type: 'text',
          content: html.slice(textStart),
          index: textStart,
        });
      }
      break;
    }

    // 如果标签前有文本，添加文本片段
    if (tagStart > textStart) {
      segments.push({
        type: 'text',
        content: html.slice(textStart, tagStart),
        index: textStart,
      });
    }

    // 查找标签结束位置
    const endChar = tagType === 'html' ? '>' : ']';
    const tagEnd = html.indexOf(endChar, tagStart);

    if (tagEnd === -1) {
      // 没有找到标签结束，剩余部分作为文本
      segments.push({
        type: 'text',
        content: html.slice(tagStart),
        index: tagStart,
      });
      break;
    }

    // 添加标签片段
    segments.push({
      type: 'tag',
      content: html.slice(tagStart, tagEnd + 1),
      index: tagStart,
    });

    // 更新索引
    currentIndex = tagEnd + 1;
    textStart = tagEnd + 1;
  }

  return segments;
}

/**
 * 应用文本样式规则到 HTML 内容
 *
 * 新策略：跨 HTML 标签匹配符号对
 * 1. 先提取所有纯文本内容（去除 HTML 标签，并跳过代码块/行内代码）
 * 2. 在纯文本中查找符号对的位置
 * 3. 在原 HTML 中对应的文本位置插入样式标签
 *
 * @param html 已经过 BBCode 解析但尚未经过 Markdown 解析的 HTML 字符串
 * @param rules 文本样式规则列表（已按 order 排序，只包含启用的规则）
 * @returns 处理后的 HTML
 */
export function applyTextStyleRules(html: string, rules: TextStyleRule[]): string {
  if (!html || rules.length === 0) {
    return html;
  }

  // 只使用启用的规则
  const enabledRules = rules.filter(rule => rule.enabled);
  if (enabledRules.length === 0) {
    return html;
  }

  // 找出代码块和行内代码区域，这些区域不应该参与样式规则匹配
  const codeRegions = findCodeRegions(html);

  // 按 order 顺序依次应用规则
  let result = html;
  for (const rule of enabledRules) {
    result = applyRuleToHtml(result, rule, codeRegions);
  }

  return result;
}

/**
 * 代码区域（不应参与样式规则匹配）
 */
interface CodeRegion {
  start: number;  // 在原 HTML 中的起始位置（包含）
  end: number;    // 在原 HTML 中的结束位置（不包含）
}

/**
 * 查找代码块（```...```）和行内代码（`...`）区域
 * 此时输入尚未经过 marked 解析，代码是 Markdown 原始语法
 */
function findCodeRegions(html: string): CodeRegion[] {
  const regions: CodeRegion[] = [];

  // 1. 查找代码块 ``` ... ```
  const codeBlockRegex = /```[\s\S]*?```/g;
  let match: RegExpExecArray | null;
  while ((match = codeBlockRegex.exec(html)) !== null) {
    regions.push({ start: match.index, end: match.index + match[0].length });
  }

  // 2. 查找行内代码 `...`
  // 使用非反引号字符匹配，避免把代码块的反引号也匹配进来
  // 先找出所有不在代码块内的行内代码
  const inlineCodeRegex = /`([^`]+)`/g;
  while ((match = inlineCodeRegex.exec(html)) !== null) {
    const mStart = match.index;
    const mEnd = match.index + match[0].length;
    // 检查是否在已有的代码块区域内
    const isInRegion = regions.some(r => r.start <= mStart && mEnd <= r.end);
    if (!isInRegion) {
      regions.push({ start: mStart, end: mEnd });
    }
  }

  // 按起始位置排序
  regions.sort((a, b) => a.start - b.start);

  return regions;
}

/**
 * 检查指定位置是否在代码区域内
 */
function isInCodeRegion(position: number, codeRegions: CodeRegion[]): boolean {
  for (const region of codeRegions) {
    if (position >= region.start && position < region.end) {
      return true;
    }
  }
  return false;
}

/**
 * 应用单个规则到 HTML（跨标签匹配）
 */
function applyRuleToHtml(html: string, rule: TextStyleRule, codeRegions: CodeRegion[]): string {
  const { start_symbol, end_symbol, start_html, end_html } = rule;

  // 1. 分割 HTML 为文本和标签片段
  const segments = splitHtmlSegments(html);

  // 2. 提取纯文本内容（用于匹配符号对）
  const textSegments = segments.filter(s => s.type === 'text');
  const pureText = textSegments.map(s => s.content).join('');

  // 3. 在纯文本中查找所有符号对的位置
  const matches = findSymbolPairs(pureText, start_symbol, end_symbol);

  if (matches.length === 0) {
    return html; // 没有匹配，直接返回
  }

  // 4. 将纯文本位置映射回原 HTML 的文本片段位置
  // 构建映射：纯文本索引 -> (segment索引, segment内偏移)
  const textIndexMap: Array<{ segmentIndex: number; offset: number }> = [];
  let pureTextIndex = 0;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.type === 'text') {
      for (let j = 0; j < segment.content.length; j++) {
        textIndexMap[pureTextIndex] = { segmentIndex: i, offset: j };
        pureTextIndex++;
      }
    }
  }

  // 5. 为每个匹配插入样式标签
  // 先过滤掉落在代码区域内的匹配
  const validMatches = matches.filter(m => {
    const startMap = textIndexMap[m.start];
    const endMap = textIndexMap[m.end - 1];
    if (!startMap || !endMap) return false;

    // 将 pure text 位置转换回原 HTML 位置
    const startSegment = segments[startMap.segmentIndex];
    const endSegment = segments[endMap.segmentIndex];
    const startHtmlPos = startSegment.index + startMap.offset;
    const endHtmlPos = endSegment.index + endMap.offset;

    return !isInCodeRegion(startHtmlPos, codeRegions) && !isInCodeRegion(endHtmlPos, codeRegions);
  });

  // 从后向前处理，避免索引偏移问题
  for (let i = validMatches.length - 1; i >= 0; i--) {
    const match = validMatches[i];

    // 获取开始和结束位置在原 HTML 中的 segment 位置
    const startPos = textIndexMap[match.start];
    const endPos = textIndexMap[match.end - 1]; // end 是不包含的，所以 -1

    if (!startPos || !endPos) continue;

    // 在开始位置插入 start_html
    const startSegment = segments[startPos.segmentIndex];
    if (startSegment.type === 'text') {
      startSegment.content =
        startSegment.content.slice(0, startPos.offset) +
        start_html +
        startSegment.content.slice(startPos.offset);
    }

    // 在结束位置插入 end_html
    const endSegment = segments[endPos.segmentIndex];
    if (endSegment.type === 'text') {
      // 如果是同一个 segment，需要考虑前面插入的 start_html 长度
      const extraOffset = (startPos.segmentIndex === endPos.segmentIndex) ? start_html.length : 0;
      endSegment.content =
        endSegment.content.slice(0, endPos.offset + 1 + extraOffset) +
        end_html +
        endSegment.content.slice(endPos.offset + 1 + extraOffset);
    }

    // 更新后续的映射（因为插入了新内容）
    // 注意：由于我们从后向前处理，不需要更新映射
  }

  // 6. 重新组合 HTML
  return segments.map(s => s.content).join('');
}

/**
 * 在文本中查找所有符号对的位置
 *
 * @returns 匹配结果数组，每个元素包含 { start, end } 位置
 */
function findSymbolPairs(
  text: string,
  startSymbol: string,
  endSymbol: string
): Array<{ start: number; end: number }> {
  const matches: Array<{ start: number; end: number }> = [];

  // 转义正则表达式特殊字符
  const escapeRegex = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startEscaped = escapeRegex(startSymbol);
  const endEscaped = escapeRegex(endSymbol);

  if (startSymbol === endSymbol) {
    // 开始和结束符号相同（如引号）
    const regex = new RegExp(`${startEscaped}((?:(?!${endEscaped}).)+?)${endEscaped}`, 'g');
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      matches.push({
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  } else {
    // 开始和结束符号不同
    const regex = new RegExp(`${startEscaped}((?:(?!${endEscaped}).)*?)${endEscaped}`, 'g');
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      matches.push({
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }

  return matches;
}

/**
 * 从规则列表中筛选并排序启用的规则
 *
 * @param rules 原始规则列表
 * @returns 启用的规则，按 order 排序
 */
export function getEnabledRulesSorted(rules: TextStyleRule[]): TextStyleRule[] {
  return rules
    .filter(rule => rule.enabled)
    .sort((a, b) => a.order - b.order);
}
