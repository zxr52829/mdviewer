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
      return { lineComment: '//', blockComment: ['/*', '*/'], quotes: ['"', "'"], template: '`', regex: true };
    case 'css':
      // CSS 的 // 是无效注释，不能当行注释处理：`background: url(http://a/b)`
      // 会被后面的括号配对逻辑截断，误报未闭合。CSS 只有块注释。
      return { lineComment: null, blockComment: ['/*', '*/'], quotes: ['"', "'"], template: null };
    case 'scss':
    case 'less':
      return { lineComment: '//', blockComment: ['/*', '*/'], quotes: ['"', "'"], template: null };
    case 'go':
      // Go 的反引号是原始字符串字面量，可跨行、内部无转义。
      // 不追踪它的话，里面的括号会被当成代码参与配对。
      return { lineComment: '//', blockComment: ['/*', '*/'], quotes: ['"', "'"], template: '`' };
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
    case 'toml':
    case 'ini':
      return { lineComment: '#', blockComment: null, quotes: ['"', "'"], template: null };
    case 'yaml':
      // YAML 只在值以引号**开头**时才有引号语义（`k: "v"`）。
      // 值中间的撇号是普通文本（`msg: don't`），按字符串扫描会满屏假报错，
      // 所以由 yamlQuoteProbe 判定是否开启引号扫描。
      return { lineComment: '#', blockComment: null, quotes: ['"', "'"], template: null, yamlQuoteProbe: true };
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

/** 这些字符后面的引号算「值的开头」（YAML 专用判定） */
const YAML_VALUE_OPENERS = new Set([':', '-', '[', '{', ',', '?']);

/**
 * YAML 行内判定：当前位置的引号是否开启一个字符串值。
 *
 * 只在这几种位置算开启：行首、`key:` 之后、列表项 `- ` 之后、
 * 花括号/方括号/逗号之后。`msg: don't stop` 里的撇号不在这些位置，
 * 就被当作普通文本，不会误报未闭合。
 *
 * @param {string} line 当前行
 * @param {number} quoteCol 引号所在列（0-based）
 * @returns {boolean}
 */
function yamlQuoteOpens(line, quoteCol) {
  let k = quoteCol - 1;
  while (k >= 0 && (line[k] === ' ' || line[k] === '\t')) k--;
  if (k < 0) return true; // 行首（或全空白）
  return YAML_VALUE_OPENERS.has(line[k]);
}

/**
 * 判断某个 `/` 是正则字面量的开头，还是除号。
 *
 * 判据是「前一个有效字符」：正则只能出现在「表达式期望一个值」的位置，
 * 也就是行首、运算符/分隔符之后、开括号之后、关键字之后。
 * 若前一个字符是标识符、数字、右括号、右方括号或字符串结束，
 * 那么这个 `/` 只能是除号。
 *
 * 这套判据与各 JS 词法器（acorn、esprima）采用的同类启发式一致，
 * 覆盖真实代码的绝大部分情形；极端写法（如 `a = b\n/re/.test(c)`）
 * 会退化为除法理解，代价是偶发漏报而不是误报 —— 对诊断功能来说
 * 漏报远好过在正确代码上画红线。
 *
 * @param {string} line 当前行
 * @param {number} slashCol `/` 所在列（0-based）
 * @returns {boolean}
 */
function regexAllowed(line, slashCol) {
  let k = slashCol - 1;
  while (k >= 0 && (line[k] === ' ' || line[k] === '\t')) k--;
  if (k < 0) return true; // 行首

  const prev = line[k];
  // 这些字符之后必然是新表达式的开始 → 正则在期待值的位置
  if ('(,=:[!&|?{};+-*%<>~^'.includes(prev)) return true;
  // 右括号 / 右方括号 / 标识符 / 数字 / 引号结束之后 → 除号
  if (prev === ')' || prev === ']' || prev === '"' || prev === "'" || prev === '`') return false;
  if (/[A-Za-z0-9_$]/.test(prev)) {
    // 关键字之后仍可以是正则（`return /x/`、`typeof /x/`）
    let s = k;
    while (s >= 0 && /[A-Za-z0-9_$]/.test(line[s])) s--;
    const word = line.slice(s + 1, k + 1);
    return REGEX_PRECEDING_KEYWORDS.has(word);
  }
  return true;
}

