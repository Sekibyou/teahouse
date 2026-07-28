/**
 * 文本占位符替换工具
 *
 * 替换文本中的 {{variable_name}} 占位符为实际的变量值
 *
 * 功能：
 * - 简单占位符语法：{{variable_name}}
 * - 列表索引访问：{{list_var[0]}}、{{list_var[-1]}}
 * - 字典字段访问：{{dict_var.field}}、{{dict_var["field"]}}
 * - 递归替换（最多 5 层）
 * - 循环引用检测
 * - 列表/字典转换为字符串表示
 * - 未定义变量返回空字符串
 *
 * 示例：
 *   text = "Hello, {{player_name}}! Your HP is {{player_hp}}."
 *   variables = { player_name: "Low Star", player_hp: 100 }
 *   result = substituteText(text, variables)
 *   // result: "Hello, Low Star! Your HP is 100."
 *
 *   // 列表索引
 *   variables = { items: ["sword", "shield", "potion"] }
 *   substituteText("{{items[0]}}", variables)  // "sword"
 *   substituteText("{{items[-1]}}", variables) // "potion"
 *
 *   // 字典字段
 *   variables = { player: { name: "Star", level: 5 } }
 *   substituteText("{{player.name}}", variables)     // "Star"
 *   substituteText('{{player["name"]}}', variables)   // "Star"
 */

/** 变量名标识符 */
const VAR_NAME = String.raw`[a-zA-Z_\u4e00-\u9fff][a-zA-Z0-9_\u4e00-\u9fff]*`;

/** 占位符匹配模式 */
const PLACEHOLDER_PATTERN = new RegExp(
  String.raw`\{\{(${VAR_NAME}(?:\[-?\d+\]|\.${VAR_NAME}|\["[^"]*"\])?)\}\}`,
  "g"
);

/** 解析表达式的正则 */
const EXPR_PATTERN = new RegExp(
  String.raw`^(${VAR_NAME})(?:\[(-?\d+)\]|\.(${VAR_NAME})|\["([^"]*)"\])?$`
);

/** 最大递归深度 */
const MAX_RECURSION_DEPTH = 5;

/**
 * 解析占位符表达式，返回 [变量名, 访问器]
 *
 * 访问器类型：
 * - undefined: 无访问器，直接取变量值
 * - number: 列表索引
 * - string: 字典字段名
 */
function parseExpression(expr: string): [string, number | string | undefined] {
  const m = EXPR_PATTERN.exec(expr);
  if (!m) return [expr, undefined];

  const varName = m[1];
  if (m[2] !== undefined) {
    // [index] 形式
    return [varName, parseInt(m[2], 10)];
  } else if (m[3] !== undefined) {
    // .field 形式
    return [varName, m[3]];
  } else if (m[4] !== undefined) {
    // ["field"] 形式
    return [varName, m[4]];
  }
  return [varName, undefined];
}

/**
 * 通过访问器从变量值中提取子值
 */
function accessValue(value: unknown, accessor: number | string | undefined): unknown {
  if (accessor === undefined) return value;

  if (typeof accessor === "number") {
    // 列表索引访问
    if (Array.isArray(value)) {
      const index = accessor < 0 ? value.length + accessor : accessor;
      if (index >= 0 && index < value.length) {
        return value[index];
      }
    }
    return undefined;
  }

  if (typeof accessor === "string") {
    // 字典字段访问
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      if (accessor in obj) {
        return obj[accessor];
      }
    }
    return undefined;
  }

  return undefined;
}

/**
 * 将值转换为字符串表示
 */
function valueToString(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "number" || typeof value === "string") {
    return String(value);
  }

  if (Array.isArray(value)) {
    // 格式: [item1, item2, item3]
    const items = value.map(item => valueToString(item));
    return "[" + items.join(", ") + "]";
  }

  if (typeof value === "object") {
    // 格式: {key1: value1, key2: value2}
    const items = Object.entries(value).map(
      ([k, v]) => `${k}: ${valueToString(v)}`
    );
    return "{" + items.join(", ") + "}";
  }

  return String(value);
}

/**
 * 递归替换占位符（内部实现）
 */
function substituteRecursive(
  text: string,
  variables: Record<string, unknown>,
  depth: number,
  visiting: Set<string>
): string {
  // 基本情况：深度耗尽或没有占位符
  if (depth <= 0) {
    return text;
  }

  return text.replace(PLACEHOLDER_PATTERN, (_match, expr: string) => {
    const [varName, accessor] = parseExpression(expr);

    // 检查未定义变量
    if (!(varName in variables)) {
      return ""; // 返回空字符串
    }

    // 检查循环引用
    if (visiting.has(varName)) {
      return ""; // 返回空字符串
    }

    let value = variables[varName];

    // 应用访问器提取子值
    if (accessor !== undefined) {
      value = accessValue(value, accessor);
      if (value === undefined) {
        return "";
      }
    }

    const valueStr = valueToString(value);

    // 如果值是字符串且包含占位符，递归替换
    if (typeof value === "string" && PLACEHOLDER_PATTERN.test(valueStr)) {
      const newVisiting = new Set(visiting);
      newVisiting.add(varName);

      // 重置正则表达式的 lastIndex
      PLACEHOLDER_PATTERN.lastIndex = 0;

      return substituteRecursive(
        valueStr,
        variables,
        depth - 1,
        newVisiting
      );
    }

    return valueStr;
  });
}

/**
 * 替换文本中的占位符
 *
 * @param text 包含 {{variable_name}} 占位符的文本
 * @param variables 变量字典
 * @param maxDepth 最大递归深度（默认 5）
 * @returns 替换后的文本
 */
export function substituteText(
  text: string,
  variables: Record<string, unknown>,
  maxDepth: number = MAX_RECURSION_DEPTH
): string {
  // 重置正则表达式的 lastIndex
  PLACEHOLDER_PATTERN.lastIndex = 0;

  return substituteRecursive(text, variables, maxDepth, new Set());
}

/**
 * 查找文本中的所有占位符的基础变量名
 *
 * 对于 {{var[0]}} 或 {{var.field}} 形式，返回基础变量名 "var"
 *
 * @param text 要搜索的文本
 * @returns 基础变量名列表（不含 {{}} 和访问器）
 */
export function findPlaceholders(text: string): string[] {
  // 重置正则表达式的 lastIndex
  PLACEHOLDER_PATTERN.lastIndex = 0;

  const matches = text.matchAll(PLACEHOLDER_PATTERN);
  return Array.from(matches, m => {
    const [varName] = parseExpression(m[1]);
    return varName;
  });
}

/**
 * 验证所有占位符都有对应的变量
 *
 * @param text 要验证的文本
 * @param variables 变量字典
 * @returns [是否有效, 缺失的变量列表]
 */
export function validatePlaceholders(
  text: string,
  variables: Record<string, unknown>
): [boolean, string[]] {
  const placeholders = findPlaceholders(text);
  const missing = placeholders.filter(p => !(p in variables));
  return [missing.length === 0, missing];
}
