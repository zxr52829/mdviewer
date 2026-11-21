/**
 * 工作区符号索引。
 *
 * 对应 Trae CUE 的「跨文件上下文补全」：候选不只看当前文档，
 * 还看整个工作区里其他文件声明的名字。本项目的原有补全（completion.js）
 * 只统计当前文档的词频，跨文件调用全靠记忆手打 —— 这是最实际的短板。
 *
 * 定位与边界（不夸大）：
 *   - 这是**符号名**级索引，不是语言服务。没有类型推断、没有跳转定义、
 *     没有成员补全（`obj.` 之后列不出方法）。只回答「这个名字在该用
 *     什么作用域里被声明过」。
 *   - 提取靠正则而非语法树。前端零依赖是硬约束，引入 parser 会破坏它。
 *     正则会漏掉解构、动态导入等写法，那些名字就进不了索引 —— 漏，但不错。
 *
 * 为什么不放在 completion.js 里：那个文件是纯候选生成，输入文本输出候选；
 * 索引是**有状态、带失效逻辑**的另一件事，混在一起会让两边都难测。
 */

/** 各级作用域的「声明」特征。顺序有意义：先匹配到的优先级更高。 */
const DECL_PATTERNS = [
  // 函数/方法声明与箭头函数赋值
  { re: /\b(?:function|func|def|fn)\s+([A-Za-z_$][\w$]*)/g, kind: 'function' },
  { re: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g, kind: 'function' },
  // 类/接口/类型/枚举/结构体
  { re: /\b(?:class|interface|struct|trait|enum|type)\s+([A-Za-z_$][\w$]*)/g, kind: 'class' },
  // 变量与常量
  { re: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g, kind: 'variable' },
  // Go 的短变量声明
  { re: /\b([A-Za-z_$][\w$]*)\s*:=\s*/g, kind: 'variable' },
  // 导出（含 export default / export function）
  { re: /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g, kind: 'export' },
];

/**
 * CSS 专用的选择器规则。
 *
 * 必须与上面的通用规则分开：`.` 在代码里是成员访问符，
 * `http.ResponseWriter` 会被 `\.(\w+)\s*{` 之类抓成选择器。
 * 只在 .css/.scss/.less 上启用。
 */
