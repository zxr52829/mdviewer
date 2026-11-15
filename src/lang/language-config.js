/**
 * 语言配置：把编辑器行为从代码里搬到数据里。
 *
 * Trae / VS Code 的做法是每个语言扩展提供一份 language-configuration.json，
 * 其中声明注释符、括号对、自动闭合对、缩进规则、词边界正则等；编辑器
 * 只读这份配置，不为任何语言写特例。
 *
 * 这个文件是那套机制的最小复刻：配置为数据，逻辑与语言无关。
 * 关键点：词边界用**语言级 wordPattern**，不是全局 \w。
 * Markdown 的官方配置用 Unicode 属性类 \p{Alphabetic}，中文属于词字符；
 * 而 JSON 用默认字符集，中文不是。用一刀切的 \w 两种都会错。
 */

/**
 * 默认词分隔符。取自 VS Code 的 editor.wordSeparators 默认值，
 * 与 Trae 里 `var $H="..."` 完全一致。
 */
export const DEFAULT_WORD_SEPARATORS = "`~!@#$%^&*()-=+[{]}\\|;:'\",.<>/?";

/**
 * 默认词边界正则：连续的非分隔符字符（Unicode 感知）。
 *
 * 注意分隔符字符串不能直接塞进字符类：`* ( ) - [ ] { } \ | ^` 在
 * 字符类里都是特殊角色，漏转义会直接抛 Invalid regular expression。
 * 全部转义后按字符类语义使用。
 */
function escapeForCharClass(s) {
  return s.replace(/[\\\]\[^\-]/g, '\\$&').replace(/[*+?(){}|$.]/g, '\\$&');
}

const DEFAULT_WORD_PATTERN = {
  pattern: '[^' + escapeForCharClass(DEFAULT_WORD_SEPARATORS) + ']+',
  flags: 'u',
};

const CONFIGS = {
  markdown: {
    comments: { blockComment: ['<!--', '-->'] },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '<', close: '>', notIn: ['string'] },
      { open: '`', close: '`' },
      { open: '*', close: '*' },
      { open: '_', close: '_' },
      { open: '~', close: '~' },
    ],
    surroundingPairs: [
      ['(', ')'],
      ['[', ']'],
      ['`', '`'],
      ['_', '_'],
      ['*', '*'],
      ['{', '}'],
      ["'", "'"],
      ['"', '"'],
      ['<', '>'],
      ['~', '~'],
      ['$', '$'],
    ],
    // 官方 markdown-basics/language-configuration.json 原文
    wordPattern: {
      pattern:
        '(\\p{Alphabetic}|\\p{Number}|\\p{Nonspacing_Mark})(((\\p{Alphabetic}|\\p{Number}|\\p{Nonspacing_Mark})|[_])?(\\p{Alphabetic}|\\p{Number}|\\p{Nonspacing_Mark}))*',
      flags: 'ug',
    },
    indentation: null,
  },

  json: {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [
      ['{', '}'],
      ['[', ']'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}', notIn: ['string'] },
      { open: '[', close: ']', notIn: ['string'] },
      { open: '(', close: ')', notIn: ['string'] },
      { open: "'", close: "'", notIn: ['string'] },
      { open: '"', close: '"', notIn: ['string', 'comment'] },
      { open: '`', close: '`', notIn: ['string', 'comment'] },
    ],
    surroundingPairs: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
      ['"', '"'],
      ["'", "'"],
      ['`', '`'],
    ],
    wordPattern: DEFAULT_WORD_PATTERN,
    // 官方 json/language-configuration.json 的缩进规则
    indentation: {
      increaseIndentPattern:
        '({+(?=((\\\\.|[^"\\\\])*"(\\\\.|[^"\\\\])*")*[^"}]*)$)|(\\[+(?=((\\\\.|[^"\\\\])*"(\\\\.|[^"\\\\])*")*[^"\\]]*)$)',
      decreaseIndentPattern: '^\\s*[}\\],]\\s*$',
    },
    onEnterRules: [
      {
        beforeTextPattern: '//.*',
        afterTextPattern: '^(?!\\s*$).+',
        action: 'comment-continue',
        appendText: '// ',
      },
    ],
  },
};

// JSON 的 jsonc / json5 / jsonl 与 json 共享行为
CONFIGS.jsonc = CONFIGS.json;
CONFIGS.json5 = CONFIGS.json;
CONFIGS.jsonl = CONFIGS.json;

/** 取某语言的配置；未注册的语言用默认值 */
export function getLanguageConfiguration(languageId) {
  return CONFIGS[languageId] || {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
    surroundingPairs: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
      ['"', '"'],
      ["'", "'"],
    ],
    wordPattern: DEFAULT_WORD_PATTERN,
    indentation: null,
    onEnterRules: [],
  };
}

/** 编译并缓存词边界正则（配置是静态的，编译一次即可） */
const wordRegexCache = new Map();

function wordRegex(languageId) {
  if (wordRegexCache.has(languageId)) return wordRegexCache.get(languageId);
  const cfg = getLanguageConfiguration(languageId);
  const wp = cfg.wordPattern || DEFAULT_WORD_PATTERN;
  let re;
  try {
    // 用全局标志另存一份用于扫描，便于反复 exec
    re = new RegExp(wp.pattern, wp.flags.includes('g') ? wp.flags : wp.flags + 'g');
  } catch {
    re = new RegExp(DEFAULT_WORD_PATTERN.pattern, 'gu');
  }
  wordRegexCache.set(languageId, re);
  return re;
}

/**
 * 取某位置所在的「词」范围。
 * 对应 VS Code 的 getWordAtPosition：双击选词、Ctrl+D 选下一个相同词都靠它。
 *
 * @param {string} line 行文本
 * @param {number} column 1-based 列
 * @param {string} languageId
 * @returns {{startColumn:number,endColumn:number,word:string}|null}
 */
export function getWordAtPosition(line, column, languageId) {
  if (!line) return null;
  const re = wordRegex(languageId);
  re.lastIndex = 0;

  const target = Math.max(0, column - 1); // 0-based
  let m;
  while ((m = re.exec(line)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    // 位置落在词内，或紧贴词的右边界也算（双击词尾）
    if (target >= start && target < end) {
      return { startColumn: start + 1, endColumn: end + 1, word: m[0] };
    }
    if (start > target) break;
  }
  return null;
}

/** 判断某位置是否在词内（用于双击判定） */
export function isWordCharAt(line, column, languageId) {
  return getWordAtPosition(line, column, languageId) !== null;
}

/**
 * 按语言配置判断某字符位置的语法状态，用于自动闭合的 notIn。
 * 只区分 string / comment 两类，够覆盖 Trae 里 markdown 与 json 的实际需求。
 *
 * @returns {{inString:boolean, inComment:boolean}}
 */
export function getSyntaxStateAt(line, column, languageId) {
  const cfg = getLanguageConfiguration(languageId);
  const limit = Math.max(0, Math.min(column - 1, line.length));
  let inString = false;
  let quote = '';
  let inBlockComment = false;
  let i = 0;

  const lc = cfg.comments?.lineComment;

  while (i < limit) {
    const c = line[i];
    const n = line[i + 1];

    if (inBlockComment) {
      if (c === '*' && n === '/') {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (inString) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === quote) inString = false;
      i++;
      continue;
    }
    if (lc && c === lc[0] && n === lc[1]) return { inString: false, inComment: true };
    const bc = cfg.comments?.blockComment;
    if (bc && c === bc[0][0] && n === bc[0][1]) {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = true;
      quote = c;
      i++;
      continue;
    }
    i++;
  }

  return { inString, inComment: inBlockComment };
}
