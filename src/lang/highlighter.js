/**
 * 高亮器：按语言把一行切成带类型的 token。
 *
 * Trae 用两套机制：
 *   - 原生层：vscode-textmate + oniguruma.wasm 跑 tmLanguage 语法
 *   - webview 层：Monarch / highlight.js 之类做轻量 tokenize
 *
 * 这里取第三种：手写小状态机。理由不是"更简单"，而是 tmLanguage 的本质
 * 就是状态机 —— begin/end 配对、captures 分层。用一张平铺的正则表做
 * 同样的工作会踩两类坑，本项目都实际踩过：
 *   1. 宽匹配抢占窄匹配（`[^"\]+` 把整段吞成字符串）
 *   2. 前后文依赖无法表达（引号要区分"键名的引号"与"值的引号"）
 * 状态机天然解决这两点。
 *
 * 输出的 token type 命名对齐 tmLanguage scope，保证着色语义与原版一致：
 *   support.type.property-name.json → key
 *   string.quoted.double.json       → string
 *   punctuation.definition.string   → punct
 *   constant.character.escape.json  → escape
 *   markup.bold.markdown            → bold
 *   punctuation.definition.bold     → markup-sign
 *   ……
 *
 * 关键设计：区分「标记符」与「内容」。`**bold**` 里的 `**` 是标点、
 * `bold` 是内容，两者不同色 —— 这是原版看起来层次分明的真正原因。
 */

/** token 类型 → CSS class 后缀（tk-<type>） */
const T = {
  KEYWORD: 'keyword',
  STRING: 'string',
  NUMBER: 'number',
  COMMENT: 'comment',
  PROPERTY: 'property',
  TAG: 'tag',
  ATTR: 'attr',
  HEADING: 'heading',
  BOLD: 'bold',
  ITALIC: 'italic',
  CODE: 'code',
  LINK: 'link',
  PUNCT: 'punct',
  BOOL: 'bool',
  KEY: 'key',
  MARKUP_SIGN: 'markup-sign',
  LINK_TEXT: 'link-text',
  LINK_URL: 'link-url',
  CODE_LANG: 'code-lang',
  ESCAPE: 'escape',
  OPERATOR: 'operator',
};

/* ================= JSON ================= */

