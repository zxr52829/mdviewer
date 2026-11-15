/**
 * 编辑器视图：视口内行渲染 + 光标 + 选区 + 键盘输入。
 *
 * 对照 Trae/VS Code 的 viewModel：
 *   - 原生走 DOM 行复用（viewLines），视口外只保留高度占位
 *   - 每行对应一个 .view-line，行号在 gutter 独立渲染
 *   - 光标是绝对定位的两个元素（caret + selection overlay），不是原生 selection
 *
 * 这里保留同样的分层，但把「测量字符宽度」换成一次运行时实测：
 * 等宽字体下所有字符同宽，量一次即可，不必每次二分测量。
 * 硬编码宽度会在字体回退时（JetBrains Mono 缺失 → Consolas）产生
 * 每列 10% 的累积误差，几十列后光标与文字明显错位。
 *
 * 命中测试：offset → (line, col) 用行索引二分；col 用实测字符宽度除法。
 */

import { renderLineHtml } from '../lang/highlighter.js';
import { Measurement, collectTextNodes } from './text-metrics.js';
import { findAllMatches, groupByLine, buildLineMask } from './find-highlight.js';
import {
  getAutoClosePair,
  isClosingChar,
  getSurroundingPair,
  getEnterAction,
} from '../lang/edit-behavior.js';
import { getWordAtPosition } from '../lang/language-config.js';
import { shouldDeletePair } from '../lang/edit-behavior.js';
import { lineBracketDepths, computeLineDepths, findMatchingBracket } from '../lang/brackets.js';
import { getCompletions } from '../lang/completion.js';
import {
  collectDiagnostics,
  countDiagnostics,
  groupByLine as groupDiagnosticsByLine,
} from '../lang/diagnostics.js';
import { SuggestWidget } from './suggest-widget.js';

const ROW_HEIGHT = 20;
const PAD_TOP = 8;
const PAD_LEFT = 12;
const RIGHT_PAD = 24; // 行尾留白，避免光标贴住右边界
const GUTTER_WIDTH = 56; // 必须与 .editor-gutter 的 CSS 宽度一致
const TAB_SIZE = 2;
const DIAG_DEBOUNCE = 300; // ms，用户停手后才跑全量诊断

export class EditorView {
  /**
   * @param {HTMLElement} root 编辑器容器
   * @param {import('../core/text-model.js').TextModel} model
   */
  /**
   * @param {HTMLElement} root 编辑器容器
   * @param {import('../core/text-model.js').TextModel} model
   * @param {object} [opts] 初始化选项（字号/行高/字体/制表符）
   */
  constructor(root, model, opts = {}) {
    this.root = root;
    this.model = model;

    this._lineCount = 0;
    this._lineEls = new Map(); // lineNumber -> { row, gutter, content }
    this._cursor = { line: 1, column: 1 };
    this._anchor = null; // 选区锚点
    this._desiredColumn = 1;
    this._scrollTop = 0;
    this._highlightCache = new Map(); // lineNumber -> {version, html}
    this._listeners = { cursor: new Set(), content: new Set(), diagnostics: new Set() };

    // 度量一律运行时实测。等宽字体只对 ASCII 同宽，CJK 与全角标点是
    // 另一档宽度，且字体回退（JetBrains Mono 缺失 → Consolas）会改变
    // 实际宽度，所以不能硬编码，必须每次按当前字体重新测。
    this._metricOpts = {
      fontSize: opts.fontSize ?? 13,
      lineHeight: opts.lineHeight ?? 20,
      fontFamily: opts.fontFamily,
      tabSize: opts.tabSize ?? TAB_SIZE,
    };
    this._metrics = new Measurement(this._metricOpts);
    this._lh = this._metrics.lineHeight;
    this._tabSize = this._metricOpts.tabSize;
    this._bracketColorization = opts.bracketColorization !== false;
    this._contentWidth = 0;
    // 查找高亮状态：选区变化时把选区文字当作查找词，全文档同类文字一起标黄
    this._matchByLine = null; // Map<line, ranges[]>
    this._matchCount = 0;
    this._findRevision = 0; // 命中态变化时递增，用于让行渲染缓存失效

    // 诊断状态：diagnostics.js 的结果按行分组 + 计数。
    // 诊断不参与 renderLineHtml 的边界并集（波浪线走 CSS text-decoration，
    // 装订线走独立子元素），所以只需要一个 revision 让缓存失效。
    this._diagByLine = null; // Map<line, diagnostics[]>
    this._diagList = [];
    this._diagCounts = { errors: 0, warnings: 0, total: 0 };
    this._diagRevision = 0;
    this._diagVersion = -1; // 已经诊断过的 model.version
    this._diagTimer = null;

    this._buildDom();
    this._bindEvents();
    this.refresh();
    this._observeResize();
    // 首帧后校准一次：初始化时布局可能尚未定稿
    requestAnimationFrame(() => {
      this._syncWidth();
      this.renderVisible();
      this._renderCursor();
    });
  }

  get cursor() {
    return { ...this._cursor };
  }

  get selection() {
    if (!this._anchor) return null;
    const a = this.model.positionToOffset(this._anchor.line, this._anchor.column);
    const b = this.model.positionToOffset(this._cursor.line, this._cursor.column);
    if (a === b) return null;
    return {
      start: a < b ? this._anchor : this._cursor,
      end: a < b ? this._cursor : this._anchor,
    };
  }

  on(event, fn) {
    this._listeners[event]?.add(fn);
    return () => this._listeners[event]?.delete(fn);
  }

  _emit(event, payload) {
    for (const fn of this._listeners[event] || []) fn(payload);
  }

  _buildDom() {
    this.root.classList.add('editor-root');
    this.root.innerHTML = `
      <div class="editor-scroll" tabindex="-1" role="none">
        <div class="editor-gutter" aria-hidden="true"></div>
        <div class="editor-content">
          <div class="editor-rows"></div>
          <div class="editor-caret" aria-hidden="true"></div>
          <div class="editor-selection" aria-hidden="true" hidden></div>
        </div>
      </div>
      <!-- 隐藏输入代理：真正接收键盘输入的只有这一个 textarea。
           原因：浏览器只在可编辑元素上派发 beforeinput / composition 事件。
           普通 div 即使有 tabindex 也收不到字符输入，只会收到 keydown，
           中文输入法与粘贴同样失效。VS Code 用的也是这套隐藏 textarea 方案。 -->
      <textarea class="editor-input" autocomplete="off" autocorrect="off"
                autocapitalize="off" spellcheck="false" tabindex="0"
                aria-label="文本编辑器" aria-multiline="true"></textarea>
      <div class="suggest-layer" aria-live="polite"></div>
    `;
    this.scroller = this.root.querySelector('.editor-scroll');
    this.gutter = this.root.querySelector('.editor-gutter');
    this.content = this.root.querySelector('.editor-content');
    this.rows = this.root.querySelector('.editor-rows');
    this.caretEl = this.root.querySelector('.editor-caret');
    this.selEl = this.root.querySelector('.editor-selection');
    this.input = this.root.querySelector('.editor-input');
    this.scroller.setAttribute('aria-hidden', 'true');

    // 补全下拉挂在 editor-root 上而非滚动容器内：
    // 放在滚动容器里会随内容一起滚动，导致浮层位置漂移。
    const suggestLayer = this.root.querySelector('.suggest-layer');
    this.suggest = new SuggestWidget(suggestLayer);
    this.suggest.onAccept = (item) => this._acceptCompletion(item);
  }

  /* ---------------- 补全 ---------------- */

  /** 触发补全（由输入或快捷键调用） */
  triggerSuggest() {
    if (this._suggestEnabled === false) return;

    const line = this.model.getLineContent(this._cursor.line);
    const res = getCompletions({
      line,
      column: this._cursor.column,
      text: this.model.getValue(),
      languageId: this.model.languageId,
    });

    this._suggestFrom = res.from;
    this._suggestPrefix = res.prefix;

    if (!res.items.length) {
      this.suggest.hide();
      return;
    }

    // 位置：光标下方。坐标相对 .editor-root
    const { top, left } = this._cursorPixel();
    const contentRect = this.content.getBoundingClientRect();
    const rootRect = this.root.getBoundingClientRect();
    const scrollTop = this.scroller.scrollTop;

    const x = contentRect.left - rootRect.left + left;
    const y = contentRect.top - rootRect.top + top - scrollTop;

    this.suggest.show(res.items, res.prefix, {
      left: x,
      top: y,
      lineHeight: this._lh,
      containerHeight: this.scroller.clientHeight,
    });
  }

  /** 接受某个候选：用它替换当前前缀 */
  _acceptCompletion(item) {
    const from = this._suggestFrom ?? this._cursor.column;
    const line = this._cursor.line;
    const offset = this.model.positionToOffset(line, from);
    const replaceLen = this._cursor.column - from;

    this.suggest.hide();
    this.model.edit(offset, replaceLen, item.label);

    // 光标移到插入内容之后
    const pos = this.model.offsetToPosition(offset + item.label.length);
    this._cursor = pos;
    this._clampCursor();
    this._ensureVisible();
    this._renderCursor();
    this._emit('cursor', this.cursor);
  }

  /** 补全是否应该保持打开（输入过程中）
   *  只在「正在输入的词没被破坏」时刷新，否则关闭 */
  _refreshSuggestOnInput() {
    if (!this.suggest.isVisible) return;
    const line = this.model.getLineContent(this._cursor.line);
    const from = this._suggestFrom ?? this._cursor.column;

    // 光标跑到了前缀起点之前，说明结构变了
    if (this._cursor.column < from) {
      this.suggest.hide();
      return;
    }
    this.triggerSuggest();
  }


