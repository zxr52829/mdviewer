/**
 * 测量服务：把「行列」与「像素」互相换算。
 *
 * 两条互补路径，对应 Trae（VS Code）里的两套实现：
 *
 * 1) 定位（列 → 像素）—— 用 Range 对**已渲染的真实文本**实测。
 *    对应 workbench 里 RangeUtil._readClientRects：
 *      range.setStart(firstTextNode, 0)
 *      range.setEnd(targetNode, targetOffset)
 *      range.getClientRects() → 取最后一个 rect 的 right
 *    这样 CJK 宽度、字体回退、粗体、连字、emoji 全部由浏览器算，
 *    不需要在代码里假设任何字符宽度。
 *
 * 2) 汇总（整行宽度）—— 用 canvas 逐字符实测并缓存。
 *    对应 workbench 里 eqs.getCharWidth(char, font)：
 *      ctx.font = font; ctx.measureText(ch).width
 *    每个不同字符只测一次，配合 Map 缓存，足以支撑万行级文件的
 *    横向滚动范围计算。
 *
 * 之所以不预置「ASCII 一档 / CJK 一档」：
 * 那种假设在字体回退、粗体、变体选择符、emoji 组合下必然出错，
 * 且每修一个特例就要补一套规则。浏览器已经是唯一真相。
 */

const FONT_STACK = '"JetBrains Mono","Cascadia Mono",Consolas,"Microsoft YaHei",monospace';
const FONT_SIZE = 13;
const DEFAULT_LINE_HEIGHT = 20;

/** 收集行元素内的文本节点，附带各自起始列偏移（0-based，UTF-16 单元） */
export function collectTextNodes(rowEl) {
  const nodes = [];
  let col = 0;
  const walker = document.createTreeWalker(rowEl, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    if (!n.length) continue;
    nodes.push({ node: n, startCol: col, len: n.length });
    col += n.length;
  }
  return nodes;
}

export class Measurement {
  constructor({ tabSize = 2, fontSize = FONT_SIZE, lineHeight = DEFAULT_LINE_HEIGHT, fontFamily } = {}) {
    this.tabSize = tabSize;
    this.fontSize = fontSize;
    this.fontFamily = fontFamily || FONT_STACK;
    this._cssLineHeight = lineHeight;

    this._canvas = document.createElement('canvas');
    this._ctx = this._canvas.getContext('2d');
    this._fontKey = `${this.fontSize}px ${this.fontFamily}`;
    this._ctx.font = this._fontKey;

    this._charCache = new Map();
    this._range = document.createRange();
    this._lineHeight = lineHeight;

    this._measureLineHeight();
  }

  /** 更新字体参数：清空字符宽度缓存并重测行高 */
  updateMetrics({ fontSize, lineHeight, fontFamily, tabSize } = {}) {
    if (fontSize !== undefined) this.fontSize = fontSize;
    if (fontFamily !== undefined) this.fontFamily = fontFamily;
    if (lineHeight !== undefined) this._cssLineHeight = lineHeight;
    if (tabSize !== undefined) this.tabSize = tabSize;

    this._fontKey = `${this.fontSize}px ${this.fontFamily}`;
    this._ctx.font = this._fontKey;
    // 字体变了，之前按旧字体测出的宽度全部作废
    this._charCache.clear();
    this._measureLineHeight();
    return this._lineHeight;
  }

  get lineHeight() {
    return this._lineHeight;
  }

  /** 行高从实际渲染的探针读，避免与 CSS 的 line-height 脱节 */
  _measureLineHeight() {
    const probe = document.createElement('div');
    probe.textContent = 'M';
    probe.style.cssText = [
      'position:absolute',
      'visibility:hidden',
      'white-space:pre',
      'left:-9999px',
      'top:0',
      `font-family:${this.fontFamily}`,
      `font-size:${this.fontSize}px`,
      `line-height:${this._cssLineHeight}px`,
    ].join(';');
    document.body.appendChild(probe);
    const h = probe.getBoundingClientRect().height;
    probe.remove();
    this._lineHeight = Number.isFinite(h) && h > 0 ? h : this._cssLineHeight;
  }

  /**
   * 单字符宽度（canvas 实测 + 缓存）。对应 Trae 的 getCharWidth(char, font)。
   * 制表符不在这里处理，由调用方按 tab-stop 补齐。
   */
  charWidth(ch) {
    let w = this._charCache.get(ch);
    if (w !== undefined) return w;
    w = this._ctx.measureText(ch).width;
    if (!Number.isFinite(w)) w = 0;
    this._charCache.set(ch, w);
    return w;
  }