const CSS_SELECTOR_PATTERN = { re: /\.([A-Za-z_][\w-]*)\s*(?:,|\{|:)/g, kind: 'selector' };

/** 同一名字在多处被声明时，保留优先级更高的 kind */
const KIND_RANK = { export: 0, function: 1, class: 1, variable: 2, selector: 3 };

/**
 * 跨文件补全只关心「别人能用到」的名字。
 *
 * 局部变量（`const err = ...`）在自己函数里随处可见，跨文件引用它们
 * 不是笔误就是巧合，放进候选只会把真正有用的导出挤下去。
 * 所以只保留：export 声明、顶层函数/类、以及 CSS 选择器。
 *
 * 判断「顶层」用缩进近似：以行首两个空格以上缩进开头的声明视为局部。
 * 这不是语法分析，对 tab 缩进或一段式写法会误判为顶层 —— 宁可多留，
 * 因为漏掉有用的名字比多列几个更烦人。
 */
function isWorthIndexing(symbol, lineText) {
  if (symbol.kind === 'export' || symbol.kind === 'selector') return true;
  // tab 与空格都算缩进。Go 用 gofmt 强制 tab，只认空格会让整个
  // Go 文件被判成「全部顶层」，实测 ai.go 那 35 个符号就是这么来的。
  const indented = /^[ \t]{2,}|^\t/.test(lineText || '');
  if (symbol.kind === 'function' || symbol.kind === 'class') {
    return !indented;
  }
  // 纯变量：只留顶层的。
  // 不要为「函数内的大写常量」开口子 —— 实测一放开，Go 文件从 13 个
  // 有用符号涨回 35 个，err/cfg/body 这类局部名把真正的导出挤下去。
  // 跨文件补全用的是别人的导出面，不是别人函数里的临时变量。
  return !indented;
}

/**
 * 去掉注释，避免把注释里的示例代码当成真实声明。
 *
 * 实测过：workspace-index.js 自己的注释里写了「局部变量（`const err = ...`）」，
 * 结果 `err` 被抽进索引。正则没有语法上下文，只能先把注释剥掉。
 *
 * 只处理块注释与行注释两种常见形式；不处理字符串里的 `//`（那会把
 * 字符串截断），所以先按行处理、遇到偶数个引号才认行注释。
 *
 * @param {string} text
 * @returns {string} 与原文等长的占位文本（保留换行，行号才不会错）
 */
function stripComments(text) {
  let out = '';
  let inBlock = false;
  let inStr = false;
  let quote = '';
  let inTmpl = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];

    if (inBlock) {
      if (c === '*' && n === '/') { inBlock = false; out += '  '; i++; continue; }
      out += c === '\n' ? '\n' : ' ';
      continue;
    }
    if (inTmpl) {
      out += c;
      if (c === '\\') { out += n ?? ''; i++; continue; }
      if (c === '`') inTmpl = false;
      continue;
    }
    if (inStr) {
      out += c;
      if (c === '\\') { out += n ?? ''; i++; continue; }
      if (c === quote) { inStr = false; quote = ''; }
      continue;
    }
    if (c === '/' && n === '/') {
      // 行注释：吃到行尾，换行符保留
      while (i < text.length && text[i] !== '\n') { out += ' '; i++; }
      if (i < text.length) out += '\n';
      continue;
    }
    if (c === '/' && n === '*') {
      inBlock = true;
      out += '  ';
      i++;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; out += c; continue; }
    if (c === '`') { inTmpl = true; out += c; continue; }
    out += c;
  }
  return out;
}
export function extractSymbols(text, languageId) {
  if (!text) return [];
  // 纯文本与 Markdown 没有可补全的声明概念
  if (languageId === 'plaintext' || languageId === 'markdown') return [];

  // 先剥注释再抽取：注释里的示例代码会被正则当成真实声明。
  // 剥离后长度不变，所以下面算出来的行号仍然准确。
  const src = stripComments(text);

  const patterns = DECL_PATTERNS.slice();
  if (languageId === 'css' || languageId === 'scss' || languageId === 'less') {
    patterns.push(CSS_SELECTOR_PATTERN);
  }

  const seen = new Map(); // name → {name, kind, line}
  for (const { re, kind } of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      const name = m[1];
      if (!name || name.length > 60) continue;
      // 太短的名字（单字符）进索引只会污染候选列表
      if (name.length < 2) continue;

      const before = src.substring(0, m.index);
      const line = before.split('\n').length;
      const lineStart = before.lastIndexOf('\n') + 1;
      let lineEnd = src.indexOf('\n', m.index);
      if (lineEnd < 0) lineEnd = src.length; // 末行没有换行符
      const lineText = src.substring(lineStart, lineEnd);

      const candidate = { name, kind, line };
      if (!isWorthIndexing(candidate, lineText)) continue;

      const prev = seen.get(name);
      if (!prev) {
        seen.set(name, candidate);
      } else if ((KIND_RANK[kind] ?? 9) < (KIND_RANK[prev.kind] ?? 9)) {
        seen.set(name, candidate);
      }
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.line - b.line);
}

/**
 * 一份文件索引项。
 *
 * @typedef {{path:string, name:string, language:string, symbols:Array, mtime?:number}} FileIndex
 */

/**
 * 建立/更新工作区索引。
 *
 * 设计成纯函数（输入文件内容，输出索引），这样能脱离文件系统与 DOM 单测；
 * 真正的 IO 由调用方（app.js 与 api.js）提供。
 *
 * @param {Array<{path:string, text:string, language:string}>} files
 * @param {{maxFiles?:number, maxBytesPerFile?:number}} [opts]
 * @returns {{files: Map<string, FileIndex>, byName: Map<string, Array>, truncated: boolean}}
 */
export function buildIndex(files, opts = {}) {
  const maxFiles = opts.maxFiles ?? 2000;
  const maxBytesPerFile = opts.maxBytesPerFile ?? 512 * 1024;

  const fileMap = new Map();
  const byName = new Map();
  let truncated = false;

  let count = 0;
  for (const f of files) {
    if (count >= maxFiles) { truncated = true; break; }
    if (!f || !f.path) continue;
    // 构建产物与依赖不索引。desktop/web/ 是 go:embed 用的拷贝，
    // 扫进去会让每个符号出现两次，候选里出现两个同名的「同一份代码」，
    // 「+1」这种来源计数也会变成假的。
    if (isIgnoredPath(f.path)) continue;
    // 超大文件跳过：minified 的单行文件抽出来全是噪音，还会拖慢索引
    if (f.text && f.text.length > maxBytesPerFile) { truncated = true; continue; }
    count++;

    const symbols = extractSymbols(f.text || '', f.language || 'plaintext');
    const entry = { path: f.path, name: basename(f.path), language: f.language || 'plaintext', symbols };
    fileMap.set(f.path, entry);

    for (const s of symbols) {
      let arr = byName.get(s.name);
      if (!arr) byName.set(s.name, (arr = []));
      // 同名最多留 5 处，避免候选列表被同一个名字占满
      if (arr.length < 5) {
        arr.push({
          path: f.path, file: entry.name, kind: s.kind, line: s.line,
          language: entry.language,
        });
      }
    }
  }

  return { files: fileMap, byName, truncated };
}

