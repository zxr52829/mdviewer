/**
 * 诊断：语法错误与警告。
 *
 * 对应 VS Code 的 DiagnosticCollection + 各语言 LanguageServer。
 * 这里的"语言服务"是同步的：输入全文，输出诊断数组。
 *
 * 分层：
 *   - JSON 家族（VALIDATABLE）：直接复用 json-service 的 validate()，
 *     它是真解析器，报出来的是精确的语法错误位置。
 *   - 其它语言：只能做词法 + 括号配对。highlighter.js 是状态机词法分析器，
 *     不是解析器 —— 它发现不了 `if (x { }` 这类语法级错误。
 *
 * 诚实边界：非 JSON 语言的诊断只覆盖词法级（未闭合字符串/块注释）
 * 与括号配对（未闭合/多余闭括号），不覆盖表达式级语法。
 * 这条与 README 里"补全是离线符号表不是语言服务"的说明同源。
 */

import { validate } from './json-service.js';
import { VALIDATABLE } from './registry.js';

/** 严重程度 */
export const SEVERITY = { error: 'error', warning: 'warning' };

/** 诊断来源，用于调试与分级解释 */
export const SOURCE = { json: 'json', lexer: 'lexer', bracket: 'bracket' };

/**
 * 各语言的词法特征。
 *
 * 与 brackets.js 里那份 lineComment 判定同源，但这里必须独立维护：
 * brackets.js 的扫描是逐行独立的（inBlock 每次重置），跨行块注释
 * 在第二行起会漏判；诊断必须跨行传递状态，不能直接复用。
 */
function lexicalTraits(languageId) {
  switch (languageId) {
    case 'json':
    case 'jsonc':
    case 'json5':
    case 'jsonl':
      return { lineComment: '//', blockComment: ['/*', '*/'], quotes: ['"'], template: null };
    case 'javascript':
    case 'typescript':
      return { lineComment: '//', blockComment: ['/*', '*/'], quotes: ['"', "'"], template: '`' };
    case 'css':
    case 'scss':
    case 'less':
      return { lineComment: '//', blockComment: ['/*', '*/'], quotes: ['"', "'"], template: null };
    case 'go':
    case 'rust':
    case 'java':
    case 'c':
    case 'cpp':
    case 'csharp':
    case 'php':
      return { lineComment: '//', blockComment: ['/*', '*/'], quotes: ['"', "'"], template: null };
    case 'python':
      // Python 没有块注释；三引号字符串跨行，单行扫描无法闭合，故不追踪
      return { lineComment: '#', blockComment: null, quotes: ['"', "'"], template: null };
    case 'ruby':
      return { lineComment: '#', blockComment: null, quotes: ['"', "'"], template: null };
    case 'shell':
    case 'powershell':
    case 'yaml':
    case 'toml':
    case 'ini':
      return { lineComment: '#', blockComment: null, quotes: ['"', "'"], template: null };
    case 'sql':
      return { lineComment: '--', blockComment: ['/*', '*/'], quotes: ["'", '"'], template: null };
    case 'html':
    case 'xml':
      // 标记语言不做括号配对（属性里的括号是文本）
      return { lineComment: null, blockComment: ['<!--', '-->'], quotes: ['"', "'"], template: null };
    default:
      return { lineComment: null, blockComment: null, quotes: [], template: null };
  }
}

/** 这些语言不做括号配对：括号在它们里面通常是字面文本 */
const NO_BRACKET_CHECK = new Set(['markdown', 'plaintext', 'html', 'xml', 'yaml', 'toml', 'ini', 'sql']);

const OPEN = { '(': ')', '[': ']', '{': '}' };

/**
 * 跨行扫描器。
 *
 * 与 brackets.js 的 scanLineBrackets 的区别：块注释、字符串的开闭状态
 * 跨行传递。没有这个，多行块注释里的括号会被当成代码，全部误报。
 *
 * @param {string[]} lines
 * @param {object} traits lexicalTraits() 的结果
 * @param {boolean} checkBrackets 是否做括号配对
 * @returns {Array} 诊断（不含 JSON 部分）
 */
