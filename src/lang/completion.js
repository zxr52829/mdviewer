/**
 * 代码补全：候选生成。
 *
 * 对应 Trae 的 CompletionProvider + triggerCharacters：
 * 语言服务在光标处给出候选列表，编辑器负责展示与插入。
 *
 * 本项目没有语言服务进程，候选来自三类可静态推断的来源：
 *   1. 当前文档里已出现过的标识符（JSON 键名、重复词）—— 最有用
 *   2. 语言关键字与内置常量
 *   3. 语言级片段（如 JSON 的 true/false/null、Markdown 的常用语法）
 *
 * 关键设计：候选必须**基于当前前缀过滤并按相关度排序**，
 * 而不是把所有词一股脑列出来。相关度顺序参考 VS Code：
 *   完全相同 > 前缀匹配 > 驼峰/子串匹配，同级按出现频次降序。
 */

import { getLibrarySymbols } from './symbol-library.js';

/** 从文本中提取所有「标识符样」的片段及其出现次数 */
export function collectIdentifiers(text, languageId) {
  const freq = new Map();

  // JSON 家族：只收键名（引号内且后面跟冒号），这是用户最想补全的东西
  if (languageId === 'json' || languageId === 'jsonc' || languageId === 'json5' || languageId === 'jsonl') {
    const re = /"((?:[^"\\]|\\.)*)"\s*:/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const key = m[1];
      if (key && key.length <= 60) freq.set(key, (freq.get(key) || 0) + 1);
    }
    return freq;
  }

  // 其他语言：收普通标识符（含下划线、点号路径、连字符）
  const re = /[A-Za-z_$][\w$.-]{1,60}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const word = m[0];
    freq.set(word, (freq.get(word) || 0) + 1);
  }
  return freq;
}

/** 语言关键字与常量 */
const KEYWORDS = {
  json: ['true', 'false', 'null'],
  jsonc: ['true', 'false', 'null'],
  json5: ['true', 'false', 'null', 'Infinity', 'NaN'],
  jsonl: ['true', 'false', 'null'],
};

/** Markdown 片段补全：输入 ` 或 # 时的常用结构 */
const MD_SNIPPETS = [
  { label: '```', detail: '代码块' },
  { label: '## ', detail: '二级标题' },
  { label: '### ', detail: '三级标题' },
  { label: '- ', detail: '无序列表' },
  { label: '1. ', detail: '有序列表' },
  { label: '> ', detail: '引用' },
  { label: '**粗体**', detail: '粗体' },
  { label: '*斜体*', detail: '斜体' },
  { label: '`行内代码`', detail: '行内代码' },
  { label: '| 列1 | 列2 |', detail: '表格' },
  { label: '[文字](url)', detail: '链接' },
];

/**
 * 当前光标前正在输入的「词」。
 *
 * 补全必须知道前缀才能过滤候选。前缀允许包含限定符（`.` `::` `->`），
 * 因为用户敲 `std::ve` 时期望看到 `vector`，敲 `os.path.` 时期望看到后续成员。
 *
 * @param {string} line
 * @param {number} column 1-based 光标列
 * @param {string} languageId
 * @returns {{prefix:string, from:number, isMarkdownLead?:boolean}}
 *   from 是前缀起始列（1-based）
 */
