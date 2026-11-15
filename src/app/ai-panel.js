/**
 * AI 选区改写：指令输入 + diff 预览 + 应用/放弃。
 *
 * 交互路径（对齐 Cursor 的 Ctrl+K）：
 *   1. 选中一段代码，按 Ctrl+K
 *   2. 浮层里写要求，Enter 发送
 *   3. 右侧/下方弹出逐行 diff，Enter 或点「应用」替换选区，Esc 放弃
 *
 * 关键约束：
 *   - 应用走 model.edit()，因此天然进入撤销栈，Ctrl+Z 一步回退
 *   - 替换范围就是发起时的选区，期间内容变了就作废（版本校验），
 *     否则会把一段不相干的文本覆盖掉
 *   - diff 是自己算的行级对比，不引第三方库（保持零依赖）
 */

import { aiRewrite } from './api.js';
import { diffLines, diffStats, onlyTrailingBlankChange } from './line-diff.js';

export { diffLines, diffStats, onlyTrailingBlankChange };

export class AiRewritePanel {
  /**
   * @param {HTMLElement} root 挂载点（通常是 body）
   * @param {object} opts
   * @param {() => object} opts.getSettings 取当前设置
   * @param {() => number} [opts.getVersion] 取当前 model.version，用于失效判定
   * @param {(offset:number, deleteCount:number) => (string|undefined)} [opts.getSlice]
   *   取当前文档在目标区间上的文本，用于二次失效判定
   * @param {(text:string, offset:number, deleteCount:number) => void} opts.applyEdit
   * @param {(msg:string, kind?:string) => void} opts.notify 状态栏提示
   */
  constructor(root, opts) {
    this.root = root;
    this.opts = opts;
    this.mode = 'idle'; // 'input' | 'preview'
    this._ctx = null; // 发起时的快照：{offset, deleteCount, original, version, language}
    this._result = null;
    this._busy = false;

    this._build();
    this._bind();
  }

  _build() {
    const el = document.createElement('div');
    el.className = 'ai-overlay';
    el.hidden = true;
    el.innerHTML = `
      <div class="ai-card" role="dialog" aria-label="AI 改写">
        <div class="ai-head">
          <span class="ai-title">AI 改写</span>
          <span class="ai-meta"></span>
          <button class="ai-close" type="button" title="关闭 (Esc)">✕</button>
        </div>
        <div class="ai-body">
          <div class="ai-input-row">
            <input class="ai-input" type="text" placeholder="描述要改成什么样，Enter 发送" />
            <button class="ai-send btn" type="button">发送</button>
          </div>
          <div class="ai-hint">只改写选中的部分；结果先看 diff，不会直接落盘</div>
          <div class="ai-diff" hidden></div>
          <div class="ai-error" hidden></div>
        </div>
        <div class="ai-foot">
          <button class="ai-apply btn primary" type="button" hidden>应用 (Enter)</button>
          <button class="ai-discard btn" type="button" hidden>放弃 (Esc)</button>
          <span class="ai-usage"></span>
        </div>
      </div>
    `;
    this.root.appendChild(el);

    this.el = el;
    this.card = el.querySelector('.ai-card');
    this.input = el.querySelector('.ai-input');
    this.sendBtn = el.querySelector('.ai-send');
    this.diffEl = el.querySelector('.ai-diff');
    this.errorEl = el.querySelector('.ai-error');
    this.applyBtn = el.querySelector('.ai-apply');
    this.discardBtn = el.querySelector('.ai-discard');
    this.metaEl = el.querySelector('.ai-meta');
    this.usageEl = el.querySelector('.ai-usage');
    this.hintEl = el.querySelector('.ai-hint');
  }

