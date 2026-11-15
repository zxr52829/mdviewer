/**
 * 文本缓冲：Piece Table（分段表）
 *
 * 对应 Trae/VS Code 的 vs/editor/common/model/pieceTreeTextBuffer。
 * 原文永不修改，编辑只追加到 add 缓冲，用 {start,end,isAdd} 片段描述逻辑视图，
 * 因此大文件的单次插入是 O(1) 内存追加，而不是每次 SQL 式拼接整串。
 *
 * 折中：这里用扁平 piece 列表 + 惰性重算行索引，不做红黑树。
 * 百万字符以内完全够用，收益是代码可读性远高于原生实现。
 */

const AVG_PIECE_THRESHOLD = 256; // 碎片超过此数触发合并，避免 piece 列表无限增长

export class PieceTree {
  constructor(initial = '') {
    this._original = initial;
    this._add = '';
    this._pieces = initial.length ? [{ start: 0, length: initial.length, add: false }] : [];
    this._length = initial.length;
    this._lineStarts = null; // 惰性
    this._version = 0;
    // getValue 的版本化缓存。定位逻辑（offsetToPosition / positionToOffset /
    // getLineContent）全都依赖全文，若每次都重新拼接，一次按键会被放大成
    // 数十次 O(n) 字符串构造。按 version 缓存后每个版本只拼一次。
    this._valueCache = initial;
    this._valueCacheVersion = 0;
  }

  get version() {
    return this._version;
  }

  get length() {
    return this._length;
  }

  /** 取全文。同一版本内多次调用复用缓存。修改方必须走 applyEdit 以递增 version。 */
  getValue() {
    if (this._valueCacheVersion === this._version) return this._valueCache;
    if (this._pieces.length === 0) {
      this._valueCache = '';
      this._valueCacheVersion = this._version;
      return '';
    }
    const parts = new Array(this._pieces.length);
    for (let i = 0; i < this._pieces.length; i++) {
      const p = this._pieces[i];
      const buf = p.add ? this._add : this._original;
      parts[i] = buf.substr(p.start, p.length);
    }
    const value = parts.join('');
    this._valueCache = value;
    this._valueCacheVersion = this._version;
    return value;
  }

  /** 按行切分（不缓存，用于一次性导出） */
  getLines() {
    return this.getValue().split(/\r\n|\r|\n/);
  }

  getLineCount() {
    return this._ensureLineStarts().length;
  }

  _ensureLineStarts() {
    if (this._lineStarts) return this._lineStarts;
    const text = this.getValue();
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 10) {
        starts.push(i + 1);
      } else if (c === 13) {
        // \r\n 视为一个换行
        if (text.charCodeAt(i + 1) === 10) i++;
        starts.push(i + 1);
      }
    }
    this._lineStarts = starts;
    return starts;
  }

  /** 行号 1-based */
  getLineContent(lineNumber) {
    const starts = this._ensureLineStarts();
    if (lineNumber < 1 || lineNumber > starts.length) return '';
    const text = this.getValue();
    const from = starts[lineNumber - 1];
    let to;
    if (lineNumber < starts.length) {
      to = starts[lineNumber];
      // 去掉行尾换行符
      if (to > 0 && text.charCodeAt(to - 1) === 10) to--;
      if (to > 0 && text.charCodeAt(to - 1) === 13) to--;
    } else {
      to = text.length;
    }
    return text.substring(from, to);
  }

  /** 只取某一行，避免全文复制以外的主要开销还在 getValue，先保持简单 */
  getRange(start, end) {
    const text = this.getValue();
    const from = Math.max(0, Math.min(start, text.length));
    const to = Math.max(from, Math.min(end, text.length));
    return text.substring(from, to);
  }

  /** 偏移 → {line, column}，均 1-based */
  offsetToPosition(offset) {
    const starts = this._ensureLineStarts();
    const text = this.getValue();
    const off = Math.max(0, Math.min(offset, text.length));
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: off - starts[lo] + 1 };
  }

  /** {line, column} → 偏移，均 1-based */
  positionToOffset(line, column) {
    const starts = this._ensureLineStarts();
    const text = this.getValue();
    const l = Math.max(1, Math.min(line, starts.length));
    const base = starts[l - 1];
    const lineEnd = l < starts.length ? starts[l] : text.length;
    const off = base + Math.max(0, column - 1);
    return Math.min(off, lineEnd);
  }

  /**
   * 单段替换。返回 { offset, removed, inserted } 供 undo 栈记录。
   */
  applyEdit(offset, deleteCount, insertText) {
    const text = this.getValue();
    const off = Math.max(0, Math.min(offset, text.length));
    const del = Math.max(0, Math.min(deleteCount, text.length - off));
    const removed = text.substr(off, del);

    // 扁平实现：重建 piece 列表。相比红黑树省掉全部平衡代码，
    // 代价是每次编辑 O(pieces)，配合阈值合并后仍在毫秒级。
    const next = [];
    let consumed = 0;
    for (const p of this._pieces) {
      const pStart = consumed;
      const pEnd = consumed + p.length;
      consumed = pEnd;

      if (pEnd <= off || pStart >= off + del) {
        next.push(p);
        continue;
      }
      // 与删除区间相交：保留左残段与右残段
      if (pStart < off) {
        next.push({ start: p.start, length: off - pStart, add: p.add });
      }
      if (pEnd > off + del) {
        const skip = off + del - pStart;
        next.push({ start: p.start + skip, length: pEnd - (off + del), add: p.add });
      }
    }

    if (insertText) {
      const addStart = this._add.length;
      this._add += insertText;
      // 插入点：找到第一个覆盖 off 的 piece，插在它前面
      let pos = 0;
      let acc = 0;
      for (let i = 0; i < next.length; i++) {
        if (acc >= off) break;
        acc += next[i].length;
        pos = i + 1;
      }
      next.splice(pos, 0, { start: addStart, length: insertText.length, add: true });
    }

    this._pieces = next.length > AVG_PIECE_THRESHOLD * 8 ? this._compact(next) : next;
    this._length = this._length - del + insertText.length;
    this._lineStarts = null;
    this._version++;
    return { offset: off, removed, inserted: insertText || '' };
  }

  /** 碎片过多时把 add 缓冲折进原始缓冲，piece 重排 */
  _compact(pieces) {
    const merged = pieces
      .map((p) => ({ ...p, text: (p.add ? this._add : this._original).substr(p.start, p.length) }))
      .map((p) => p.text);
    const flat = merged.join('');
    this._original = flat;
    this._add = '';
    this._length = flat.length;
    return flat.length ? [{ start: 0, length: flat.length, add: false }] : [];
  }
}
