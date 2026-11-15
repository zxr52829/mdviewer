/**
 * 查找命中高亮。
 *
 * 对应 Trae / VS Code 的行为：编辑器里有选区（或查找框有词）时，
 * 文档中**所有**相同的文字都会被标上背景色，而不是只有选区那一处。
 * 这在 VS Code 里叫 editor.findMatchHighlightBackground，
 * 当前命中项另用 editor.findMatchBackground 单独加深。
 *
 * 分层与 Trae 一致：这里只负责「算出哪些区间要标」，渲染交给视图层。
 * 搜索本身是纯函数，可独立测试。
 */

const MAX_HIGHLIGHTS = 2000; // 上限，避免超大文件逐字符命中时拖垮渲染

/**
 * 默认词分隔符。取自 VS Code / Trae 的 editor.wordSeparators 默认值。
 * 整词匹配必须以此判定，不能用 /\w/：
 * \w 含下划线与 ASCII 字母数字，中文既不属于 \w 也不属于分隔符，
 * 用 \w 会把「中文相邻的 ASCII 词」判成非整词，与编辑器行为不符。
 */
const WORD_SEPARATORS = "`~!@#$%^&*()-=+[{]}\\|;:'\",.<>/?";

/** 该字符是否为词分隔符（空白同样视为分隔） */
function isSeparator(ch) {
  if (!ch) return true;
  if (/\s/.test(ch)) return true;
  return WORD_SEPARATORS.includes(ch);
}

/**
 * 在文本里找出所有与 needle 相同的区间。
 *
 * @param {string} text 全文
 * @param {string} needle 查找词
 * @param {{caseSensitive?:boolean, wholeWord?:boolean, limit?:number}} [opts]
 * @returns {Array<{start:number,end:number}>} 按位置升序
 */
export function findAllMatches(text, needle, opts = {}) {
  const { caseSensitive = false, wholeWord = false, limit = MAX_HIGHLIGHTS } = opts;
  if (!needle) return [];

  const haystack = caseSensitive ? text : text.toLowerCase();
  const target = caseSensitive ? needle : needle.toLowerCase();
  if (!target) return [];

  const out = [];
  let from = 0;

  while (from <= haystack.length - target.length) {
    const idx = haystack.indexOf(target, from);
    if (idx < 0) break;

    if (wholeWord) {
      // 边界判定用分隔符集合：两侧要么越界、要么是分隔符才算整词
      const before = idx > 0 ? haystack[idx - 1] : '';
      const after = idx + target.length < haystack.length ? haystack[idx + target.length] : '';
      if (!isSeparator(before) || !isSeparator(after)) {
        from = idx + 1;
        continue;
      }
    }

    out.push({ start: idx, end: idx + target.length });
    if (out.length >= limit) break;
    // 不重叠：从命中末尾继续
    from = idx + target.length;
  }

  return out;
}

/**
 * 把命中区间按行归组，供视图层按行渲染。
 *
 * @param {Array<{start:number,end:number}>} matches
 * @param {(offset:number)=>{line:number,column:number}} offsetToPosition
 * @returns {Map<number, Array<{startCol:number,endCol:number}>>} line → 该行内的列区间（1-based，end 为开区间）
 */
export function groupByLine(matches, offsetToPosition) {
  const map = new Map();
  for (const m of matches) {
    const a = offsetToPosition(m.start);
    const b = offsetToPosition(m.end);
    for (let line = a.line; line <= b.line; line++) {
      const startCol = line === a.line ? a.column : 1;
      const endCol = line === b.line ? b.column : Number.MAX_SAFE_INTEGER;
      if (!map.has(line)) map.set(line, []);
      map.get(line).push({ startCol, endCol });
    }
  }
  return map;
}

/**
 * 把一行的命中区间切成不重叠、可渲染的片段。
 * 与 token 高亮是两套独立标记，这里只产出「哪个区间要加深色底」。
 *
 * @param {Array<{startCol:number,endCol:number}>} ranges 该行命中区间
 * @param {number} lineLength 该行字符数
 * @returns {Uint8Array} 逐字符标记，1 = 命中
 */
export function buildLineMask(ranges, lineLength) {
  const mask = new Uint8Array(lineLength);
  for (const r of ranges) {
    const from = Math.max(0, r.startCol - 1);
    const to = Math.min(lineLength, r.endCol - 1);
    for (let i = from; i < to; i++) mask[i] = 1;
  }
  return mask;
}
