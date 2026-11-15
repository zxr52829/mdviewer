/**
 * 括号配对：深度着色 + 配对查找 + 折叠范围。
 *
 * 对应 Trae / VS Code 的三件事：
 *   - bracketPairColorization：按嵌套深度给括号上不同颜色，颜色取自
 *     editorBracketHighlight.foreground1..3（默认金/紫/蓝，第 4 层起透明）
 *   - 括号配对定位：光标贴在某括号上时高亮它的伙伴
 *   - foldingRanges：可折叠区间（JSON 对象/数组、注释块）
 *
 * 关键约束：扫描必须识别字符串与注释，否则 `"{"` 里的花括号会污染深度，
 * 后续所有括号颜色全错。这一点和 json-service 的 foldRanges 同源。
 */

/** 官方前三层配色（dark 主题值） */
export const BRACKET_COLORS = ['#FFD700', '#DA70D6', '#179FFF'];

const OPEN = { '(': ')', '[': ']', '{': '}' };
const CLOSE = { ')': '(', ']': '[', '}': '{' };

/**
 * 扫描一行，产出每个括号的深度与配对信息。
 *
 * @param {string} line
 * @param {string} languageId
 * @param {number} startDepth 该行起始的嵌套深度（跨行传递）
 * @returns {{brackets:Array<{col:number,depth:number,ch:string,isOpen:boolean,partnerCol:number}>, endDepth:number}}
 */
export function scanLineBrackets(line, languageId, startDepth = 0) {
  const brackets = [];
  const stack = []; // 只存本行未闭合的括号：{ch, col, depth}
  let depth = startDepth;

  // 该语言是否支持注释
  const lineComment = languageId === 'json' || languageId === 'jsonc' ||
    languageId === 'json5' || languageId === 'javascript' || languageId === 'typescript' ||
    languageId === 'css' || languageId === 'scss' || languageId === 'less' ||
    languageId === 'go' || languageId === 'rust' || languageId === 'java' ||
    languageId === 'c' || languageId === 'cpp' || languageId === 'csharp';
  const blockComment = lineComment;

  let inString = false;
  let quote = '';
  let inBlock = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const n = line[i + 1];

    if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === quote) inString = false;
      continue;
    }

    if (blockComment && c === '/' && n === '*') {
      inBlock = true;
      i++;
      continue;
    }
    if (lineComment && c === '/' && n === '/') break; // 行注释到此结束

    if (c === '"' || c === "'" || c === '`') {
      inString = true;
      quote = c;
      continue;
    }

    if (OPEN[c]) {
      brackets.push({ col: i + 1, depth, ch: c, isOpen: true, partnerCol: -1 });
      stack.push({ ch: c, col: i + 1, depth, idx: brackets.length - 1 });
      depth++;
      continue;
    }
    if (CLOSE[c]) {
      // 就近匹配同类开括号；类型不符则忽略（容错优先，不报错）
      let hitIdx = -1;
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].ch === CLOSE[c]) {
          hitIdx = k;
          break;
        }
      }
      if (hitIdx >= 0) {
        const openEntry = stack[hitIdx];
        stack.length = hitIdx;
        depth = openEntry.depth;
        brackets.push({ col: i + 1, depth: openEntry.depth, ch: c, isOpen: false, partnerCol: openEntry.col });
        brackets[openEntry.idx].partnerCol = i + 1;
      } else {
        // 孤立的闭括号：按当前深度着色，不改变层级
        brackets.push({ col: i + 1, depth: Math.max(0, depth - 1), ch: c, isOpen: false, partnerCol: -1 });
      }
    }
  }

  return { brackets, endDepth: depth };
}

/**
 * 把一行内所有括号的深度算出来，返回 col → depth 映射。
 * 用于渲染时给括号套色。
 *
 * @param {string} line
 * @param {string} languageId
 * @param {number} startDepth
 * @returns {{map:Map<number,{depth:number,ch:string}>, endDepth:number}}
 */
export function lineBracketDepths(line, languageId, startDepth) {
  const { brackets, endDepth } = scanLineBrackets(line, languageId, startDepth);
  const map = new Map();
  for (const b of brackets) map.set(b.col, { depth: b.depth, ch: b.ch });
  return { map, endDepth };
}

/**
 * 全书统计每行起始深度。JSON 这类有嵌套的语言需要逐行传递。
 *
 * @param {string[]} lines
 * @param {string} languageId
 * @returns {number[]} 每行起始深度
 */
export function computeLineDepths(lines, languageId) {
  const out = new Array(lines.length);
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    out[i] = depth;
    const res = scanLineBrackets(lines[i], languageId, depth);
    depth = res.endDepth;
  }
  return out;
}

/**
 * 找某位置所属的括号及其配对。
 * 对应 VS Code 的 matchBracket 命令（Ctrl+Shift+\）。
 *
 * @param {string} text 全文
 * @param {number} offset 光标偏移
 * @param {string} languageId
 * @param {(offset:number)=>{line:number,column:number}} offsetToPosition
 * @returns {{open:{line,column}, close:{line,column}}|null}
 */
export function findMatchingBracket(text, offset, languageId, offsetToPosition) {
  // 先看光标处，其次看光标左侧（编辑器惯常行为）
  const candidates = [offset, offset - 1].filter((o) => o >= 0 && o < text.length);
  for (const off of candidates) {
    const ch = text[off];
    if (!OPEN[ch] && !CLOSE[ch]) continue;

    const isOpen = !!OPEN[ch];
    const wantClose = isOpen;
    const target = isOpen ? OPEN[ch] : CLOSE[ch];

    let depth = 0;
    let inString = false;
    let quote = '';

    // 向对应方向扫描，计数抵消
    const step = isOpen ? 1 : -1;
    for (let i = off; i >= 0 && i < text.length; i += step) {
      const c = text[i];
      // 字符串内的括号不参与配对（简化：逐字符判定，不处理跨行字符串）
      if (c === '"' || c === "'" || c === '`') {
        if (!inString) {
          inString = true;
          quote = c;
        } else if (c === quote && text[i - 1] !== '\\') {
          inString = false;
        }
        continue;
      }
      if (inString) continue;

      if (i === off) continue; // 跳过起点自身

      if (wantClose) {
        if (c === ch) depth++;
        else if (c === target) {
          if (depth === 0) {
            return {
              open: isOpen ? offsetToPosition(off) : offsetToPosition(i),
              close: isOpen ? offsetToPosition(i) : offsetToPosition(off),
            };
          }
          depth--;
        }
      } else {
        if (c === ch) depth++;
        else if (c === target) {
          if (depth === 0) {
            return {
              open: offsetToPosition(i),
              close: offsetToPosition(off),
            };
          }
          depth--;
        }
      }
    }
  }
  return null;
}