/**
 * 按前缀从索引里取候选。
 *
 * @param {ReturnType<typeof buildIndex>} index
 * @param {string} prefix 光标处的前缀（可为空）
 * @param {{excludePath?:string, limit?:number}} [opts]
 * @returns {Array<{label:string, kind:string, detail:string}>}
 */
export function queryIndex(index, prefix, opts = {}) {
  if (!index || !index.byName) return [];
  const limit = opts.limit ?? 20;
  const lower = (prefix || '').toLowerCase();
  // 按当前编辑的语言过滤来源。
  // 实测：styles.css 一个文件贡献 165 个选择器，占全部符号的四成，
  // 在 .js 里补全时它们只会把真正有用的名字挤出可见区域。
  const wantLang = opts.language || null;
  const out = [];

  for (const [name, sites] of index.byName) {
    // 排除定义在当前文件里的名字：它们已由当前文档的词频补全覆盖
    let usable = sites.filter((s) => s.path !== opts.excludePath);
    if (!usable.length) continue;

    if (wantLang) {
      // CSS 选择器只在编辑 CSS 时有意义。它不是「跨语言引用」，
      // 而是同名噪音：在 .js 里补出 .panel-body 毫无用处。
      if (sites.every((s) => s.kind === 'selector') && wantLang !== 'css'
          && wantLang !== 'scss' && wantLang !== 'less') {
        continue;
      }
      // 同名有多个来源时，优先同语言的那些
      const same = usable.filter((s) => s.language === wantLang);
      if (same.length) usable = same;
    }

    const nl = name.toLowerCase();
    let score;
    if (!lower) score = 5;
    else if (nl === lower) score = 0;          // 完全同名（正在重打同一名字）
    else if (nl.startsWith(lower)) score = 1;  // 前缀命中
    else if (nl.includes(lower)) score = 3;    // 子串命中
    else continue;

    const site = usable[0];
    out.push({
      label: name,
      kind: site.kind,
      detail: `${site.file}${usable.length > 1 ? ` +${usable.length - 1}` : ''}`,
      score,
      // 同分时短名字优先：查 panel 时 panel 应排在 panel-body 之前，
      // 否则越长越具体反而越靠前，用户得往下找。
      len: name.length,
      fromIndex: true,
    });
  }

  out.sort((a, b) => (a.score - b.score) || (a.len - b.len) || a.label.localeCompare(b.label));
  return out.slice(0, limit).map(({ len, ...rest }) => rest);
}

function basename(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.substring(i + 1) : p;
}

/** 这些路径片段下的文件不进入索引：构建产物、依赖、版本库内部 */
const IGNORED_SEGMENTS = new Set([
  'node_modules', 'dist', 'build', 'out', 'target', '.git',
  'web',      // mdviewer 的 go:embed 拷贝目录
  '.sync',    // 镜像同步用的临时目录
  'winres',
]);

/**
 * 判断一个相对路径是否应跳过索引。
 *
 * 按路径段比较而不是子串匹配：`src/web-utils.js` 不该因为名字里带 web 被跳过。
 *
 * @param {string} path 工作区相对路径
 * @returns {boolean}
 */
export function isIgnoredPath(path) {
  if (!path) return false;
  const segs = path.replace(/\\/g, '/').split('/');
  // 最后一段是文件名，只看它前面的目录段
  for (let i = 0; i < segs.length - 1; i++) {
    if (IGNORED_SEGMENTS.has(segs[i])) return true;
  }
  // 测试文件：里面全是 ok()/eq() 这类断言辅助函数，
  // 实测会占满补全候选的前几位，而它们本来就不该被业务代码引用。
  const file = segs[segs.length - 1];
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) return true;
  if (/^run-tests\.m?js$/.test(file)) return true;
  return false;
}