/** 这些关键字之后 `/` 是正则而不是除号 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete',
  'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
]);

/**
 * 从起始 `/` 扫描一个单行正则字面量，返回结束位置（`/` 与 flags 之后）。
 *
 * 字符类 `[...]` 内的 `/` 不是结束符，必须据此跳过。
 * 找不到闭合（单行内不闭合）时返回 -1，交给调用方按除号继续处理 ——
 * 宁可漏报，也不要把一段普通除法硬吃成正则而掩盖真实错误。
 *
 * @param {string} line
 * @param {number} startCol 起始 `/` 的列
 * @returns {number} 结束列（不含），或 -1
 */
function scanRegexLiteral(line, startCol) {
  let i = startCol + 1;
  let inClass = false;
  if (line[i] === '/' || line[i] === '*') return -1; // 空正则或注释，交给上层
  while (i < line.length) {
    const c = line[i];
    if (c === '\\') { i += 2; continue; }
    if (inClass) {
      if (c === ']') inClass = false;
      i++;
      continue;
    }
    if (c === '[') { inClass = true; i++; continue; }
    if (c === '/') {
      i++;
      while (i < line.length && /[a-z]/i.test(line[i])) i++; // flags
      return i;
    }
    i++;
  }
  return -1;
}

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
  // 模板字符串状态栈：每层保存该层插值内的括号计数。
  // 用栈而不是全局计数，是因为嵌套模板各自有插值：
  //   f(`a${ g(`i${ j }`) }b`)
  // 内层模板退出后必须恢复外层插值的计数，共用一个计数器会算错。
  const templateStack = [];
  let inTemplate = false;     // 处于模板文本中
  let inTemplateExpr = false; // 处于 ${} 插值表达式中

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const lineNo = li + 1;
    let i = 0;

    while (i < line.length) {
      const c = line[i];

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

      // ---- 模板字符串文本中 ----
      // 这里只处理「模板文本」一侧：转义、结束反引号、以及进入 `${}` 插值。
      // 嵌套模板（`a${ x.map(t => `${t}`) }b`）必须能正确配对，
      // 所以插值内部走正常表达式逻辑，遇到 `}` 再退回模板文本。
      if (inTemplate) {
        if (c === '\\') { i += 2; continue; }
        if (c === traits.template) {
          // 结束一层模板：弹栈。外层若仍有模板，就接着走它的插值/文本
          templateStack.pop();
          if (templateStack.length > 0) {
            inTemplate = false;
            inTemplateExpr = true;
          } else {
            inTemplate = false;
            inTemplateExpr = false;
          }
          i++;
          continue;
        }
        if (c === '$' && line[i + 1] === '{') {
          // 进入插值：本层的括号计数从 0 开始
          templateStack[templateStack.length - 1].braces = 0;
          inTemplate = false;
          inTemplateExpr = true;
          i += 2;
          continue;
        }
        i++;
        continue;
      }

      // ---- 插值表达式内部 ----
      // 插值里是普通表达式：括号要照常配对，字符串/正则要照常识别，
      // 只有「与 `${` 配对的那个 `}`」才表示回到模板文本。
      // braces 记录本层插值内未闭合的括号数，归零时的 `}` 才是插值收尾。
      if (inTemplateExpr) {
        const frame = templateStack[templateStack.length - 1];
        if (c === '"' || c === "'") {
          inString = true;
          quote = c;
          stringStart = i;
          i++;
          continue;
        }
        if (c === traits.template) {
          // 插值内出现反引号 → 嵌套模板。新开一帧，退出后回到本帧插值
          templateStack.push({ braces: 0, chars: [], openLine: lineNo, openColumn: i + 1 });
          inTemplate = true;
          inTemplateExpr = false;
          i++;
          continue;
        }
        if (c === '{' || c === '(' || c === '[') {
          frame.braces++;
          frame.chars.push({ ch: c, line: lineNo, column: i + 1 });
          i++;
          continue;
        }
        if (c === '}' || c === ')' || c === ']') {
          if (c === '}' && frame.braces === 0) {
            // 插值结束，回到本层模板文本
            inTemplate = true;
            inTemplateExpr = false;
            i++;
            continue;
          }
          frame.braces--;
          frame.chars.pop();
          i++;
          continue;
        }
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

      // ---- 模板字符串开启 ----
      if (traits.template && c === traits.template) {
        templateStack.push({ braces: 0, chars: [], openLine: lineNo, openColumn: i + 1 });
        inTemplate = true;
        inTemplateExpr = false;
        i++;
        continue;
      }

      // ---- 正则字面量（JS 家族）----
      // 必须排在括号判定之前：`/[&<>"]/g` 里的 `[` 和 `"` 若被当成语法符号，
      // 会同时误报「未闭合括号」和「未闭合字符串」。这是本仓库实测最常见的
      // 误报来源（官方源码里 27 个 .js 有 6 个被误报，全部源于正则）。
      if (traits.regex && c === '/' && regexAllowed(line, i)) {
        const end = scanRegexLiteral(line, i);
        if (end > 0) { i = end; continue; }
      }

      // ---- 字符串开启 ----
      if (c === '"' || c === "'") {
        // YAML 的撇号多半是文本里的 apostrophe，只有值的开头才算引号串
        if (traits.yamlQuoteProbe && !yamlQuoteOpens(line, i)) { i++; continue; }
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

    // 模板字符串跨行合法，本行结束不判未闭合。
  }

  // 文件结束时仍未闭合的块注释。
  // 位置落在最后一行的行尾之后（length:0 的零宽区间），不盖住已有字符：
  // 实机验证时旧实现从行尾前一列起画，最后两个字符被划进波浪线，
  // 而那两个字符本身完全正常。
  if (inBlock) {
    const last = lines.length;
    out.push({
      severity: SEVERITY.error,
      line: last,
      column: (lines[last - 1] || '').length + 1,
      length: 1,
      message: '未闭合的块注释',
      source: SOURCE.lexer,
    });
  }

  // 文件结束时仍未闭合的括号。
  // 一次最多报 3 个：粘贴一段尾部截断的代码会攒出成百上千个未闭合括号，
  // 全部吐出来会让状态栏计数爆炸、装订线满屏红点，信息量为零。
  const MAX_UNCLOSED = 3;
  for (const item of stack.slice(0, MAX_UNCLOSED)) {
    out.push({
      severity: SEVERITY.error,
      line: item.line,
      column: item.column,
      length: 1,
      message: `未闭合的括号 "${item.ch}"`,
      source: SOURCE.bracket,
    });
  }
  if (stack.length > MAX_UNCLOSED) {
    out.push({
      severity: SEVERITY.error,
      line: lines.length,
      column: 1,
      length: 1,
      message: `还有 ${stack.length - MAX_UNCLOSED} 个未闭合的括号未标出`,
      source: SOURCE.bracket,
    });
  }

  // 文件结束时仍未闭合的模板字符串 / 插值内残留括号。
  //
  // 只报最内层未闭合的那一帧：嵌套模板里所有外层都会被顺带判成未闭合，
  // 但那只是内层没关的连带结果，全报出来是同一条错误的多个副本。
  // 若该帧里还留着未闭合的括号，优先报括号 —— 那才是真正的错误位置。
  if (templateStack.length) {
    const frame = templateStack[templateStack.length - 1];
    if (frame.chars.length) {
      for (const item of frame.chars.slice(0, MAX_UNCLOSED)) {
        out.push({
          severity: SEVERITY.error,
          line: item.line,
          column: item.column,
          length: 1,
          message: `模板插值内未闭合的括号 "${item.ch}"`,
          source: SOURCE.bracket,
        });
      }
    } else if (frame.openLine) {
      out.push({
        severity: SEVERITY.error,
        line: frame.openLine,
        column: frame.openColumn,
        length: 1,
        message: `未闭合的模板字符串（缺少收尾的 ${traits.template}）`,
        source: SOURCE.lexer,
      });
    }
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