export function getCompletionPrefix(line, column, languageId) {
  const before = line.substring(0, Math.max(0, column - 1));

  // Markdown：行首结构（# / - / > 等）允许含空格，单独处理
  if (languageId === 'markdown') {
    const mdLead = /^(\s*(?:[#>*+-]+\s?|```[\w+-]*)?)$/.exec(before);
    if (mdLead && before.length > 0) {
      return { prefix: before, from: 1, isMarkdownLead: true };
    }
  }

  // 通用：吃标识符，允许中间夹限定符（std::vector / os.path.join），
  // 也允许以限定符结尾（os. / a.b.c. → 期望列出后续成员）。
  //
  // 注意交替顺序：必须把「完整链」放在「纯限定符」之前，
  // 否则 os.path. 会被后一个分支截成 "."，候选过滤就完全错了。
  const chain = /(?:[A-Za-z_$][\w$]*\s*(?:\.|::|->)\s*)*[A-Za-z_$][\w$]*\s*(?:\.|::|->)?$/.exec(before);
  const tailQualifier = /(?:\.|::|->)+$/.exec(before);
  const prefix = chain ? chain[0] : (tailQualifier ? tailQualifier[0] : '');

  // 纯限定符后缀（如 "os." 之后）：以前一段为前缀基础，但保留限定符
  return { prefix, from: column - prefix.length, isMarkdownLead: false };
}

/**
 * 生成候选列表。
 *
 * 候选来源按优先级：
 *   1. 文档内已有标识符（用户自己写过的名字，最相关）
 *   2. 语言标准库符号（内置函数、容器、常用方法）
 *   3. 语言关键字
 *   4. Markdown 片段
 *
 * @param {object} ctx
 * @param {string} ctx.line 当前行
 * @param {number} ctx.column 光标列（1-based）
 * @param {string} ctx.text 全文（用于统计已有标识符）
 * @param {string} ctx.languageId
 * @param {number} [ctx.limit]
 * @returns {{items:Array<{label:string,detail:string,kind:string,score:number}>, prefix:string, from:number}}
 */
export function getCompletions({ line, column, text, languageId, limit = 40 }) {
  const { prefix, from, isMarkdownLead } = getCompletionPrefix(line, column, languageId);

  // 前缀太短不提示：避免每敲一个字母就弹窗骚扰。
  // 例外：Markdown 行首结构、以及刚打完限定符（std:: / os.）
  const endsWithQualifier = /(?:\.|::|->)$/.test(prefix);
  if (!isMarkdownLead && !endsWithQualifier && prefix.length < 2) {
    return { items: [], prefix, from };
  }

  // 空前缀（词首、行首空白、刚删光一个词）不补全。
  // matchScore 对空前缀一律返回 1，那是给「限定符之后」留的全量兜底，
  // 在这里会变成"把文档里所有标识符无条件列出来"，必须挡掉。
  if (!prefix) {
    return { items: [], prefix, from };
  }

  const lower = prefix.toLowerCase();
  const scored = [];
  const seen = new Set();

  const push = (label, detail, kind, score) => {
    if (!label || label === prefix) return;
    const key = label;
    if (seen.has(key)) {
      // 已有同 label，保留分数更高的
      const prev = scored.find((s) => s.label === key);
      if (prev && score > prev.score) {
        prev.score = score;
        prev.detail = detail;
        prev.kind = kind;
      }
      return;
    }
    seen.add(key);
    scored.push({ label, detail, kind, score });
  };

  // 1. 文档内标识符
  const freq = collectIdentifiers(text, languageId);
  for (const [word, count] of freq) {
    const score = matchScore(word, prefix, lower);
    if (score > 0) {
      // 频次加成要压在匹配质量之下：不能让"文档里出现过一次的某个
      // 子串匹配"盖过"标准库里的前缀匹配"。上限 +8，低于一级差距（20）。
      push(word, count > 1 ? `文档内 · ${count} 次` : '文档内', 'text',
        score + Math.min(count, 4) * 2);
    }
  }

  // 2. 标准库符号
  for (const sym of getLibrarySymbols(languageId)) {
    const score = matchScore(sym.label, prefix, lower);
    if (score > 0) {
      // 标准库略降权：让用户自己写的名字优先
      push(sym.label, sym.detail, sym.kind, score - 5);
    }
  }

  // 3. 关键字
  for (const kw of KEYWORDS[languageId] || []) {
    const score = matchScore(kw, prefix, lower);
    if (score > 0) push(kw, '字面量', 'keyword', score - 10);
  }

  // 4. Markdown 片段
  if (languageId === 'markdown') {
    for (const sn of MD_SNIPPETS) {
      const score = isMarkdownLead
        ? (sn.label.startsWith(prefix) ? 60 : 1)
        : matchScore(sn.label, prefix, lower);
      if (score > 0 && sn.label !== prefix) {
        push(sn.label, sn.detail, 'snippet', score);
      }
    }
  }

  const items = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    .slice(0, limit);

  return { items, prefix, from };
}

/**
 * 相关度打分。返回 0 表示不匹配。
 *
 * 分级（参考 VS Code 的排序直觉）：
 *   100  完全相同
 *    80  前缀相同（大小写一致）
 *    70  前缀相同（忽略大小写）
 *    40  词中某段的开头匹配（驼峰或分隔符后）
 *    20  子串包含
 */
function matchScore(word, prefix, lowerPrefix) {
  if (!prefix) return 1;
  if (word === prefix) return 100;

  const lowerWord = word.toLowerCase();
  const lowerTarget = lowerPrefix;

  // 直接前缀匹配：最强
  if (lowerWord.startsWith(lowerTarget)) return word.startsWith(prefix) ? 80 : 70;

  const idx = lowerWord.indexOf(lowerTarget);
  if (idx > 0) {
    // 词边界处的前缀（pylance 风格：os.path./std::vec 这类成员补全）
    const prev = word[idx - 1];
    const isBoundary = prev === '_' || prev === '-' || prev === '.' || prev === ':' ||
      (prev === prev.toLowerCase() && word[idx] === word[idx].toUpperCase());
    if (isBoundary) {
      // 限定符后的匹配价值很高（用户敲 os. 时期望看到 os.xxx）
      return prev === '.' || prev === ':' ? 65 : 40;
    }
    // 纯子串匹配（subprocess 里含 pr）价值很低，
    // 给一个远低于前缀匹配的分数，避免干扰候选列表
    return 8;
  }
  return 0;
}
