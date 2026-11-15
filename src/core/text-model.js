/**
 * 文本模型：在 PieceTree 之上管理行边界、编辑操作归一化与 undo/redo 栈。
 *
 * 对应 Trae/VS Code 的 TextModel + UndoRedoService，砍掉了装饰器、折叠、
 * 多光标等用不到的部分，只保留编辑必需的三件事：
 *   1. edit() 只接受规范化后的 {offset, deleteCount, text}
 *   2. 每次变更递增 version，供视图层判断是否需要重绘
 *   3. undo 栈按时间窗合并连续打字，避免一个字符一个快照
 */

import { PieceTree } from './piece-tree.js';

const UNDO_MERGE_WINDOW_MS = 400;
const UNDO_STACK_LIMIT = 200;

export class TextModel {
  constructor(text = '', { uri = '', languageId = 'plaintext' } = {}) {
    this._buffer = new PieceTree(text);
    this._uri = uri;
    this._languageId = languageId;
    this._undoStack = [];
    this._redoStack = [];
    this._lastEditAt = 0;
    this._version = 0;
    this._onChangeHandlers = new Set();
    // 脏标记按内容判定而非 version：撤销回原文时 version 仍递增，
    // 用 version 比较会误报为已修改。
    this._savedValue = text;
  }

  get uri() {
    return this._uri;
  }
  get languageId() {
    return this._languageId;
  }
  set languageId(v) {
    this._languageId = v;
  }
  get version() {
    return this._buffer.version;
  }
  get isDirty() {
    return this.getValue() !== this._savedValue;
  }
  get length() {
    return this._buffer.length;
  }

  getValue() {
    return this._buffer.getValue();
  }

  getLineCount() {
    return this._buffer.getLineCount();
  }

  getLineContent(lineNumber) {
    return this._buffer.getLineContent(lineNumber);
  }

  /** 全部分行文本。给需要跨行扫描的功能用（如括号深度、折叠范围）。 */
  getLines() {
    return this._buffer.getLines();
  }

  offsetToPosition(offset) {
    return this._buffer.offsetToPosition(offset);
  }

  positionToOffset(line, column) {
    return this._buffer.positionToOffset(line, column);
  }

  onChange(fn) {
    this._onChangeHandlers.add(fn);
    return () => this._onChangeHandlers.delete(fn);
  }

  _emit(change) {
    this._version = this.version;
    for (const fn of this._onChangeHandlers) fn(change);
  }

  markSaved() {
    this._savedValue = this.getValue();
  }

  /**
   * 统一编辑入口。
   * @param {number} offset 起始偏移
   * @param {number} deleteCount 删除长度
   * @param {string} text 插入文本
   */
  edit(offset, deleteCount, text = '') {
    if (deleteCount === 0 && text === '') return false;
    const change = this._buffer.applyEdit(offset, deleteCount, text);
    this._pushUndo(change);
    this._emit(change);
    return true;
  }

  /** 便捷：按行列替换整行 */
  replaceLine(lineNumber, text) {
    const start = this._buffer.positionToOffset(lineNumber, 1);
    const len = this._buffer.getLineContent(lineNumber).length;
    return this.edit(start, len, text);
  }

  /** 便捷：按行列插入 */
  insertAt(line, column, text) {
    return this.edit(this._buffer.positionToOffset(line, column), 0, text);
  }

  /** 便捷：按行列删除区间 */
  deleteRange(startLine, startColumn, endLine, endColumn) {
    const a = this._buffer.positionToOffset(startLine, startColumn);
    const b = this._buffer.positionToOffset(endLine, endColumn);
    if (b <= a) return false;
    return this.edit(a, b - a, '');
  }

  /** 整文件替换（用于格式化）。作为一次原子编辑，可整体撤销。 */
  setValue(text) {
    const len = this._buffer.length;
    return this.edit(0, len, text);
  }

  _pushUndo(change) {
    const now = Date.now();
    const top = this._undoStack[this._undoStack.length - 1];
    // 连续纯插入且间隔很短：合并进上一条，避免逐字符快照
    const mergeable =
      top &&
      now - this._lastEditAt < UNDO_MERGE_WINDOW_MS &&
      top.removed === '' &&
      change.removed === '' &&
      top.offset + top.inserted.length === change.offset;

    if (mergeable) {
      top.inserted += change.inserted;
    } else {
      this._undoStack.push({ ...change });
      if (this._undoStack.length > UNDO_STACK_LIMIT) this._undoStack.shift();
    }
    this._lastEditAt = now;
    this._redoStack.length = 0;
  }

  undo() {
    const entry = this._undoStack.pop();
    if (!entry) return false;
    const change = this._buffer.applyEdit(entry.offset, entry.inserted.length, entry.removed);
    this._redoStack.push({ offset: entry.offset, removed: entry.removed, inserted: entry.inserted });
    this._emit(change);
    return true;
  }

  redo() {
    const entry = this._redoStack.pop();
    if (!entry) return false;
    const change = this._buffer.applyEdit(entry.offset, entry.removed.length, entry.inserted);
    this._undoStack.push({ ...entry });
    this._emit(change);
    return true;
  }
}