/** JSON 行扫描：字符级状态机，逐字符推进 */
function tokenizeJson(line) {
  const out = [];
  let i = 0;
  const n = line.length;

  const push = (start, end, type) => {
    if (end > start) out.push({ start, end, type });
  };

  while (i < n) {
    const c = line[i];

    // 空白跳过（不着色）
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }

    // 行注释
    if (c === '/' && line[i + 1] === '/') {
      push(i, n, T.COMMENT);
      break;
    }

    // 块注释（单行内）
    if (c === '/' && line[i + 1] === '*') {
      const end = line.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      push(i, stop, T.COMMENT);
      i = stop;
      continue;
    }

    // 字符串：判断是键名还是值
    if (c === '"') {
      const start = i;
      i++;
      // 扫描到未转义的闭合引号
      while (i < n) {
        if (line[i] === '\\') {
          i += 2;
          continue;
        }
        if (line[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      const end = i;

      // 向后看第一个非空白字符：是冒号则为键名
      let k = end;
      while (k < n && (line[k] === ' ' || line[k] === '\t')) k++;
      const isKey = line[k] === ':';

      // 引号单独作标点，内容按键名/值着色，转义再细分
      push(start, start + 1, T.PUNCT);
      tokenizeStringBody(line, start + 1, end - 1, isKey ? T.KEY : T.STRING, out);
      push(end - 1, end, T.PUNCT);
      continue;
    }

    // 数字
    if (c === '-' || (c >= '0' && c <= '9')) {
      const start = i;
      if (line[i] === '-') i++;
      while (i < n && line[i] >= '0' && line[i] <= '9') i++;
      if (line[i] === '.') {
        i++;
        while (i < n && line[i] >= '0' && line[i] <= '9') i++;
      }
      if (line[i] === 'e' || line[i] === 'E') {
        i++;
        if (line[i] === '+' || line[i] === '-') i++;
        while (i < n && line[i] >= '0' && line[i] <= '9') i++;
      }
      push(start, i, T.NUMBER);
      continue;
    }

    // true / false / null
    if (line.startsWith('true', i) || line.startsWith('null', i)) {
      const len = line.startsWith('true', i) ? 4 : 4;
      push(i, i + len, T.BOOL);
      i += len;
      continue;
    }
    if (line.startsWith('false', i)) {
      push(i, i + 5, T.BOOL);
      i += 5;
      continue;
    }

    // 结构标点
    if (c === '{' || c === '}' || c === '[' || c === ']') {
      push(i, i + 1, T.PUNCT);
      i++;
      continue;
    }
    if (c === ',' || c === ':') {
      push(i, i + 1, T.OPERATOR);
      i++;
      continue;
    }

    i++;
  }

  return out;
}

/** 字符串内部：把转义序列单独切出来，其余按 baseType 着色 */
function tokenizeStringBody(line, from, to, baseType, out) {
  let i = from;
  let plainStart = from;

  const flush = (end) => {
    if (end > plainStart) out.push({ start: plainStart, end, type: baseType });
  };

  while (i < to) {
    if (line[i] === '\\') {
      flush(i);
      const escEnd = Math.min(to, i + 2);
      out.push({ start: i, end: escEnd, type: T.ESCAPE });
      i = escEnd;
      plainStart = i;
      continue;
    }
    i++;
  }
  flush(to);
}

/* ================= Markdown ================= */

/** Markdown 行扫描：处理行首结构 + 行内标记 */
function tokenizeMarkdown(line) {
  const out = [];
  const n = line.length;
  const push = (start, end, type) => {
    if (end > start) out.push({ start, end, type });
  };

  let i = 0;

  // ---- 行首结构 ----
  const indent = /^ {0,3}/.exec(line)[0].length;

  // 标题
  const heading = /^(#{1,6})(?=[ \t])/.exec(line.slice(indent));
  if (heading) {
    push(indent, indent + heading[1].length, T.MARKUP_SIGN);
    push(indent + heading[1].length, n, T.HEADING);
    return out;
  }

  // 围栏代码块
  const fence = /^(```|~~~)([\w+#-]*)/.exec(line.slice(indent));
  if (fence) {
    push(indent, indent + 3, T.MARKUP_SIGN);
    if (fence[2]) push(indent + 3, indent + 3 + fence[2].length, T.CODE_LANG);
    const restStart = indent + 3 + fence[2].length;
    if (restStart < n) push(restStart, n, T.CODE);
    return out;
  }

  // 分隔线
  if (/^(?:-{3,}|\*{3,}|_{3,})[ \t]*$/.test(line.slice(indent))) {
    push(indent, n, T.MARKUP_SIGN);
    return out;
  }

  // 引用
  if (line[indent] === '>') {
    push(indent, indent + 1, T.MARKUP_SIGN);
    push(indent + 1, n, T.COMMENT);
    return out;
  }

  // 列表标记
  const list = /^(?:[-*+]|\d+\.)(?=[ \t])/.exec(line.slice(indent));
  if (list) {
    push(indent, indent + list[0].length, T.MARKUP_SIGN);
    i = indent + list[0].length;
  } else {
    i = 0;
  }

  // ---- 行内标记 ----
  while (i < n) {
    const c = line[i];

    // 行内代码：反引号 / 内容 / 反引号
    if (c === '`') {
      const close = line.indexOf('`', i + 1);
      if (close > i) {
        push(i, i + 1, T.MARKUP_SIGN);
        push(i + 1, close, T.CODE);
        push(close, close + 1, T.MARKUP_SIGN);
        i = close + 1;
        continue;
      }
      push(i, i + 1, T.MARKUP_SIGN);
      i++;
      continue;
    }

    // 粗体 **...** 或 __...__
    if ((c === '*' || c === '_') && line[i + 1] === c) {
      const marker = c + c;
      const close = line.indexOf(marker, i + 2);
      if (close > i + 1) {
        push(i, i + 2, T.MARKUP_SIGN);
        push(i + 2, close, T.BOLD);
        push(close, close + 2, T.MARKUP_SIGN);
        i = close + 2;
        continue;
      }
    }

    // 斜体 *...* 或 _..._
    if (c === '*' || c === '_') {
      const close = line.indexOf(c, i + 1);
      if (close > i) {
        push(i, i + 1, T.MARKUP_SIGN);
        push(i + 1, close, T.ITALIC);
        push(close, close + 1, T.MARKUP_SIGN);
        i = close + 1;
        continue;
      }
      push(i, i + 1, T.MARKUP_SIGN);
      i++;
      continue;
    }

    // 删除线
    if (c === '~' && line[i + 1] === '~') {
      const close = line.indexOf('~~', i + 2);
      if (close > i + 1) {
        push(i, i + 2, T.MARKUP_SIGN);
        push(i + 2, close, T.ITALIC);
        push(close, close + 2, T.MARKUP_SIGN);
        i = close + 2;
        continue;
      }
    }

    // 链接 / 图片：[文字](地址)
    const isImage = c === '!' && line[i + 1] === '[';
    const isLink = c === '[';
    if (isImage || isLink) {
      const bracketStart = isImage ? i + 1 : i;
      const closeBracket = line.indexOf(']', bracketStart + 1);
      if (closeBracket > bracketStart && line[closeBracket + 1] === '(') {
        const closeParen = line.indexOf(')', closeBracket + 2);
        if (closeParen > closeBracket) {
          if (isImage) push(i, i + 1, T.MARKUP_SIGN);
          push(bracketStart, bracketStart + 1, T.MARKUP_SIGN);
          push(bracketStart + 1, closeBracket, T.LINK_TEXT);
          push(closeBracket, closeBracket + 1, T.MARKUP_SIGN);
          push(closeBracket + 1, closeBracket + 2, T.MARKUP_SIGN);
          push(closeBracket + 2, closeParen, T.LINK_URL);
          push(closeParen, closeParen + 1, T.MARKUP_SIGN);
          i = closeParen + 1;
          continue;
        }
      }
    }

    // 内联 HTML
    if (c === '<') {
      const close = line.indexOf('>', i + 1);
      if (close > i) {
        push(i, close + 1, T.TAG);
        i = close + 1;
        continue;
      }
    }

    i++;
  }

  return out;
}

/* ================= 其余语言的通用扫描 ================= */

/** 通用正则扫描（js/python/css 等，无需区分标记符） */
function makeRegexScanner(rules) {
  return (line) => {
    const out = [];
    let pos = 0;
    const len = line.length;

    while (pos < len) {
      let matched = false;
      for (const rule of rules) {
        rule.re.lastIndex = pos;
        const m = rule.re.exec(line);
        if (m && m.index === pos && m[0].length > 0) {
          if (rule.type) out.push({ start: pos, end: pos + m[0].length, type: rule.type });
          pos += m[0].length;
          matched = true;
          break;
        }
      }
      if (!matched) pos++;
    }
    return out;
  };
}

const jsRules = [
  { re: /\/\/[^\n]*/y, type: T.COMMENT },
  { re: /\/\*[\s\S]*?\*\//y, type: T.COMMENT },
  { re: /`(?:[^`\\]|\\.)*`/y, type: T.STRING },
  { re: /"(?:[^"\\]|\\.)*"/y, type: T.STRING },
  { re: /'(?:[^'\\]|\\.)*'/y, type: T.STRING },
  {
    re: /\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|this|import|export|from|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|delete|void|yield|static|get|set)\b/y,
    type: T.KEYWORD,
  },
  { re: /\b(?:true|false|null|undefined|NaN|Infinity)\b/y, type: T.BOOL },
  { re: /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y, type: T.NUMBER },
];

const cssRules = [
  { re: /\/\*[\s\S]*?\*\//y, type: T.COMMENT },
  { re: /"(?:[^"\\]|\\.)*"/y, type: T.STRING },
  { re: /'(?:[^'\\]|\\.)*'/y, type: T.STRING },
  { re: /#[0-9a-fA-F]{3,8}\b/y, type: T.NUMBER },
  { re: /\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg|fr)\b/y, type: T.NUMBER },
  { re: /--[A-Za-z0-9_-]+/y, type: T.PROPERTY },
  { re: /[A-Za-z-]+(?=\s*:)/y, type: T.KEY },
];

const shellRules = [
  { re: /#[^\n]*/y, type: T.COMMENT },
  { re: /"(?:[^"\\]|\\.)*"/y, type: T.STRING },
  { re: /'[^']*'/y, type: T.STRING },
  {
    re: /\b(?:if|then|else|elif|fi|for|in|do|done|while|case|esac|function|return|export|local|echo|exit|source|set)\b/y,
    type: T.KEYWORD,
  },
  { re: /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/y, type: T.PROPERTY },
];

const yamlRules = [
  { re: /#[^\n]*/y, type: T.COMMENT },
  { re: /^[ \t-]*[A-Za-z0-9_.-]+(?=\s*:)/y, type: T.KEY },
  { re: /"(?:[^"\\]|\\.)*"/y, type: T.STRING },
  { re: /'[^']*'/y, type: T.STRING },
  { re: /\b(?:true|false|null|yes|no|on|off)\b/y, type: T.BOOL },
  { re: /-?\b\d+(?:\.\d+)?\b/y, type: T.NUMBER },
];

const pythonRules = [
  { re: /#[^\n]*/y, type: T.COMMENT },
  { re: /"""[\s\S]*?"""/y, type: T.STRING },
  { re: /'''[\s\S]*?'''/y, type: T.STRING },
  { re: /"(?:[^"\\]|\\.)*"/y, type: T.STRING },
  { re: /'(?:[^'\\]|\\.)*'/y, type: T.STRING },
  {
    re: /\b(?:def|class|return|if|elif|else|for|while|import|from|as|with|try|except|finally|raise|pass|break|continue|lambda|yield|global|nonlocal|assert|del|is|not|and|or|async|await)\b/y,
    type: T.KEYWORD,
  },
  { re: /\b(?:True|False|None)\b/y, type: T.BOOL },
  { re: /\b\d+(?:\.\d+)?\b/y, type: T.NUMBER },
];

const htmlRules = [
  { re: /<!--[\s\S]*?-->/y, type: T.COMMENT },
  { re: /<\/?[a-zA-Z][a-zA-Z0-9-]*/y, type: T.TAG },
  { re: /[a-zA-Z-]+(?==)/y, type: T.ATTR },
  { re: /"(?:[^"\\]|\\.)*"/y, type: T.STRING },
  { re: /'(?:[^'\\]|\\.)*'/y, type: T.STRING },
];

/* ================= 分发 ================= */

const SCANNERS = {
  markdown: tokenizeMarkdown,
  json: tokenizeJson,
  jsonc: tokenizeJson,
  json5: tokenizeJson,
  jsonl: tokenizeJson,
  javascript: makeRegexScanner(jsRules),
  typescript: makeRegexScanner(jsRules),
  css: makeRegexScanner(cssRules),
  scss: makeRegexScanner(cssRules),
  less: makeRegexScanner(cssRules),
  shell: makeRegexScanner(shellRules),
  powershell: makeRegexScanner(shellRules),
  yaml: makeRegexScanner(yamlRules),
  toml: makeRegexScanner(yamlRules),
  ini: makeRegexScanner(yamlRules),
  python: makeRegexScanner(pythonRules),
  html: makeRegexScanner(htmlRules),
  xml: makeRegexScanner(htmlRules),
};

const scannerCache = new Map();

function scannerFor(languageId) {
  if (scannerCache.has(languageId)) return scannerCache.get(languageId);
  const fn = SCANNERS[languageId] || (() => []);
  scannerCache.set(languageId, fn);
  return fn;
}

/**
 * 高亮一行。
 * @param {string} line
 * @param {string} languageId
 * @returns {Array<{start:number,end:number,type:string}>}
 */
export function tokenizeLine(line, languageId) {
  if (!line) return [];
  return scannerFor(languageId)(line);
}

/* ================= HTML 渲染 ================= */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
function esc(s) {
  return s.replace(/[&<>"]/g, (c) => ESC[c]);
}

/**
 * 把 token、查找命中、括号深度三层标记合成 HTML。
 *
 * 三层各自独立：
 *   - token：语法着色，span.tk-*
 *   - match：查找命中底色，字符级
 *   - bracket：括号按嵌套深度着色，字符级，最多 3 层
 *
 * 做法：取所有边界点的并集切段，逐段判断自己属于哪个 token、是否命中、
 * 是不是括号，再拼出正确嵌套。三层边界不对齐时如果逐层包 span，
 * 会把彼此的着色切断或互相覆盖。
 *
 * @param {string} line
 * @param {string} languageId
 * @param {Uint8Array|null} mask 逐字符命中标记，1 = 命中
 * @param {Map<number,{depth:number,ch:string}>|null} bracketMap col(1-based) → 括号信息
 * @param {{matchCol:number,partnerCol:number}|null} bracketHighlight 当前高亮的括号对
 */
export function renderLineHtml(line, languageId, mask, bracketMap, bracketHighlight) {
  if (!line) return '';

  const hasBrackets = !!bracketMap && bracketMap.size > 0;
  const hasHighlight = !!bracketHighlight;

  // 三层都无标记时走快路径
  if (!mask && !hasBrackets && !hasHighlight) {
    const tokens0 = tokenizeLine(line, languageId);
    if (!tokens0.length) return esc(line);
    let html0 = '';
    let cur = 0;
    for (const tk of tokens0) {
      if (tk.start > cur) html0 += esc(line.substring(cur, tk.start));
      html0 += `<span class="tk-${tk.type}">${esc(line.substring(tk.start, tk.end))}</span>`;
      cur = tk.end;
    }
    if (cur < line.length) html0 += esc(line.substring(cur));
    return html0;
  }

  const tokens = tokenizeLine(line, languageId);

  const points = new Set([0, line.length]);
  for (const tk of tokens) {
    points.add(tk.start);
    points.add(tk.end);
  }
  if (mask) {
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] && (i === 0 || !mask[i - 1])) points.add(i);
      if (!mask[i] && i > 0 && mask[i - 1]) points.add(i);
    }
  }
  if (hasBrackets) {
    for (const col of bracketMap.keys()) {
      points.add(col - 1);
      points.add(col);
    }
  }

  const sorted = Array.from(points).filter((p) => p >= 0 && p <= line.length).sort((a, b) => a - b);

  let html = '';
  for (let i = 0; i < sorted.length - 1; i++) {
    const from = sorted[i];
    const to = sorted[i + 1];
    if (to <= from) continue;

    let tokenType = null;
    for (const tk of tokens) {
      if (from >= tk.start && from < tk.end) {
        tokenType = tk.type;
        break;
      }
    }

    let inner = esc(line.substring(from, to));

    // 括号深度着色：只在单字符段上生效（括号必然独占一段）
    if (hasBrackets && to - from === 1) {
      const info = bracketMap.get(from + 1);
      if (info) {
        const depthClass = Math.min(info.depth, 2);
        inner = `<span class="br br-${depthClass}">${inner}</span>`;
      }
    }

    if (tokenType) inner = `<span class="tk-${tokenType}">${inner}</span>`;
    if (mask && mask[from] === 1) inner = `<span class="hl-match">${inner}</span>`;

    // 配对高亮压最外层，用描边不用底色，避免与命中色冲突
    if (hasHighlight && to - from === 1 &&
        (from + 1 === bracketHighlight.matchCol || from + 1 === bracketHighlight.partnerCol)) {
      inner = `<span class="br-match">${inner}</span>`;
    }

    html += inner;
  }

  return html;
}