  _bind() {
    this.el.querySelector('.ai-close').addEventListener('click', () => this.close());
    this.discardBtn.addEventListener('click', () => this.close());
    this.applyBtn.addEventListener('click', () => this.apply());
    this.sendBtn.addEventListener('click', () => this.submit());

    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        this.submit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
      e.stopPropagation(); // 别让编辑器的全局快捷键接手
    });

    // 点击遮罩关闭；卡片内点击不关
    this.el.addEventListener('mousedown', (e) => {
      if (e.target === this.el) this.close();
    });

    document.addEventListener('keydown', (e) => {
      if (this.el.hidden) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      } else if (e.key === 'Enter' && this.mode === 'preview' && !this._busy) {
        // 预览态下 Enter = 应用，除非焦点在输入框（那里 Enter 是重新发送）
        if (document.activeElement === this.input) return;
        e.preventDefault();
        this.apply();
      }
    });
  }

  get isOpen() {
    return !this.el.hidden;
  }

  /**
   * 打开改写面板。
   *
   * @param {object} ctx
   * @param {string} ctx.selected 选中的原文
   * @param {number} ctx.offset 选区在全文中的起始偏移
   * @param {number} ctx.deleteCount 选区长度
   * @param {number} ctx.version 发起时的 model.version，用于防止错位覆盖
   * @param {string} ctx.language 语言 id
   * @param {string} ctx.contextBefore 前文
   * @param {string} ctx.contextAfter 后文
   */
  open(ctx) {
    this._ctx = ctx;
    this._result = null;
    this._usage = null;
    this.mode = 'input';
    this.el.hidden = false;
    this.diffEl.hidden = true;
    this.diffEl.textContent = '';
    this.errorEl.hidden = true;
    this.errorEl.textContent = '';
    this.applyBtn.hidden = true;
    this.discardBtn.hidden = true;
    this.usageEl.textContent = '';
    this.hintEl.hidden = false;
    this.input.value = '';
    this.input.disabled = false;
    this.sendBtn.disabled = false;
    this._setBusy(false);

    const lines = ctx.selected.split('\n').length;
    this.metaEl.textContent = `${lines} 行 · ${ctx.language || 'text'}`;
    // 长选区的 diff 用更宽的卡片：默认 720px 下 100+ 行的改写预览
    // 横向和纵向都挤，看过一次就得滚动半天。
    this.card.classList.toggle('ai-wide', lines > 40);

    // 焦点放到输入框。用 rAF 是因为 hidden 刚被移除，立即 focus 在部分浏览器无效
    requestAnimationFrame(() => this.input.focus());
  }

  close() {
    this.el.hidden = true;
    this._ctx = null;
    this._result = null;
    this.mode = 'idle';
    this._setBusy(false);
  }

  _setBusy(busy) {
    this._busy = busy;
    this.card.classList.toggle('ai-busy', busy);
    if (busy) {
      this.hintEl.hidden = false;
      this.hintEl.textContent = '请求中…';
    } else if (this.mode === 'input') {
      this.hintEl.textContent = '只改写选中的部分；结果先看 diff，不会直接落盘';
    }
  }

  /** 发送改写请求 */
  async submit() {
    if (this._busy || !this._ctx) return;
    const instruction = this.input.value.trim();
    if (!instruction) {
      this._showError('先写一句要求，比如「改成 async/await」');
      return;
    }

    const settings = this.opts.getSettings() || {};
    const maxKb = Number(settings['ai.maxSelectionKb'] ?? 40);
    const bytes = new TextEncoder().encode(this._ctx.selected).length;
    if (bytes > maxKb * 1024) {
      this._showError(`选区 ${(bytes / 1024).toFixed(1)}KB，超过上限 ${maxKb}KB。选中更小的一段再试。`);
      return;
    }

    this._setBusy(true);
    this.errorEl.hidden = true;
    this.input.disabled = true;
    this.sendBtn.disabled = true;

    try {
      const res = await aiRewrite({
        selected: this._ctx.selected,
        instruction,
        language: this._ctx.language || '',
        contextBefore: this._ctx.contextBefore || '',
        contextAfter: this._ctx.contextAfter || '',
      });
      this._result = res.text ?? '';
      this._usage = res.usage || null;
      this.input.disabled = false;
      this.sendBtn.disabled = false;
      this._setBusy(false);
      this._showPreview();
    } catch (err) {
      this.input.disabled = false;
      this.sendBtn.disabled = false;
      this._setBusy(false);
      this._showError(err.message || String(err));
    }
  }

  _showError(msg) {
    this.errorEl.hidden = false;
    this.errorEl.textContent = msg;
  }

  /** 渲染 diff 预览 */
  _showPreview() {
    if (!this._ctx) return;

    const before = this._ctx.selected;
    const after = this._result ?? '';
    const u = this._usage;

    if (before === after) {
      this._showError('模型返回了与原文相同的内容，没有可应用的变化。可以换个说法再试。');
      this.applyBtn.hidden = true;
      this.discardBtn.hidden = false;
      this.mode = 'preview';
      return;
    }

    const aLines = before.split('\n');
    const bLines = after.split('\n');
    const rows = diffLines(aLines, bLines);
    const { added, removed } = diffStats(rows);

    // 仅「末尾空行」的差异不构成有效变化：LCS 会给它记一条 add/del，
    // 界面上就是一行空白的 + 或 −，用户看不出改了什么，也无从判断
    // 该不该应用。这种情况按「无变化」处理，收起应用按钮。
    if (onlyTrailingBlankChange(rows)) {
      this._showError('差异只有末尾空行，没有可应用的内容变化。');
      this.diffEl.hidden = true;
      this.applyBtn.hidden = true;
      this.discardBtn.hidden = false;
      this.metaEl.textContent = `+${added} −${removed}（仅空行）`;
      this.mode = 'preview';
      return;
    }

    this.diffEl.hidden = false;
    this.diffEl.textContent = '';

    // 上下文一样的行太多时收拢，只保留变更点附近的窗口，
    // 否则一个 200 行选区会把预览撑得没法看。
    const KEEP = 2;
    const visible = new Array(rows.length).fill(false);
    rows.forEach((r, idx) => {
      if (r.type === 'same') return;
      for (let k = Math.max(0, idx - KEEP); k <= Math.min(rows.length - 1, idx + KEEP); k++) {
        visible[k] = true;
      }
    });
    if (!visible.some(Boolean)) visible.fill(true);

    const frag = document.createDocumentFragment();
    let skipped = 0;
    const flushSkipped = () => {
      if (!skipped) return;
      const s = document.createElement('div');
      s.className = 'ai-diff-skip';
      s.textContent = `⋯ 跳过 ${skipped} 行未变`;
      frag.appendChild(s);
      skipped = 0;
    };

    rows.forEach((r, idx) => {
      if (!visible[idx]) {
        skipped++;
        return;
      }
      flushSkipped();
      const line = document.createElement('div');
      line.className = `ai-diff-line ai-diff-${r.type}`;
      const sign = r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' ';
      const num = document.createElement('span');
      num.className = 'ai-diff-num';
      num.textContent = String((r.type === 'add' ? r.bIdx : r.aIdx) + 1);
      const body = document.createElement('span');
      body.className = 'ai-diff-text';
      body.textContent = `${sign} ${r.text}`;
      line.appendChild(num);
      line.appendChild(body);
      frag.appendChild(line);
    });
    flushSkipped();

    this.diffEl.appendChild(frag);
    this.metaEl.textContent = `+${added} −${removed}`;
    this.hintEl.hidden = true;
    this.applyBtn.hidden = false;
    this.discardBtn.hidden = false;
    this.mode = 'preview';

    if (u) {
      this.usageEl.textContent = `${u.promptTokens || 0} + ${u.completionTokens || 0} tokens`;
    } else {
      this.usageEl.textContent = '';
    }
    this.diffEl.scrollTop = 0;
  }

  /**
   * 应用改写。
   *
   * 版本校验是硬要求：从发起请求到用户点应用之间，文档可能被改过
   * （另一处编辑、撤销）。此时原 offset 已经指向错误位置，
   * 直接覆盖会吃掉不相干的文本。宁可让用户重来。
   *
   * 校验分两层，缺一不可：
   *   1. version 必须没动 —— 任何 edit 都会让 buffer.version 递增；
   *   2. 目标区间必须仍是当初选中的那段原文 —— version 对不上时这层不生效，
   *      但版本相同也可能因为「改了又撤销」而落到别的内容上。
   *      只有两层都过，才执行替换。
   *
   * 刻意不看 isDirty / 是否自动保存过：保存写的是磁盘，不动模型，
   * 把「保存过」当成失效条件会让自动保存开着时功能几乎不可用。
   */
  apply() {
    if (!this._ctx || this._result === null) return;

    const currentVersion = this.opts.getVersion?.();
    const currentSlice = this.opts.getSlice?.(this._ctx.offset, this._ctx.deleteCount);

    const versionOk = currentVersion === undefined || currentVersion === this._ctx.version;
    const sliceOk = currentSlice === undefined || currentSlice === this._ctx.selected;

    if (!versionOk || !sliceOk) {
      this._showError('文档在请求期间被修改过，原位置已失效。请重新选中后再试。');
      this.applyBtn.hidden = true;
      this.mode = 'stale';
      return;
    }

    const { offset, deleteCount } = this._ctx;
    const text = this._result;
    this.close();
    this.opts.applyEdit(text, offset, deleteCount);
  }
}