  /**
   * input 事件兜底：某些浏览器对 beforeinput 支持不完整
   * （或输入法直接改 value），这里对比 textarea 与当前行的差异。
   *
   * textarea 始终镜像当前行，所以用「最长公共前后缀」找出真正变动的那一段，
   * 转成一次模型编辑。这比"取出新增字符"更稳，能同时处理插入、删除、替换。
   */
  _onInputFallback(e) {
    if (this._composing) return;

    // beforeinput 已处理过则跳过，避免重复插入
    if (this._handledByBeforeInput) {
      this._handledByBeforeInput = false;
      this._syncInputValue();
      return;
    }

    const line = this.model.getLineContent(this._cursor.line);
    const next = this.input.value;
    if (next === line) return;

    // 计算差异：公共前缀 + 公共后缀
    let prefix = 0;
    const maxPrefix = Math.min(line.length, next.length);
    while (prefix < maxPrefix && line[prefix] === next[prefix]) prefix++;

    let suffix = 0;
    const maxSuffix = Math.min(line.length - prefix, next.length - prefix);
    while (suffix < maxSuffix && line[line.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;

    const removedCount = line.length - prefix - suffix;
    const inserted = next.substring(prefix, next.length - suffix);

    const lineStartOffset = this.model.positionToOffset(this._cursor.line, 1);
    this._anchor = null;
    this.model.edit(lineStartOffset + prefix, removedCount, inserted);

    // 光标落到插入内容之后
    const pos = this.model.offsetToPosition(lineStartOffset + prefix + inserted.length);
    this._cursor = pos;
    this._clampCursor();
    this._ensureVisible();
    this._renderCursor();
    this._syncInputValue();
    this.triggerSuggest();
    this._emit('cursor', this.cursor);
  }

  /**
   * 同步 textarea 内容与光标位置。
   *
   * 为什么不能一直清空：textarea 的 value 为空时，浏览器认为"没有内容可删"，
   * Backspace / Delete 会返回成功但不派发任何 beforeinput/input 事件，
   * 表现就是「退格没反应、补全不更新」。同理方向键也无处可移动。
   *
   * 正确做法：让 textarea 持有当前行文本，并把 selection 放在与光标
   * 一致的偏移上。这样浏览器的删除、移动、输入都有真实作用对象。
   */
  _syncInputValue() {
    const line = this.model.getLineContent(this._cursor.line);
    const caret = Math.max(0, Math.min(this._cursor.column - 1, line.length));

    if (this.input.value !== line) {
      this.input.value = line;
    }
    try {
      this.input.setSelectionRange(caret, caret);
    } catch {
      /* 隐藏元素上某些浏览器会抛错，忽略 */
    }
  }

  _bindEvents() {
    this.scroller.addEventListener('scroll', () => {
      this._scrollTop = this.scroller.scrollTop;
      // 行号栏在滚动容器内是 absolute 定位，横向滚动会把它一起带走。
      // 反向平移抵消，让它看起来固定在左侧。
      this._syncGutterPosition();
      this.renderVisible();
    });

    // 鼠标交互仍挂在可见区域上（选区要靠坐标命中）
    this.scroller.addEventListener('mousedown', (e) => this._onMouseDown(e));

    // 键盘与输入事件挂在隐藏 textarea 上：这是唯一能收到字符与
    // 输入法事件的地方。挂在普通 div 上只会收到 keydown，打不出字。
    this.input.addEventListener('keydown', (e) => this._onKeyDown(e));
    this.input.addEventListener('beforeinput', (e) => this._onBeforeInput(e));
    this.input.addEventListener('input', (e) => this._onInputFallback(e));
    this.input.addEventListener('copy', (e) => this._onCopy(e));
    this.input.addEventListener('cut', (e) => this._onCut(e));
    this.input.addEventListener('paste', (e) => this._onPaste(e));

    // 输入法：组合期间不拦截，结束后取上屏文本
    this.input.addEventListener('compositionstart', () => {
      this._composing = true;
    });
    this.input.addEventListener('compositionend', (e) => {
      this._composing = false;
      const text = e.data;
      if (text) {
        this.insertText(text);
        this.afterEdit();
      }
      this._syncInputValue();
    });

    // 点击可见区域时把焦点交给隐藏输入框。
    // 用 pointerdown 而不是 mouseup：mouseup 时浏览器可能已经把焦点
    // 给了别的节点，拖拽结束才补 focus 会丢掉第一次按键。
    this.scroller.addEventListener('pointerdown', () => {
      // 不 preventDefault，让 _onMouseDown 继续处理选区
      queueMicrotask(() => this.input.focus({ preventScroll: true }));
    });

    // 兜底：只要焦点跑丢，用户任何一次按键都重新夺回
    this.input.addEventListener('blur', () => {
      this._inputBlurredAt = Date.now();
      this.root.classList.remove('focused');
    });

    // 光标显隐跟随真实焦点（在隐藏 textarea 上）
    this.input.addEventListener('focus', () => {
      this.root.classList.add('focused');
    });

    // 模型变更后重绘
    this.model.onChange((change) => {
      const prevCount = this._lineCount;
      this._lineCount = this.model.getLineCount();
      this._clampCursor();

      // 行数变了说明发生了增删行，高度占位与宽度都要整体校正；
      // 否则只需按编辑点所在行做增量宽度检查。
      if (this._lineCount !== prevCount) {
        this.rows.style.height = `${this._lineCount * this._lh}px`;
        this.gutter.style.height = `${this._lineCount * this._lh}px`;
        this.content.style.height = `${this._lineCount * this._lh}px`;
        this._syncWidth();
      } else if (change && typeof change.offset === 'number') {
        const pos = this.model.offsetToPosition(change.offset);
        this._syncWidth(pos.line);
      }

      // 括号深度必须整体重算：即使只插入一个 "{"，其后所有行的起始深度
      // 都会变化，增量更新会留下错误的着色。文本量小时这个开销可忽略。
      this._recomputeLineDepths();

      // 文字变了，命中区间必须按新内容重算。
      // 仍有选区时沿用同一查找词重扫（避免边打字边高亮闪断）；
      // 选区已被编辑清空时则一并清掉标记，与"选区为空即无高亮"一致。
      // render=false：随后统一重绘一次。
      if (this._anchor) {
        this._syncFindHighlight(this.selection, { render: false });
      } else if (this._matchByLine) {
        this._syncFindHighlight(null, { render: false });
      }
      this.renderVisible();
      this._emit('content', null);
    });
  }

  /* ---------------- 渲染 ---------------- */

  /** 全文变更后重建高度占位并重绘 */
  refresh() {
    this._lineCount = this.model.getLineCount();
    this._highlightCache.clear();
    // 括号深度必须跨行传递：第 N 行的起始深度取决于前 N-1 行的括号净增量。
    // 漏掉这步的话每行都从 0 开始，所有括号都会是第 0 层同一颜色。
    this._recomputeLineDepths();
    this.rows.style.height = `${this._lineCount * this._lh}px`;
    this.gutter.style.height = `${this._lineCount * this._lh}px`;
    this.content.style.height = `${this._lineCount * this._lh}px`;
    this._syncWidth();
    this.renderVisible();
    this._renderCursor();
    this._emit('cursor', this.cursor);
    // 格式化、压缩、外部整文件替换都走 refresh，诊断同样要跟上。
    // 这里用立即执行而非防抖：这些操作本身就是一次性的终态变化。
    this._scheduleDiagnostics();
  }

  /**
   * 应用新的度量设置（字号 / 行高 / 字体 / 制表符 / 括号配色）。
   *
   * 必须走完整重排：字符宽度变了，光标、选区、命中高亮、横向滚动范围
   * 全部要按新宽度重算。只改 CSS 不重测会让定位整体错位。
   *
   * @param {{fontSize?:number,lineHeight?:number,fontFamily?:string,tabSize?:number,bracketColorization?:boolean}} opts
   */
  applyMetrics(opts = {}) {
    if (opts.tabSize !== undefined) this._tabSize = opts.tabSize;
    if (opts.bracketColorization !== undefined) this._bracketColorization = opts.bracketColorization;

    const lh = this._metrics.updateMetrics({
      fontSize: opts.fontSize,
      lineHeight: opts.lineHeight,
      fontFamily: opts.fontFamily,
      tabSize: opts.tabSize,
    });
    this._lh = lh;

    // 字体变了，行高可能也变；行缓存里的 HTML 含字号无关内容，
    // 但括号深度与命中遮罩要按新宽度重排，干脆整体失效
    this._highlightCache.clear();
    this._lineEls.forEach((els) => {
      els.textNodes = null;
      els.textKey = undefined;
    });

    this._lineCount = this.model.getLineCount();
    this.rows.style.height = `${this._lineCount * this._lh}px`;
    this.gutter.style.height = `${this._lineCount * this._lh}px`;
    this.content.style.height = `${this._lineCount * this._lh}px`;

    // 已有行元素需要按新行高重新定位
    for (const [lineNo, els] of this._lineEls) {
      const top = `${PAD_TOP + (lineNo - 1) * this._lh}px`;
      els.row.style.top = top;
      els.gutter.style.top = top;
    }

    this._recomputeLineDepths();
    this.relayout();
  }

  /** 重算每行起始括号深度 */
  _recomputeLineDepths() {
    const lines = this.model.getLines ? this.model.getLines() : this.model.getValue().split(/\r\n|\r|\n/);
    this._lineDepths = computeLineDepths(lines, this.model.languageId);
  }

  /**
   * 重新布局：重算内容区宽度并重绘。
   *
   * 必须由外部在「分栏/面板状态确定之后」显式调用一次。
   * 构造本视图时右侧预览面板通常还没打开，编辑器临时占满整幅宽度，
   * 据此算出的内容宽度会接近真实值的两倍；面板一打开布局收窄，
   * 那个偏大的宽度如果没被纠正，中间行选区就会铺满整条超宽内容区。
   * ResizeObserver 在部分受限环境（后台标签、无头驱动）不保证触发，
   * 所以不能只依赖它。
   */
  relayout() {
    this._syncWidth();
    this._lastAvail = Math.max(0, this.scroller.clientWidth - GUTTER_WIDTH);
    this._highlightCache.clear();
    this.renderVisible();
    this._renderCursor();
  }

  /**
   * 监听容器尺寸变化兜底（窗口缩放、侧栏拖拽）。
   * 不作为唯一手段，见 relayout 的说明。
   */
  _observeResize() {
    if (typeof ResizeObserver === 'undefined') return;
    if (this._resizeObserver) this._resizeObserver.disconnect();
    this._resizeObserver = new ResizeObserver(() => {
      const avail = Math.max(0, this.scroller.clientWidth - GUTTER_WIDTH);
      if (avail !== this._lastAvail) {
        this._lastAvail = avail;
        this._syncWidth();
        this.renderVisible();
        this._renderCursor();
      }
    });
    this._resizeObserver.observe(this.scroller);
  }

  /**
   * 同步内容区宽度：取「容器可用宽度」与「最长行所需宽度」的较大者。
   *
   * 必须这么做，否则超出容器右侧的行会被 `overflow` 裁掉且无法横向滚动，
   * 长行尾部的文字就"消失"了。行宽由实测字符宽度逐字符累加得出。
   *
   * 注意：结果必须是「可收缩」的。只在变宽时更新会让容器变窄后
   * 内容区仍停在旧宽度，横向滚动条和选区宽度都跟着错。
   *
   * @param {number} [onlyLine] 只重新评估某一行的宽度（编辑后的增量更新）
   */
  _syncWidth(onlyLine) {
    const avail = Math.max(0, this.scroller.clientWidth - GUTTER_WIDTH);

    if (typeof onlyLine === 'number') {
      // 增量：只算这一行，避免每次敲键都全文扫描
      const lineW = this._metrics.lineWidth(this.model.getLineContent(onlyLine));
      const needNow = Math.ceil(lineW) + PAD_LEFT + RIGHT_PAD;
      const next = Math.max(avail, needNow);
      // 该行是这个宽度决定的（撑大），或者收缩后仍不小于其它行时方可收紧。
      // 保守起见只在变宽时更新；变窄的情况交给下一次 refresh / resize。
      if (next > (this._contentWidth || 0)) {
        this._contentWidth = next;
        this.content.style.width = `${next}px`;
      }
      return;
    }

    let widest = 0;
    const total = this._lineCount;
    // 全文扫描；仅在 refresh / 整文件替换时触发
    for (let n = 1; n <= total; n++) {
      const w = this._metrics.lineWidth(this.model.getLineContent(n));
      if (w > widest) widest = w;
    }
    const need = Math.ceil(widest) + PAD_LEFT + RIGHT_PAD;
    this._contentWidth = Math.max(avail, need);
    this.content.style.width = `${this._contentWidth}px`;
  }

  /** 横向滚动时把行号栏拉回左侧，保持固定 */
  _syncGutterPosition() {
    const sl = this.scroller.scrollLeft;
    if (this._gutterShift === sl) return;
    this._gutterShift = sl;
    this.gutter.style.transform = sl ? `translateX(${sl}px)` : '';
  }
  /** 只渲染视口内的行 */
  renderVisible() {
    const viewportH = this.scroller.clientHeight || 600;
    const BUFFER = 8;
    // 直接读实时 scrollTop，不用缓存字段：程序化赋值或同帧内多次滚动时
    // scroll 事件可能被合并，缓存的 _scrollTop 会滞后，导致渲染窗口不跟随。
    const scrollTop = this.scroller.scrollTop;
    this._scrollTop = scrollTop;

    const first = Math.max(1, Math.floor((scrollTop - PAD_TOP) / this._lh) - BUFFER);
    const last = Math.min(this._lineCount, Math.ceil((scrollTop + viewportH) / this._lh) + BUFFER);

    // 回收视口外的行
    for (const [lineNo, els] of this._lineEls) {
      if (lineNo < first || lineNo > last) {
        els.row.remove();
        els.gutter.remove();
        this._lineEls.delete(lineNo);
      }
    }

    // 补齐视口内的行
    for (let n = first; n <= last; n++) {
      if (!this._lineEls.has(n)) this._createLine(n);
      this._updateLine(n);
    }

    // 横向位置同步挂在这里，而不是只依赖 scroll 事件：
    // 程序化设置 scrollLeft、或事件被合并/延迟时，事件缺失会让行号栏错位。
    this._syncGutterPosition();
    this._renderCursor();
  }

  _createLine(lineNo) {
    const row = document.createElement('div');
    row.className = 'view-line';
    row.style.top = `${PAD_TOP + (lineNo - 1) * this._lh}px`;
    row.dataset.line = String(lineNo);

    const gutter = document.createElement('div');
    gutter.className = 'view-gutter-line';
    gutter.style.top = `${PAD_TOP + (lineNo - 1) * this._lh}px`;

    // 行号与诊断标记分两个节点：直接写 textContent 塞不进标记，
    // 而混进同一个文本节点会让标记随行号一起被选中/复制。
    const num = document.createElement('span');
    num.className = 'gutter-num';
    num.textContent = String(lineNo);
    const mark = document.createElement('span');
    mark.className = 'gutter-mark';
    gutter.appendChild(num);
    gutter.appendChild(mark);

    this.rows.appendChild(row);
    this.gutter.appendChild(gutter);
    this._lineEls.set(lineNo, { row, gutter, gutterMark: mark, gutterNum: num });
  }

  /**
   * 重算查找高亮。
   *
   * 触发时机与 Trae 一致：选区变化、文档内容变化、查找词被外部设置。
   * 选区为空时清除高亮；选区所在位置本身也参与标记（这样用户能一眼
   * 看出"这段文字在全文出现过几次"）。
   *
   * @param {string} [needle] 显式查找词；省略则以当前选区文本为准
   * @param {{render?:boolean}} [opts] render=false 时只更新数据，
   *   由调用方负责随后重绘（避免在 onChange 里双重渲染）
   */
  updateFindHighlight(needle, opts = {}) {
    const { render = true } = opts;
    let word = needle;
    if (word === undefined) {
      const sel = this.selection;
      word = sel ? this.selectedText() : '';
    }

    // 过长或纯空白不标记：通常是误操作全选，逐字符标满没有意义
    if (!word || word.length > 200 || !word.trim()) {
      if (this._matchByLine) {
        this._matchByLine = null;
        this._matchCount = 0;
        this._findRevision++;
        this._highlightCache.clear();
        if (render) this.renderVisible();
      }
      return;
    }

    const text = this.model.getValue();
    const matches = findAllMatches(text, word, { caseSensitive: false });
    this._matchByLine = groupByLine(matches, (off) => this.model.offsetToPosition(off));
    this._matchCount = matches.length;
    this._findRevision++;
    // 命中集合变了，行缓存整体失效
    this._highlightCache.clear();
    if (render) this.renderVisible();
    this._emit('find', { word, count: matches.length });
  }

  /** 当前查找命中总数 */
  get matchCount() {
    return this._matchCount;
  }

  /**
   * 选区 → 查找高亮的同步。
   *
   * 语义与 VS Code 一致：选区为空则高亮必须消失
   * （原生用 _selectionIsEmpty 判定，见 ViewModel 的 shouldRenderInContent）。
   * 早期版本把"点击别处后保留高亮"当特性，结果原选中区域还留着黄底，
   * 看起来像选区没清掉 —— 那是错觉，不该保留。
   *
   * @param {object|null} sel 当前选区；null 表示无选区
   */
  _syncFindHighlight(sel, opts = {}) {
    const { render = true } = opts;

    // 设置里关闭了查找高亮时直接清空，不再扫描全文
    if (!sel || this._findHighlightEnabled === false) {
      if (this._findWord || this._matchByLine) {
        this._findWord = '';
        this.updateFindHighlight('', { render });
      }
      return;
    }

    const a = this.model.positionToOffset(sel.start.line, sel.start.column);
    const b = this.model.positionToOffset(sel.end.line, sel.end.column);
    let word = this.model.getValue().substring(a, b);
    // 跨行选区含换行符时不是"一个词"，做全文匹配没有意义
    // （会把整段结构当成查找词，命中数恒为 1）。
    if (word.includes('\n') || word.includes('\r')) word = '';
    if (word === this._findWord) return;
    this._findWord = word;
    this.updateFindHighlight(word, { render });
  }

  /** 开关查找高亮（设置项 editor.findHighlight） */
  setFindHighlightEnabled(enabled) {
    this._findHighlightEnabled = !!enabled;
    if (!enabled) {
      this.clearFindHighlight();
    } else if (this.selection) {
      this._syncFindHighlight(this.selection);
    }
  }

  /** 显式清除查找高亮（Esc、点击空白、切换文件等） */
  clearFindHighlight() {
    this._findWord = '';
    this.updateFindHighlight('');
  }

  /**
   * 选中下一个相同词（Ctrl+D）。
   *
   * 无选区时先按语言 wordPattern 选中光标处的词；已有选区时跳到
   * 当前选区之后的下一个相同文本，并滚到可见。对应 Trae 的
   * addSelectionToNextFindMatch 的单选区形态。
   */
  selectNextOccurrence() {
    const sel = this.selection;

    // 无选区：选中光标处的整词
    if (!sel) {
      const line = this.model.getLineContent(this._cursor.line);
      const word = getWordAtPosition(line, this._cursor.column, this.model.languageId);
      if (!word) return;
      this._cursor = { line: this._cursor.line, column: word.endColumn };
      this._anchor = { line: this._cursor.line, column: word.startColumn };
      this._renderCursor();
      this._syncFindHighlight(this.selection);
      this._emit('cursor', this.cursor);
      return;
    }

    const a = this.model.positionToOffset(sel.start.line, sel.start.column);
    const b = this.model.positionToOffset(sel.end.line, sel.end.column);
    const word = this.model.getValue().substring(a, b);
    if (!word || word.includes('\n')) return;

    const text = this.model.getValue();
    const lower = text.toLowerCase();
    const target = word.toLowerCase();

    // 从当前选区末尾开始找下一个；到文件尾则从头绕回
    let next = lower.indexOf(target, b);
    if (next < 0) next = lower.indexOf(target);

    if (next < 0) return;

    const startPos = this.model.offsetToPosition(next);
    const endPos = this.model.offsetToPosition(next + word.length);
    this._anchor = startPos;
    this._cursor = endPos;
    this._ensureVisible();
    this._renderCursor();
    this._syncFindHighlight(this.selection);
    this._emit('cursor', this.cursor);
  }

  _updateLine(lineNo) {
    const els = this._lineEls.get(lineNo);
    if (!els) return;

    // 缓存键要含三层标记的状态：
    //   matchKey    —— 查找命中变化（version 不变但高亮要变）
    //   bracketKey  —— 括号配对高亮变化
    //   version     —— 语法着色随内容变
    // 只用 version 会让另外两层改动后仍渲染旧内容。
    const matchRanges = this._matchByLine ? this._matchByLine.get(lineNo) : null;
    const matchKey = matchRanges ? matchRanges.length + ':' + this._findRevision : '0';

    const hlCols = this._bracketHighlight ? this._bracketHighlight.get(lineNo) : null;
    const bracketKey = hlCols ? Array.from(hlCols).sort((a, b) => a - b).join(',') : '0';

    const diagRanges = this._diagByLine ? this._diagByLine.get(lineNo) : null;
    const diagKey = diagRanges ? diagRanges.length + ':' + this._diagRevision : '0';

    let cached = this._highlightCache.get(lineNo);
    if (!cached || cached.version !== this.model.version ||
        cached.matchKey !== matchKey || cached.bracketKey !== bracketKey ||
        cached.diagKey !== diagKey) {
      const text = this.model.getLineContent(lineNo);

      let mask = null;
      if (matchRanges && text.length) {
        mask = buildLineMask(matchRanges, text.length);
      }

      // 括号深度：本行起始深度由跨行传递表给出。
      // 关闭括号配色时不产出深度表，渲染层自然不着色。
      let bracketMap = null;
      if (this._bracketColorization) {
        const startDepth = this._lineDepths ? (this._lineDepths[lineNo - 1] || 0) : 0;
        bracketMap = lineBracketDepths(text, this.model.languageId, startDepth).map;
      }

      // 配对高亮：本行需要描边的列
      let highlight = null;
      if (hlCols && hlCols.size) {
        const cols = Array.from(hlCols);
        highlight = { matchCol: cols[0], partnerCol: cols[1] ?? cols[0] };
      }

      cached = {
        version: this.model.version,
        matchKey,
        bracketKey,
        diagKey,
        html: renderLineHtml(text, this.model.languageId, mask, bracketMap, highlight),
        text,
      };
      this._highlightCache.set(lineNo, cached);
    }

    // 用普通 JS 字段做脏检查。之前存在 dataset 里，等于把整段 HTML
    // 序列化进 DOM 属性再读回来，既慢又容易在转义上来回失真。
    if (els.rendered !== cached.html) {
      els.row.innerHTML = cached.html || '<br />';
      els.rendered = cached.html;
      // 关键：innerHTML 换掉了所有子节点，旧的文本节点引用全部失效。
      // 不清理会让 Range 测量（光标/选区定位）操作在已脱离文档的节点上。
      els.textNodes = null;
      els.textKey = undefined;
    }

    this._applyDiagnosticMarks(lineNo, els, diagRanges);
  }

  /**
   * 把诊断画到已渲染的行上。
   *
   * 两条独立通道：
   *   - 装订线：往 gutterMark 里塞一个圆点。与行号节点分离，不互相覆盖。
   *   - 行内：用 CSS text-decoration 波浪线。不并入 renderLineHtml 的
   *     边界并集 —— 走那条路要与 token/match/bracket 三层切割对齐，
   *     改动面大且容易互相切断着色。text-decoration 不能跨行，正好符合
   *     「错误区间只标到行尾」的要求。
   *
   * @param {number} lineNo
   * @param {{gutterMark:HTMLElement,row:HTMLElement}} els
   * @param {Array|undefined} ranges 该行的诊断
   */
  _applyDiagnosticMarks(lineNo, els, ranges) {
    // ---- 装订线 ----
    const mark = els.gutterMark;
    if (mark) {
      const want = !ranges || !ranges.length
        ? ''
        : (ranges.some((d) => d.severity === 'error') ? 'error' : 'warn');
      if (mark.dataset.sev !== want) {
        mark.dataset.sev = want;
        mark.className = want ? `gutter-mark gutter-mark-${want}` : 'gutter-mark';
      }
    }

    // ---- 行内波浪线 ----
    const row = els.row;
    if (!ranges || !ranges.length) {
      // 必须主动移除 overlay 容器：innerHTML 重绘只在 html 变化时发生，
      // 而修好一个错误后本行 html 可能完全没变（比如只改了一个字符），
      // 光靠重绘清不掉上一轮的波浪线，标记就会残留在正确代码上。
      const stale = row.querySelector('.diag-layer');
      if (stale) stale.remove();
      delete row.dataset.diag;
      return;
    }

    this._paintDiagnosticOverlay(lineNo, row, ranges);
  }

  /**
   * 画错误区间的波浪线。
   *
   * 用绝对定位的矩形块 + CSS wavy 边框，而不是给每个字符套 span：
   * 套 span 会打碎 renderLineHtml 已经拼好的 token 节点，
   * 而且 9000 行文件里每行套几十个 span 的分配开销不可接受。
   *
   * 几何一律来自 Range 实测（见 KERNEL 里的像素几何约定），
   * 不用「字宽 × 列号」推算 —— CJK 混排会漂移。
   */
  _paintDiagnosticOverlay(lineNo, row, ranges) {
    const text = this.model.getLineContent(lineNo);
    if (!text) return;

    // collectTextNodes 返回 {node, startCol, len}，是按行内字符累计的，
    // 正好可以直接用来把「列号」映射到具体文本节点。
    // 它走 TreeWalker 会扫到 .diag-layer 里的节点，但那个容器是纯定位的
    // 空 div（无文本子节点），不会污染累计列。
    const entries = collectTextNodes(row);
    if (!entries.length) return;

    // 复用已有的 overlay 容器
    let layer = row.querySelector('.diag-layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'diag-layer';
      row.appendChild(layer);
    }
    layer.textContent = '';

    const rowRect = row.getBoundingClientRect();
    for (const d of ranges) {
      const startCol = Math.max(0, Math.min(d.column - 1, text.length));
      const endCol = Math.max(startCol + 1, Math.min(startCol + (d.length || 1), text.length));
      const rects = this._rangeRects(entries, startCol, endCol);
      for (const r of rects) {
        const box = document.createElement('div');
        box.className = `diag-squiggle diag-${d.severity}`;
        box.style.left = `${r.left - rowRect.left}px`;
        box.style.width = `${Math.max(2, r.width)}px`;
        box.style.top = `${r.top - rowRect.top}px`;
        box.style.height = `${r.height}px`;
        box.title = d.message;
        layer.appendChild(box);
      }
    }
    if (!layer.childNodes.length) layer.remove();
  }

  /**
   * 把行内字符列区间映射成屏幕矩形。
   *
   * @param {Array<{node:Text,startCol:number,len:number}>} entries collectTextNodes 结果
   * @param {number} startCol 起始列（0-based，行内字符偏移）
   * @param {number} endCol 结束列（不含）
   * @returns {DOMRect[]}
   */
  _rangeRects(entries, startCol, endCol) {
    let startNode = null;
    let startOffset = 0;
    let endNode = null;
    let endOffset = 0;

    for (const e of entries) {
      if (startNode === null && startCol < e.startCol + e.len) {
        startNode = e.node;
        startOffset = startCol - e.startCol;
      }
      if (endCol <= e.startCol + e.len) {
        endNode = e.node;
        endOffset = endCol - e.startCol;
        break;
      }
    }
    if (!startNode || !endNode) return [];

    const range = document.createRange();
    try {
      range.setStart(startNode, Math.max(0, Math.min(startOffset, startNode.nodeValue.length)));
      range.setEnd(endNode, Math.max(0, Math.min(endOffset, endNode.nodeValue.length)));
    } catch {
      return [];
    }
    // Range 跨节点时会返回多个矩形，逐个画；跨行部分由 setEnd 天然截断
    return Array.from(range.getClientRects()).filter((r) => r.width > 0 || r.height > 0);
  }

  /* ---------------- 光标与选区 ---------------- */

  /**
   * 移动光标。
   *
   * @param {object} opts
   * @param {boolean} opts.keepAnchor 保留锚点以扩展选区（shift 方向键）
   * @param {boolean} opts.keepDesired 保留「理想列」。
   *   垂直移动必须传 true：否则经过短行时目标列被夹到行尾，
   *   这个被夹过的列又被写入 _desiredColumn，后续经过空行时列就永久塌成 1，
   *   表现为「上下移动后列号跑掉」「跨行选区的列逐行收缩」。
   */
  setCursor(line, column, { keepAnchor = false, keepDesired = false } = {}) {
    // 锚点只在按住 shift 扩展选区时建立；普通移动必须清空，
    // 否则会在 _cursor 更新前留下一个指向旧位置的零长度锚点，
    // 后续 insertText 会把「光标到旧位置」误当成选区删掉。
    if (keepAnchor) {
      if (!this._anchor) this._anchor = { ...this._cursor };
    } else {
      this._anchor = null;
    }
    this._cursor = {
      line: Math.max(1, Math.min(line, this._lineCount)),
      column: Math.max(1, column),
    };
    this._clampCursor();
    if (!keepDesired) this._desiredColumn = this._cursor.column;
    this._ensureVisible();
    // 括号配对高亮跟随光标：光标贴在某括号上时标出它的伙伴
    this._updateBracketHighlight();
    this._renderCursor();
    // 每次都同步：无选区时必须把上一轮的黄色标记清掉，
    // 否则点击空白处后原选中区域还留着高亮，看着像选区没清。
    this._syncFindHighlight(this._anchor ? this.selection : null);
    this._emit('cursor', this.cursor);
  }

  /**
   * 更新括号配对高亮。
   *
   * 只在光标紧邻括号时触发（光标左侧或右侧），与编辑器惯常行为一致。
   * 记录的行号变化时才重绘，避免每次移动都全量刷新。
   */
  _updateBracketHighlight() {
    const line = this.model.getLineContent(this._cursor.line);
    const col = this._cursor.column;
    const ch = line[col - 1] || line[col - 2] || '';

    const prev = this._bracketHighlight;
    if (!'()[]{}'.includes(ch)) {
      this._bracketHighlight = null;
      if (prev) {
        this._highlightCache.clear();
        this.renderVisible();
      }
      return;
    }

    const offset = this.model.positionToOffset(this._cursor.line, this._cursor.column);
    const match = findMatchingBracket(
      this.model.getValue(),
      offset,
      this.model.languageId,
      (o) => this.model.offsetToPosition(o),
    );

    const changed = (a, b) => {
      if (!a && !b) return false;
      if (!a || !b) return true;
      return a.line !== b.line || a.column !== b.column;
    };

    if (!match) {
      this._bracketHighlight = null;
      if (prev) {
        this._highlightCache.clear();
        this.renderVisible();
      }
      return;
    }

    // 记录为「行 → 该行需要描边的列」
    const byLine = new Map();
    const push = (pos) => {
      if (!byLine.has(pos.line)) byLine.set(pos.line, new Set());
      byLine.get(pos.line).add(pos.column);
    };
    push(match.open);
    push(match.close);

    const same = prev && prev.size === byLine.size &&
      Array.from(byLine.entries()).every(([k, v]) => {
        const p = prev.get(k);
        return p && p.size === v.size && Array.from(v).every((c) => p.has(c));
      });

    this._bracketHighlight = byLine;
    if (!same) {
      this._highlightCache.clear();
      this.renderVisible();
    }
  }

  /** 偏移处设置光标 */
  setCursorAtOffset(offset, opts) {
    const pos = this.model.offsetToPosition(offset);
    this.setCursor(pos.line, pos.column, opts);
  }

  clearSelection() {
    this._anchor = null;
    this._renderCursor();
    this.clearFindHighlight();
  }

  _clampCursor() {
    const maxLine = Math.max(1, this._lineCount);
    if (this._cursor.line > maxLine) this._cursor.line = maxLine;
    const len = this.model.getLineContent(this._cursor.line).length;
    if (this._cursor.column > len + 1) this._cursor.column = len + 1;
    if (this._anchor) {
      this._anchor.line = Math.min(this._anchor.line, maxLine);
      const alen = this.model.getLineContent(this._anchor.line).length;
      if (this._anchor.column > alen + 1) this._anchor.column = alen + 1;
    }
  }

  /**
   * 取某行已渲染的行元素与它的文本节点表。
   * 定位必须基于真实 DOM：只有浏览器知道 CJK、粗体、字体回退的实际宽度。
   */
  _rowContext(lineNumber) {
    const els = this._lineEls.get(lineNumber);
    if (!els) return null;
    // 以「已渲染的 html」作为缓存键：文本相同但 token 结构变化时，
    // 文本节点集合也可能不同，用 html 判断最稳。
    const key = els.rendered;
    if (!els.textNodes || els.textKey !== key) {
      els.textNodes = collectTextNodes(els.row);
      els.textKey = key;
    }
    return { row: els.row, nodes: els.textNodes };
  }

  /**
   * 某行某列的像素 x（相对 .editor-content 左边缘）。
   *
   * 注意 Range 实测返回的是「相对行元素左边缘」的距离，而行元素的
   * padding-left 已经保证文字从 PAD_LEFT 处开始，所以那个结果里
   * 已经包含 PAD_LEFT，不能再加一次（否则整体右移一个 padding 宽度）。
   */
  _columnToX(lineNumber, column) {
    const ctx = this._rowContext(lineNumber);
    if (ctx && ctx.nodes.length) {
      // Range 实测：已含行元素的 padding-left
      return this._metrics.columnToX(ctx.row, column, ctx.nodes);
    }
    const text = this.model.getLineContent(lineNumber);
    // 空行没有文本节点，任何列都落在文字起点
    if (!text.length) return PAD_LEFT;
    // 行未渲染（视口外）：退化为估算，需要自行补上 PAD_LEFT
    return PAD_LEFT + this._estimateColumnX(text, column);
  }

  /** 行未渲染时的估算：canvas 逐字符累加 */
  _estimateColumnX(text, column) {
    const upto = text.substring(0, Math.max(0, Math.min(column - 1, text.length)));
    return this._metrics.lineWidth(upto);
  }

  _cursorPixel() {
    const line = this._cursor.line;
    const top = PAD_TOP + (line - 1) * this._lh;
    const left = this._columnToX(line, this._cursor.column);
    return { top, left };
  }

  _renderCursor() {
    const { top, left } = this._cursorPixel();

    this._renderSelection();

    this.caretEl.style.top = `${top}px`;
    this.caretEl.style.left = `${left}px`;
    this.caretEl.style.height = `${this._lh}px`;
  }

  /**
   * 选区渲染：按视觉行拆成多条矩形。
   *
   * 跨行选区不能用一个矩形盖住首行到末行 —— 那样首行左边、末行右边的
   * 未选中文字也会被涂上，看起来就是「选区不在同一行」。
   * 正确做法是每行一条：首行从起点到行尾，中间行整行，末行从行首到终点。
   */
  _renderSelection() {
    const sel = this._anchor ? this.selection : null;
    const pool = this._selRectPool || (this._selRectPool = []);

    if (!sel) {
      // 只隐藏，不能清 innerHTML：节点一旦脱离文档，池子里持有的引用
      // 就失效了，之后再复用会得到不可见的孤儿节点。
      this.selEl.hidden = true;
      for (const node of pool) node.hidden = true;
      return;
    }

    const rects = [];
    const contentWidth = Math.max(0, this.content.clientWidth);

    if (sel.start.line === sel.end.line) {
      const left = this._columnToX(sel.start.line, sel.start.column);
      const right = this._columnToX(sel.end.line, sel.end.column);
      rects.push({ top: sel.start.line, left, width: Math.max(2, right - left) });
    } else {
      // 首行：起点 → 行尾
      const startLeft = this._columnToX(sel.start.line, sel.start.column);
      rects.push({ top: sel.start.line, left: startLeft, width: Math.max(2, contentWidth - startLeft) });

      // 中间行：整行。行数可能上万，只为视口内的行生成矩形
      const viewTop = this.scroller.scrollTop;
      const viewBottom = viewTop + (this.scroller.clientHeight || 600);
      const midFirst = sel.start.line + 1;
      const midLast = sel.end.line - 1;
      for (let ln = midFirst; ln <= midLast; ln++) {
        const y = PAD_TOP + (ln - 1) * this._lh;
        if (y + this._lh < viewTop || y > viewBottom) continue;
        rects.push({ top: ln, left: PAD_LEFT, width: Math.max(2, contentWidth - PAD_LEFT) });
      }

      // 末行：行首 → 终点
      const endLeft = this._columnToX(sel.end.line, sel.end.column);
      rects.push({ top: sel.end.line, left: PAD_LEFT, width: Math.max(2, endLeft - PAD_LEFT) });
    }

    // 复用已存在的矩形节点，避免每次拖拽都重建 DOM
    while (pool.length < rects.length) {
      const div = document.createElement('div');
      div.className = 'editor-sel-rect';
      this.selEl.appendChild(div);
      pool.push(div);
    }

    for (let i = 0; i < pool.length; i++) {
      const node = pool[i];
      if (i >= rects.length) {
        node.hidden = true;
        continue;
      }
      const r = rects[i];
      node.hidden = false;
      node.style.top = `${PAD_TOP + (r.top - 1) * this._lh}px`;
      node.style.left = `${r.left}px`;
      node.style.width = `${r.width}px`;
      node.style.height = `${this._lh}px`;
    }

    this.selEl.hidden = false;
  }

  /** 保证光标在可视区内（纵向 + 横向） */
  _ensureVisible() {
    const sc = this.scroller;
    const viewportH = sc.clientHeight || 600;
    const viewportW = (sc.clientWidth || 700) - GUTTER_WIDTH;

    const top = PAD_TOP + (this._cursor.line - 1) * this._lh;
    if (top - PAD_TOP < sc.scrollTop) {
      sc.scrollTop = Math.max(0, top - PAD_TOP - this._lh * 2);
    } else if (top + this._lh > sc.scrollTop + viewportH) {
      sc.scrollTop = top + this._lh - viewportH + this._lh * 2;
    }

    // 横向：长行时让光标跟着走进视野
    const { left } = this._cursorPixel();
    const pad = this._metrics.charWidth('M') * 6;
    if (left < sc.scrollLeft + pad) {
      sc.scrollLeft = Math.max(0, left - pad);
    } else if (left > sc.scrollLeft + viewportW - pad) {
      sc.scrollLeft = left - viewportW + pad;
    }
  }

  /**
   * 像素 → 行列（命中测试）。
   *
   * 横向基准必须取 .editor-content 的矩形，而不是滚动容器：
   * 内容区左侧有 GUTTER_WIDTH 的固定行号栏，且横向滚动会改变内容的
   * 视觉位置。用 getBoundingClientRect 直接量内容区，这两个因素
   * 都被浏览器算进去了，不需要手工加减。
   */
  _hitTest(clientX, clientY) {
    const contentRect = this.content.getBoundingClientRect();
    const scrollerRect = this.scroller.getBoundingClientRect();

    const x = clientX - contentRect.left;
    const y = clientY - scrollerRect.top + this.scroller.scrollTop;

    // 行用 floor：一行占 [top, top+20)，落在这段里任意位置都属于该行。
    // 用 round 会让正好落在半行处的点击判给下一行。
    let line = Math.floor((y - PAD_TOP) / this._lh) + 1;
    line = Math.max(1, Math.min(line, this._lineCount));

    // 列：对已渲染的行做 Range 二分精测；未渲染则退化为估算。
    // 传入的 x 是「相对行元素左边缘」的距离，与 Range 实测结果同一基准，
    // 不能再减 PAD_LEFT（行元素的 padding 已体现在实测值里）。
    const text = this.model.getLineContent(line);
    const maxCol = text.length + 1;
    const ctx = this._rowContext(line);
    const col = ctx
      ? this._metrics.xToColumn(ctx.row, x, ctx.nodes)
      : this._estimateColumnFromX(text, x - PAD_LEFT);
    return { line, column: Math.max(1, Math.min(col, maxCol)) };
  }

  /** 行未渲染时的列估算：逐字符累加宽度，找最近边界 */
  _estimateColumnFromX(text, x) {
    if (x <= 0) return 1;
    let acc = 0;
    let best = 1;
    let bestDelta = Math.abs(x);
    const tabStop = this._metrics.charWidth(' ') * this._metrics.tabSize;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '\t') acc = (Math.floor(acc / tabStop) + 1) * tabStop;
      else acc += this._metrics.charWidth(ch);
      const delta = Math.abs(x - acc);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = i + 2;
      }
    }
    return best;
  }

  _onMouseDown(e) {
    if (e.button !== 0) return;
    this.input.focus({ preventScroll: true });
    const pos = this._hitTest(e.clientX, e.clientY);

    if (e.shiftKey) {
      this.setCursor(pos.line, pos.column, { keepAnchor: true });
      return;
    }

    // 双击选词：按语言的 wordPattern 取整词，对应 getWordAtPosition
    if (e.detail === 2) {
      const line = this.model.getLineContent(pos.line);
      const word = getWordAtPosition(line, pos.column, this.model.languageId);
      if (word) {
        this.setCursor(pos.line, word.endColumn);
        this._anchor = { line: pos.line, column: word.startColumn };
        this._renderCursor();
        this._syncFindHighlight(this.selection);
        this._emit('cursor', this.cursor);
        e.preventDefault();
        return;
      }
    }

    this.setCursor(pos.line, pos.column);
    this._renderCursor();

    // 拖拽选取：按下那一刻的位置才是锚点，不能用移动后的光标
    const dragAnchor = { line: pos.line, column: pos.column };
    let dragging = false;
    const onMove = (ev) => {
      const p = this._hitTest(ev.clientX, ev.clientY);
      if (!dragging) {
        if (p.line === dragAnchor.line && p.column === dragAnchor.column) return;
        dragging = true;
        this._anchor = { ...dragAnchor };
      }
      this._cursor = p;
      this._clampCursor();
      this._renderCursor();
      this._emit('cursor', this.cursor);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (this._anchor && this.selection === null) this._anchor = null;
      this._renderCursor();
      // 拖完才重算查找高亮：拖拽过程中每次移动都全文扫描会明显卡顿，
      // 而中间态的选区文本本来也没有参考价值。
      this._syncFindHighlight(this.selection);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    // 先阻止默认行为（避免原生选区闪烁），再显式把焦点交给输入代理。
    // 顺序很重要：preventDefault 会取消浏览器的默认焦点转移，
    // 若在此之前 focus，某些浏览器会在 preventDefault 后把焦点收回去，
    // 结果就是"点进去了但打不了字"。
    e.preventDefault();
    this.input.focus({ preventScroll: true });
  }

  /* ---------------- 编辑 ---------------- */

  /**
   * 插入文本。涵盖 Trae 的几类输入行为：
   *   1. 有选区时按 surroundingPairs 包裹（如选中后按 `( ` → 加括号）
   *   2. 无选区且命中 autoClosingPairs → 自动补闭合符并把光标放中间
   *   3. 光标右侧正好是同一闭合符 → 跳过不重复插入
   *   4. 其余情形按普通文本插入
   */
  insertText(text) {
    const sel = this.selection;
    const languageId = this.model.languageId;

    // 1. 选区包裹
    if (sel && text.length === 1) {
      const wrap = getSurroundingPair(text, languageId);
      if (wrap) {
        this._wrapSelection(sel, wrap.open, wrap.close);
        return;
      }
    }

    // 2/3. 单字符才考虑自动闭合
    if (!sel && text.length === 1) {
      const line = this.model.getLineContent(this._cursor.line);
      const col = this._cursor.column;

      // 3. 光标右侧已是该闭合符 → 只移动光标
      if (isClosingChar(text, languageId) && line[col - 1] === text) {
        this._cursor = { line: this._cursor.line, column: col + 1 };
        this._renderCursor();
        this._emit('cursor', this.cursor);
        return;
      }

      // 2. 自动补闭合
      const pair = getAutoClosePair(text, languageId, line, col);
      if (pair) {
        this._insertRaw(pair.open + pair.close, 1); // 光标落在两者之间
        return;
      }
    }

    this._insertRaw(text, text.length);
  }

  /** 用一对字符包裹选区 */
  _wrapSelection(sel, open, close) {
    const a = this.model.positionToOffset(sel.start.line, sel.start.column);
    const b = this.model.positionToOffset(sel.end.line, sel.end.column);
    const inner = this.model.getValue().substring(a, b);

    this._anchor = null;
    this.model.edit(a, b - a, open + inner + close);

    // 保持原内容被选中，便于连续操作
    const newStart = this.model.offsetToPosition(a + open.length);
    const newEnd = this.model.offsetToPosition(a + open.length + inner.length);
    this._cursor = newEnd;
    this._anchor = newStart;
    this._renderCursor();
    this._syncFindHighlight(this.selection);
    this._emit('cursor', this.cursor);
  }

  /**
   * 原始插入，不参与任何自动行为。
   * @param {string} text
   * @param {number} caretFromStart 插入后光标相对插入文本起点的偏移
   */
  _insertRaw(text, caretFromStart) {
    const offset = this._selectionOrCursorOffset();
    const sel = this.selection;
    const del = sel
      ? this.model.positionToOffset(sel.end.line, sel.end.column) -
        this.model.positionToOffset(sel.start.line, sel.start.column)
      : 0;
    const base = sel ? this.model.positionToOffset(sel.start.line, sel.start.column) : offset;

    // 替换选区会清空选区，但用户意图是"继续用这个词查找"，
    // 所以记下当时的查找词，编辑完按新内容重扫一次。
    const keptWord = sel ? this._findWord : '';

    this._anchor = null;
    this.model.edit(base, del, text);

    const pos = this.model.offsetToPosition(base + caretFromStart);
    this._cursor = pos;
    this._clampCursor();
    this._ensureVisible();
    this._renderCursor();

    // 替换选区后恢复了原始查找词：高亮继续跟着同一个词，只按新内容更新数量
    if (keptWord && keptWord !== this._findWord) {
      this._findWord = keptWord;
      this.updateFindHighlight(keptWord);
    }

    // 粘贴/自动闭合等多字符插入：收掉旧列表，避免列表和实际文本脱节。
    // 单字符的补全刷新由 _afterInputEdit 统一负责，这里不重复触发。
    if (text.length !== 1 && this.suggest.isVisible) {
      this.suggest.hide();
    }

    this._emit('cursor', this.cursor);
  }

  /**
   * 回车：按语言配置自动缩进。
   * Trae 用 indentationRules 的 increase/decreaseIndentPattern 决定层级，
   * onEnterRules 处理注释续行（如 JSON 的 // 后回车补 //）。
   */
  insertNewline() {
    const line = this.model.getLineContent(this._cursor.line);
    const col = this._cursor.column;
    const beforeCursor = line.substring(0, col - 1);
    const afterCursor = line.substring(col - 1);

    const { indent, extraText } = getEnterAction(
      beforeCursor,
      afterCursor,
      this.model.languageId,
      this._tabSize,
    );

    this._insertRaw('\n' + indent + extraText, 1 + indent.length + extraText.length);
  }

  _selectionOrCursorOffset() {
    return this.model.positionToOffset(this._cursor.line, this._cursor.column);
  }

  /** 删除选区，或按方向删除 */
  deleteSelection() {
    const sel = this.selection;
    if (!sel) return false;
    const a = this.model.positionToOffset(sel.start.line, sel.start.column);
    const b = this.model.positionToOffset(sel.end.line, sel.end.column);
    this._anchor = null;
    this.model.edit(a, b - a, '');
    this._cursor = this.model.offsetToPosition(a);
    this._clampCursor();
    this._renderCursor();
    this._emit('cursor', this.cursor);
    return true;
  }

  backspace() {
    if (this.deleteSelection()) return;
    const offset = this._selectionOrCursorOffset();
    if (offset === 0) return;
    const text = this.model.getValue();
    let del = 1;
    let from = offset - 1;
    // 处理 \r\n
    if (text.charCodeAt(offset - 1) === 10 && text.charCodeAt(offset - 2) === 13) {
      del = 2;
      from = offset - 2;
    }

    // 成对删除：光标停在 "()" / '""' 之间时一次删掉两侧，
    // 与 Trae 的 isAutoClosingPairDelete 一致。
    if (del === 1 && offset < text.length) {
      const chBefore = text[offset - 1];
      const chAfter = text[offset];
      if (shouldDeletePair(chBefore, chAfter, this.model.languageId)) {
        del = 2;
        from = offset - 1;
      }
    }

    this.model.edit(from, del, '');
    this._cursor = this.model.offsetToPosition(from);
    this._clampCursor();
    this._ensureVisible();
    this._renderCursor();
    this._emit('cursor', this.cursor);
  }

  deleteForward() {
    if (this.deleteSelection()) return;
    const offset = this._selectionOrCursorOffset();
    const text = this.model.getValue();
    if (offset >= text.length) return;
    let del = 1;
    if (text.charCodeAt(offset) === 13 && text.charCodeAt(offset + 1) === 10) del = 2;
    this.model.edit(offset, del, '');
    this._cursor = this.model.offsetToPosition(offset);
    this._clampCursor();
    this._renderCursor();
    this._emit('cursor', this.cursor);
  }

  /* ---------------- 键盘 ---------------- */

  _onKeyDown(e) {
    const mod = e.ctrlKey || e.metaKey;
    const sel = this.selection;

    // 输入法组合中不拦截
    if (e.isComposing) return;

    // 补全浮层打开时优先处理导航键
    if (this.suggest.isVisible) {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          this.suggest.move(1);
          return;
        case 'ArrowUp':
          e.preventDefault();
          this.suggest.move(-1);
          return;
        case 'PageDown':
          e.preventDefault();
          this.suggest.movePage(1);
          return;
        case 'PageUp':
          e.preventDefault();
          this.suggest.movePage(-1);
          return;
        case 'Enter':
        case 'Tab': {
          const item = this.suggest.active;
          if (item) {
            e.preventDefault();
            this._acceptCompletion(item);
            return;
          }
          break;
        }
        case 'Escape':
          e.preventDefault();
          this.suggest.hide();
          return;
        case 'Backspace':
        case 'Delete':
        case 'Enter':
        case 'Tab':
          if (e.key === 'Enter' || e.key === 'Tab') break; // 上面已处理：有候选项则接受
          // 浮层开着时的删除键必须在这里拦下并走模型。
          // 否则浏览器会对 textarea 执行默认删除，_onInputFallback 会把
          // “textarea 相对当前行的差异”当成新输入合进模型，文字直接错乱。
          e.preventDefault();
          this._handledByBeforeInput = false;
          if (e.key === 'Backspace') this.backspace();
          else this.deleteForward();
          this._afterInputEdit();
          return;
        default:
          break;
      }
    }

    // Ctrl+Space 手动触发补全
    if (mod && e.key === ' ') {
      e.preventDefault();
      this.triggerSuggest();
      return;
    }

    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault();
        if (sel && !e.shiftKey) {
          this.setCursor(sel.start.line, sel.start.column);
          this._anchor = null;
          this._renderCursor();
        } else {
          this._moveHorizontal(-1, e.shiftKey);
        }
        return;
      case 'ArrowRight':
        e.preventDefault();
        if (sel && !e.shiftKey) {
          this.setCursor(sel.end.line, sel.end.column);
          this._anchor = null;
          this._renderCursor();
        } else {
          this._moveHorizontal(1, e.shiftKey);
        }
        return;
      case 'ArrowUp':
        e.preventDefault();
        this._moveVertical(-1, e.shiftKey);
        return;
      case 'ArrowDown':
        e.preventDefault();
        this._moveVertical(1, e.shiftKey);
        return;
      case 'Home':
        e.preventDefault();
        this.setCursor(this._cursor.line, 1, { keepAnchor: e.shiftKey });
        return;
      case 'End':
        e.preventDefault();
        this.setCursor(this._cursor.line, this.model.getLineContent(this._cursor.line).length + 1, {
          keepAnchor: e.shiftKey,
        });
        return;
      case 'PageUp':
        e.preventDefault();
        this._moveVertical(-Math.floor((this.scroller.clientHeight || 600) / this._lh), e.shiftKey);
        return;
      case 'PageDown':
        e.preventDefault();
        this._moveVertical(Math.floor((this.scroller.clientHeight || 600) / this._lh), e.shiftKey);
        return;
      case 'Backspace':
        e.preventDefault();
        this._handledByBeforeInput = false;
        this.backspace();
        this._afterInputEdit();
        return;
      case 'Delete':
        e.preventDefault();
        this._handledByBeforeInput = false;
        this.deleteForward();
        this._afterInputEdit();
        return;
      case 'Enter':
        e.preventDefault();
        this._handledByBeforeInput = false;
        this.insertNewline();
        this._afterInputEdit();
        return;
      case 'Tab':
        e.preventDefault();
        this._handledByBeforeInput = false;
        this.insertText(' '.repeat(this._tabSize));
        this._afterInputEdit();
        return;
      case 'Escape':
        this._anchor = null;
        this._renderCursor();
        this.clearFindHighlight();
        return;
      default:
        break;
    }

    if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (this.model.undo()) this.afterEdit();
      return;
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (this.model.redo()) this.afterEdit();
      return;
    }
    // 复制 / 剪切：因为禁用了原生选区，这里直接按自绘选区取文本
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'c') {
      if (this.selection) {
        e.preventDefault();
        this._writeClipboard(this.selectedText());
        this._emit('copy', null);
      }
      return;
    }
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'x') {
      if (this.selection) {
        e.preventDefault();
        this._writeClipboard(this.selectedText());
        this.deleteSelection();
        this.afterEdit();
      }
      return;
    }
    // Ctrl+D：选中下一个相同词。Trae 走的是 addSelectionToNextFindMatch，
    // 这里只维护一个活动选区（无多光标），但"选中下一个相同词并滚到可见"
    // 的行为一致。
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      this.selectNextOccurrence();
      return;
    }
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      this._anchor = { line: 1, column: 1 };
      const lastLine = this.model.getLineCount();
      this._cursor = { line: lastLine, column: this.model.getLineContent(lastLine).length + 1 };
      this._renderCursor();
      this._emit('cursor', this.cursor);
      return;
    }
  }

  /** 当前自绘选区对应的纯文本 */
  selectedText() {
    const sel = this.selection;
    if (!sel) return '';
    const a = this.model.positionToOffset(sel.start.line, sel.start.column);
    const b = this.model.positionToOffset(sel.end.line, sel.end.column);
    return this.model.getValue().substring(a, b);
  }

  /** 写系统剪贴板。优先异步 API，失败时退回 execCommand */
  async _writeClipboard(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* 权限或上下文限制，走兜底 */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  /**
   * 模型变更后的收尾。
   *
   * 不再重复调用 renderVisible：model.onChange 已经在编辑后完成重绘，
   * 这里只需保证光标可见并刷新光标/选区层。重复全量渲染会让一次按键
   * 花掉两倍时间，大文件下会明显掉帧。
   */
  afterEdit() {
    this._ensureVisible();
    this._renderCursor();
    this._emit('cursor', this.cursor);
    // 诊断防抖重启。放在这里而不是 renderVisible 里：
    // 渲染是热路径（滚动每帧都跑），诊断必须只在内容变化后跑。
    this._scheduleDiagnostics();
  }

  /* ---------------- 诊断 ---------------- */

  /**
   * 防抖调度诊断。
   *
   * 全量诊断在 9000 行文件上是一次 O(n) 扫描，同步跑会直接掉帧
   * （性能基线 3.4ms/键）。这里延迟 300ms，用户停手才跑。
   */
  _scheduleDiagnostics() {
    if (this._diagTimer) clearTimeout(this._diagTimer);
    this._diagTimer = setTimeout(() => {
      this._diagTimer = null;
      this._runDiagnostics();
    }, DIAG_DEBOUNCE);
  }

  /** 立即跑一次诊断（打开文件、切语言时用，不等防抖） */
  runDiagnosticsNow() {
    if (this._diagTimer) {
      clearTimeout(this._diagTimer);
      this._diagTimer = null;
    }
    this._runDiagnostics();
  }

  /** 实际执行诊断并应用结果 */
  _runDiagnostics() {
    if (!this.model) return;
    // 未改动就复用上次结果：滚动、光标移动不该触发重算
    if (this._diagVersion === this.model.version) return;

    const text = this.model.getValue();
    const languageId = this.model.languageId;
    const list = collectDiagnostics(text, languageId);

    this._diagList = list;
    this._diagByLine = groupDiagnosticsByLine(list);
    this._diagCounts = countDiagnostics(list);
    this._diagVersion = this.model.version;
    this._diagRevision++;

    // 诊断变了：行缓存整体失效（波浪线与装订线都挂在行上）
    this._highlightCache.clear();
    this.renderVisible();
    this._emit('diagnostics', this.diagnostics);
  }

  /** 清除诊断（切换文件、关闭时用，避免旧标记残留） */
  clearDiagnostics() {
    if (this._diagTimer) {
      clearTimeout(this._diagTimer);
      this._diagTimer = null;
    }
    const had = this._diagList.length > 0;
    this._diagList = [];
    this._diagByLine = null;
    this._diagCounts = { errors: 0, warnings: 0, total: 0 };
    this._diagVersion = -1;
    if (had) {
      this._diagRevision++;
      this._highlightCache.clear();
      this.renderVisible();
      this._emit('diagnostics', this.diagnostics);
    } else {
      this._emit('diagnostics', this.diagnostics);
    }
  }

  /** 当前诊断快照 */
  get diagnostics() {
    return {
      items: this._diagList,
      ...this._diagCounts,
    };
  }

  /**
   * 销毁视图：清掉所有悬挂的定时器与监听。
   *
   * openText 会重建视图，旧实例若只置 null，防抖定时器仍会在
   * 300ms 后触发一次全量诊断，对着已脱离文档的 DOM 干活。
   */
  destroy() {
    if (this._diagTimer) {
      clearTimeout(this._diagTimer);
      this._diagTimer = null;
    }
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    this._listeners = { cursor: new Set(), content: new Set(), diagnostics: new Set() };
    this._lineEls.clear();
    this._highlightCache.clear();
    this._diagByLine = null;
    this._diagList = [];
    this._diagCounts = { errors: 0, warnings: 0, total: 0 };
    this._diagVersion = -1;
  }

  /**
   * 跳到下一个诊断位置。
   *
   * 语义对齐 VS Code 的「转到下一个问题」：从当前光标往后找，
   * 到末尾则回绕到第一个。找不到返回 false。
   */
  goToNextDiagnostic() {
    if (!this._diagList.length) return false;
    const cur = this._cursor;
    const curOff = this.model.positionToOffset(cur.line, cur.column);

    for (const d of this._diagList) {
      const off = this.model.positionToOffset(d.line, d.column);
      if (off > curOff) {
        this.setCursor(d.line, d.column);
        return true;
      }
    }
    // 回绕
    const first = this._diagList[0];
    this.setCursor(first.line, first.column);
    return true;
  }

  _moveHorizontal(delta, extend) {
    const offset = this._selectionOrCursorOffset();
    const next = Math.max(0, Math.min(offset + delta, this.model.length));
    this.setCursorAtOffset(next, { keepAnchor: extend });
    this._renderCursor();
  }

  _moveVertical(delta, extend) {
    const targetLine = Math.max(1, Math.min(this._cursor.line + delta, this._lineCount));
    // 用「理想列」定位，但不要把夹过的值写回理想列 —— 传 keepDesired
    const col = Math.min(this._desiredColumn, this.model.getLineContent(targetLine).length + 1);
    this.setCursor(targetLine, col, { keepAnchor: extend, keepDesired: true });
    this._renderCursor();
  }

  /**
   * 编辑后的统一收尾：同步输入代理 → 重绘 → 刷新补全。
   *
   * 补全必须在这里统一刷新，而不是只在插入字符时触发 ——
   * 退格、删除同样会改变前缀，漏掉就会出现「删了字母但补全还是旧列表」。
   */
  _afterInputEdit() {
    this._syncInputValue();
    this.afterEdit();
    this.triggerSuggest();
  }

  _onBeforeInput(e) {
    if (this._composing) return;

    // 纯文本输入：拦截并把文本插进模型，绕开 textarea 的默认行为
    if (e.inputType === 'insertText' && e.data) {
      e.preventDefault();
      this._handledByBeforeInput = true;
      this.insertText(e.data);
      this._afterInputEdit();
    } else if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') {
      e.preventDefault();
      this._handledByBeforeInput = true;
      this.insertNewline();
      this._afterInputEdit();
    } else if (e.inputType === 'deleteContentBackward') {
      e.preventDefault();
      this._handledByBeforeInput = true;
      this.backspace();
      this._afterInputEdit();
    } else if (e.inputType === 'deleteContentForward') {
      e.preventDefault();
      this._handledByBeforeInput = true;
      this.deleteForward();
      this._afterInputEdit();
    } else if (e.inputType === 'deleteWordBackward') {
      e.preventDefault();
      this._handledByBeforeInput = true;
      this._deleteWord(-1);
      this._afterInputEdit();
    } else if (e.inputType === 'deleteWordForward') {
      e.preventDefault();
      this._handledByBeforeInput = true;
      this._deleteWord(1);
      this._afterInputEdit();
    }
  }

  /** 按词删除（Ctrl+Backspace / Ctrl+Delete） */
  _deleteWord(direction) {
    if (this.deleteSelection()) return;
    const line = this.model.getLineContent(this._cursor.line);
    const col = this._cursor.column;

    if (direction < 0) {
      // 向前删到词首
      let k = col - 1;
      while (k > 0 && /\s/.test(line[k - 1])) k--;
      while (k > 0 && !/[\s.()[\]{},'"`;:]/.test(line[k - 1])) k--;
      if (k < col - 1) {
        const from = this.model.positionToOffset(this._cursor.line, k + 1);
        const to = this.model.positionToOffset(this._cursor.line, col);
        this.model.edit(from, to - from, '');
        this._cursor = this.model.offsetToPosition(from);
        this._clampCursor();
        this._renderCursor();
      } else if (col > 1) {
        this.backspace();
      }
      return;
    }

    // 向后删到词尾
    let k = col - 1;
    while (k < line.length && /\s/.test(line[k])) k++;
    while (k < line.length && !/[\s.()[\]{},'"`;:]/.test(line[k])) k++;
    if (k > col - 1) {
      const from = this.model.positionToOffset(this._cursor.line, col);
      const to = this.model.positionToOffset(this._cursor.line, k + 1);
      this.model.edit(from, to - from, '');
      this._cursor = this.model.offsetToPosition(from);
      this._clampCursor();
      this._renderCursor();
    } else {
      this.deleteForward();
    }
  }

  /* ---------------- 剪贴板 ---------------- */

  _onCopy(e) {
    const sel = this.selection;
    if (!sel) return;
    const a = this.model.positionToOffset(sel.start.line, sel.start.column);
    const b = this.model.positionToOffset(sel.end.line, sel.end.column);
    e.clipboardData.setData('text/plain', this.model.getValue().substring(a, b));
    e.preventDefault();
  }

  _onCut(e) {
    const sel = this.selection;
    if (!sel) return;
    const a = this.model.positionToOffset(sel.start.line, sel.start.column);
    const b = this.model.positionToOffset(sel.end.line, sel.end.column);
    e.clipboardData.setData('text/plain', this.model.getValue().substring(a, b));
    e.preventDefault();
    this.deleteSelection();
    this.afterEdit();
  }

  _onPaste(e) {
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    // 粘贴的多行文本统一成 \n，避免混入 \r
    this.insertText(text.replace(/\r\n?/g, '\n'));
    this.afterEdit();
  }

  focus() {
    // 焦点必须落在隐藏 textarea 上，它是唯一能接入键盘输入的节点
    this.input.focus({ preventScroll: true });
    this._syncInputValue();
    // 同步光标可见性：某些浏览器 focus 事件在微任务后才派发
    this.root.classList.toggle('focused', document.activeElement === this.input);
  }

  /** 滚动到指定行（预览点跳转） */
  revealLine(line) {
    const top = PAD_TOP + (line - 1) * this._lh;
    this.scroller.scrollTop = Math.max(0, top - (this.scroller.clientHeight || 600) / 2);
    this.setCursor(line, 1);
    this.focus();
  }
}

/** 度量常量。字符宽度是等宽字体下的典型值，实际以实例的 _cw 为准。 */
export const METRICS = { ROW_HEIGHT, PAD_TOP, PAD_LEFT };