  /**
   * 一行文本的显示总宽度（像素），制表符按 tab-stop 补齐。
   * 用于内容区宽度（横向滚动范围）计算。
   */
  lineWidth(text) {
    const tabStop = this.charWidth(' ') * this.tabSize || this.charWidth('M') * this.tabSize;
    let x = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '\t') {
        x = (Math.floor(x / tabStop) + 1) * tabStop;
        continue;
      }
      const cp = text.codePointAt(i);
      if (cp > 0xffff) {
        // 代理对：按一个完整字符测宽
        x += this.charWidth(text.substring(i, i + 2));
        i++;
        continue;
      }
      x += this.charWidth(ch);
    }
    return x;
  }

  /* ================= Range 精测 ================= */

  /**
   * 列（1-based）→ 该位置相对行元素左边缘的像素。
   *
   * @param {HTMLElement} rowEl 行元素（.view-line）
   * @param {number} column 1-based 列
   * @param {Array} [nodes] 预收集的文本节点表
   */
  columnToX(rowEl, column, nodes) {
    const list = nodes || collectTextNodes(rowEl);
    if (!list.length) return 0;

    const target = Math.max(0, column - 1); // 0-based 字符偏移
    const totalLen = list[list.length - 1].startCol + list[list.length - 1].len;

    if (target <= 0) {
      // 列 1 = 文字起点，不是行元素的左边缘。
      // 行元素有 padding-left，若这里返回 0，选区左边界会伸进 padding，
      // 高亮条比文字宽出一截，文字看起来像没被选住。
      return this._firstCharLeft(rowEl, list);
    }
    if (target >= totalLen) {
      // 行尾：整行宽度
      return this._textWidthTo(rowEl, list, list[list.length - 1].node, list[list.length - 1].len);
    }

    // 找到包含 target 的文本节点
    let host = list[list.length - 1];
    for (const entry of list) {
      if (target >= entry.startCol && target <= entry.startCol + entry.len) {
        host = entry;
        break;
      }
    }
    const localOffset = Math.min(host.len, target - host.startCol);
    return this._textWidthTo(rowEl, list, host.node, localOffset);
  }

  /** 行内第一个可见字符的左边缘（相对行元素）。空行返回 0 由调用方兜底。 */
  _firstCharLeft(rowEl, list) {
    const rowRect = rowEl.getBoundingClientRect();
    const first = list[0].node;
    try {
      this._range.setStart(first, 0);
      this._range.setEnd(first, Math.min(1, first.length));
      const rects = this._range.getClientRects();
      if (!rects.length) return 0;
      return rects[0].left - rowRect.left;
    } catch {
      return 0;
    } finally {
      try {
        this._range.detach?.();
      } catch {
        /* 忽略 */
      }
    }
  }

  /** 从行首测到 (node, offset) 的像素宽度，相对行元素左边缘 */
  _textWidthTo(rowEl, list, node, offset) {
    const rowRect = rowEl.getBoundingClientRect();
    const first = list[0].node;
    try {
      this._range.setStart(first, 0);
      this._range.setEnd(node, offset);
      const rects = this._range.getClientRects();
      if (!rects.length) return 0;
      // 单行不换行，最后一个 rect 的右边界就是目标位置的左边界
      const last = rects[rects.length - 1];
      return last.right - rowRect.left;
    } catch {
      return 0;
    } finally {
      // 释放 Range 对 DOM 的引用，避免持有已移除的节点
      try {
        this._range.detach?.();
      } catch {
        /* 旧浏览器无 detach，忽略 */
      }
    }
  }

  /**
   * 像素 x（相对行元素左边缘）→ 列（1-based）。
   * 二分 + Range 精测，最后在相邻两列间取更近者。
   */
  xToColumn(rowEl, x, nodes) {
    const list = nodes || collectTextNodes(rowEl);
    if (!list.length) return 1;

    const totalLen = list[list.length - 1].startCol + list[list.length - 1].len;
    if (x <= 0) return 1;

    // 二分：找最大的 col 使 columnToX(col) <= x
    let lo = 1;
    let hi = totalLen + 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.columnToX(rowEl, mid, list) <= x) lo = mid;
      else hi = mid - 1;
    }

    // 在 lo 与 lo+1 之间选更近的边界
    const xLo = this.columnToX(rowEl, lo, list);
    const xNext = lo + 1 <= totalLen + 1 ? this.columnToX(rowEl, lo + 1, list) : xLo;
    const dLo = Math.abs(x - xLo);
    const dNext = Math.abs(x - xNext);
    return dLo <= dNext ? lo : Math.min(lo + 1, totalLen + 1);
  }
}