function scanLines(lines, traits, checkBrackets) {
  const out = [];
  const stack = []; // {ch, line, column}

  let inBlock = false;
  let blockClose = '';
  let inString = false;
  let quote = '';
  let stringStart = 0; // 字符串在本行的起始列（0-based），用于画出完整错误区间

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const lineNo = li + 1;
    let i = 0;

    while (i < line.length) {
      const c = line[i];
      const n = line[i + 1];

      // ---- 块注释中 ----
      if (inBlock) {
        if (blockClose && line.startsWith(blockClose, i)) {
          const closeLen = blockClose.length;
          inBlock = false;
          blockClose = '';
          i += closeLen;
          continue;
        }
        i++;
        continue;
      }

      // ---- 字符串中 ----
      if (inString) {
        if (c === '\\') { i += 2; continue; }
        if (c === quote) { inString = false; quote = ''; i++; continue; }
        i++;
        continue;
      }

      // ---- 行注释 ----
      if (traits.lineComment && line.startsWith(traits.lineComment, i)) break;

      // ---- 块注释开启 ----
      if (traits.blockComment && line.startsWith(traits.blockComment[0], i)) {
        inBlock = true;
        blockClose = traits.blockComment[1];
        i += traits.blockComment[0].length;
        continue;
      }

      // ---- 字符串开启 ----
      if (c === '"' || c === "'") {
        // 单引号在含撇号的自然语言里会误判，但代码文件里这是正确行为
        inString = true;
        quote = c;
        stringStart = i;
        i++;
        continue;
      }

      // ---- 括号 ----
      if (checkBrackets) {
        if (OPEN[c]) {
          stack.push({ ch: c, line: lineNo, column: i + 1 });
        } else if (c === ')' || c === ']' || c === '}') {
          const want = { ')': '(', ']': '[', '}': '{' }[c];
          if (stack.length && stack[stack.length - 1].ch === want) {
            stack.pop();
          } else {
            // 多余闭括号或类型错配：能跑，但几乎肯定是写错了 → warning
            out.push({
              severity: SEVERITY.warning,
              line: lineNo,
              column: i + 1,
              length: 1,
              message: `多余的右括号 "${c}"`,
              source: SOURCE.bracket,
            });
          }
        }
      }

      i++;
    }

    // 行结束：单引号/双引号字符串不跨行，未闭合即为词法错误。
    // 区间从起始引号到行尾，这样波浪线能画出整段，而不是一个孤立字符。
    if (inString) {
      out.push({
        severity: SEVERITY.error,
        line: lineNo,
        column: stringStart + 1,
        length: Math.max(1, line.length - stringStart),
        message: `未闭合的字符串（缺少收尾的 ${quote}）`,
        source: SOURCE.lexer,
      });
      inString = false;
      quote = '';
    }

    // 模板字符串跨行是合法的，不报错；此处 traits 未追踪 template，故无分支
  }

  // 文件结束时仍未闭合的块注释
  if (inBlock) {
    const last = lines.length;
    out.push({
      severity: SEVERITY.error,
      line: last,
      column: Math.max(1, (lines[last - 1] || '').length),
      length: 1,
      message: '未闭合的块注释',
      source: SOURCE.lexer,
    });
  }

  // 文件结束时仍未闭合的括号
  for (const item of stack) {
    out.push({
      severity: SEVERITY.error,
      line: item.line,
      column: item.column,
      length: 1,
      message: `未闭合的括号 "${item.ch}"`,
      source: SOURCE.bracket,
    });
  }

  return out;
}

/**
 * 收集一份文本的全部诊断。
 *
 * @param {string} text
 * @param {string} languageId
 * @returns {Array<{severity:'error'|'warning',line:number,column:number,length:number,message:string,source:string}>}
 *   按 line、column 升序
 */
export function collectDiagnostics(text, languageId = 'plaintext') {
  if (!text) return [];

  let result;
  if (VALIDATABLE.has(languageId)) {
    const res = validate(text, languageId);
    result = (res.errors || []).map((e) => ({
      severity: SEVERITY.error,
      line: e.line,
      column: e.column,
      length: e.length || 1,
      message: e.message,
      source: SOURCE.json,
    }));
  } else {
    const traits = lexicalTraits(languageId);
    if (!traits.lineComment && !traits.blockComment && !traits.quotes.length) return [];
    const checkBrackets = !NO_BRACKET_CHECK.has(languageId);
    result = scanLines(text.split(/\r?\n/), traits, checkBrackets);
  }

  result.sort((a, b) => (a.line - b.line) || (a.column - b.column));
  return result;
}

/** 计数：按严重程度分组 */
export function countDiagnostics(list) {
  let errors = 0;
  let warnings = 0;
  for (const d of list) {
    if (d.severity === SEVERITY.error) errors++;
    else warnings++;
  }
  return { errors, warnings, total: list.length };
}

/**
 * 把诊断按行分组，供视图层逐行取用。
 * @param {Array} list collectDiagnostics() 的结果
 * @returns {Map<number, Array>} line → 该行的诊断（已按 column 升序）
 */
export function groupByLine(list) {
  const map = new Map();
  for (const d of list) {
    let arr = map.get(d.line);
    if (!arr) map.set(d.line, (arr = []));
    arr.push(d);
  }
  return map;
}
