/**
 * 应用装配层。
 *
 * 对照 Trae 的 workbench：把 editor / preview / statusbar 三块拼起来，
 * 用事件总线连接。这里简化成一个 App 类，职责是：
 *   1. 按 languageId 决定右侧面板放预览还是校验
 *   2. 把编辑器的光标行同步给预览（双向滚动）
 *   3. 文件打开 / 保存 / 格式化
 */

import { TextModel } from '../core/text-model.js';
import { EditorView, METRICS } from '../view/editor-view.js';
import { renderMarkdown } from '../preview/markdown-renderer.js';
import { morphHtml } from '../preview/morph.js';
import * as jsonService from '../lang/json-service.js';
import { languageFromPath, basename, PREVIEWABLE, VALIDATABLE, LANGUAGE_LABELS } from '../lang/registry.js';
import { readFile, saveFile, listDir, pickFile, pickDirectory, setRoot, createFile, detectBackend, backendMode, backendRoot } from './api.js';
import { loadSettings, saveSettings, applySettings, defaultSettings, FONT_STACKS } from './settings.js';
import { SettingsPanel } from './settings-panel.js';
import { makeResizer } from './resizer.js';

const PREVIEW_DEBOUNCE_MS = 120;

export class App {
  constructor(dom) {
    this.dom = dom;
    this.model = null;
    this.view = null;
    this.filePath = '';
    this.previewTimer = 0;
    this._previewLineMap = [];
    this._lastDiagTimer = 0;
    this._autoSaveTimer = 0;

    // 设置：先加载并应用外观（此时还没有视图，只写 CSS 变量）
    this.settings = loadSettings();
    applySettings(this.settings, { root: document.documentElement });

    this._wireToolbar();
    this._initSettingsPanel();
    this._wireResizers();
  }

  /**
   * 接上两条分隔条：侧栏↔编辑区、编辑区↔预览。
   *
   * 拖动改的是相邻两块的 flex-basis，编辑器宽度变化后必须调 relayout，
   * 否则字符定位仍按旧宽度算，光标和选区会错位。
   */
  _wireResizers() {
    const { sidebar, editorPane, panel, resizerLeft, resizerRight } = this.dom;

    if (sidebar && editorPane && resizerLeft) {
      makeResizer(resizerLeft, {
        before: sidebar,
        after: editorPane,
        direction: 'horizontal',
        minBefore: 120,
        minAfter: 260,
        onResize: () => this._onPaneResized(),
        onEnd: () => this._onPaneResized(),
      });
    }

    if (editorPane && panel && resizerRight) {
      makeResizer(resizerRight, {
        before: editorPane,
        after: panel,
        direction: 'horizontal',
        minBefore: 260,
        minAfter: 200,
        onResize: () => this._onPaneResized(),
        onEnd: () => this._onPaneResized(),
      });
    }

    // 窗口尺寸变化同样要重排
    let winTimer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(winTimer);
      winTimer = setTimeout(() => this._onPaneResized(), 80);
    });
  }

  /** 面板尺寸变化后重排编辑器（字符宽度测量依赖容器宽度） */
  _onPaneResized() {
    if (!this.view) return;
    // 拖动过程中连续触发，用 rAF 合并到下一帧，避免逐像素重排卡顿
    if (this._resizeRaf) cancelAnimationFrame(this._resizeRaf);
    this._resizeRaf = requestAnimationFrame(() => {
      this._resizeRaf = 0;
      this.view.relayout();
    });
  }

  /** 取当前设置值 */
  setting(id) {
    return this.settings[id];
  }

  /* ---------------- 设置 ---------------- */

  _initSettingsPanel() {
    const mount = this.dom.settingsBody;
    const overlay = this.dom.settingsOverlay;
    if (!mount || !overlay) return;

    this.settingsPanel = new SettingsPanel(mount, this.settings, (id, value) => {
      this.settings[id] = value;
      saveSettings(this.settings);
      this._applyOneSetting(id, value);
    });

    this.dom.btnSettings?.addEventListener('click', () => this.toggleSettings(true));
    this.dom.btnSettingsClose?.addEventListener('click', () => this.toggleSettings(false));
    this.dom.btnSettingsReset?.addEventListener('click', () => {
      // 恢复默认：整体替换为 schema 默认值并重新应用
      this.settings = defaultSettings();
      saveSettings(this.settings);
      this.settingsPanel.sync(this.settings);
      applySettings(this.settings, { view: this.view, root: document.documentElement });
      if (this.view) {
        // 括号配色、查找高亮等视图侧开关不在 applyMetrics 里，
        // 必须显式再同步一次，否则恢复默认后开关状态仍是旧的。
        this.view.setFindHighlightEnabled(this.setting('editor.findHighlight') !== false);
        this.view.applyMetrics({
          bracketColorization: this.setting('editor.bracketPairColorization'),
        });
        this.view.relayout();
      }
      this.dom.statusLeft.textContent = '已恢复默认设置';
    });

    // 遮罩点击关闭 / Esc 关闭
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.toggleSettings(false);
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !overlay.hidden) {
        e.stopPropagation();
        this.toggleSettings(false);
      }
    });
  }

  toggleSettings(show) {
    const overlay = this.dom.settingsOverlay;
    if (!overlay) return;
    overlay.hidden = show === undefined ? !overlay.hidden : !show;
  }

  /** 单项设置变更后立即生效 */
  _applyOneSetting(id, value) {
    // 外观类（字号/行高/字体/制表符/括号配色）影响度量，走视图重排
    if (id === 'editor.fontSize' || id === 'editor.lineHeight' ||
        id === 'editor.fontFamily' || id === 'editor.tabSize' ||
        id === 'editor.bracketPairColorization') {
      applySettings(this.settings, { view: this.view, root: document.documentElement });
      if (this.view) {
        // 行高变了，滚动位置需要按新行高重算，避免视觉跳动
        this.view.relayout();
      }
      this.dom.statusLeft.textContent = '设置已应用';
      return;
    }

    // 纯 CSS 类
    applySettings(this.settings, { root: document.documentElement });

    // 查找高亮开关：直接交给视图层处理
    if (id === 'editor.findHighlight') {
      this.view?.setFindHighlightEnabled(value);
    }

    this.dom.statusLeft.textContent = '设置已应用';
  }

  /* ---------------- 自动保存 ---------------- */

  _scheduleAutoSave() {
    if (!this.setting('files.autoSave')) return;
    if (backendMode() !== 'exe') return;
    clearTimeout(this._autoSaveTimer);
    this._autoSaveTimer = setTimeout(() => {
      if (this.model && this.model.isDirty) this.save();
    }, 1000);
  }


  /* ---------------- 文件 ---------------- */

  /**
   * 打开文件。exe 模式走 /api/read，静态模式退化为 fetch。
   * @param {string} path 相对工作根目录的路径
   * @param {{silent?:boolean, displayName?:string}} [opts]
   */
  async openFile(path, opts = {}) {
    const file = await readFile(path);
    this.openText(file.content, file.path || path, {
      displayName: opts.displayName || file.name,
    });
    if (!opts.silent) this.dom.statusLeft.textContent = `已打开 ${file.name}`;
  }

  /** 兼容旧入口：URL 形式的历史调用 */
  async openFromUrl(url, opts) {
    const clean = url.split('?')[0];
    const rel = clean.startsWith('/') ? clean.slice(1) : clean;
    return this.openFile(rel, opts);
  }

  /**
   * 装载文本。
   * @param {string} text
   * @param {string} path 相对工作根目录的路径（保存时要用）
   * @param {{displayName?:string}} [opts]
   */
  openText(text, path = 'untitled.md', opts = {}) {
    this.filePath = path;
    const languageId = languageFromPath(path);

    if (this.view) this.view = null;
    this.dom.editorRoot.innerHTML = '';

    this.model = new TextModel(text, { uri: path, languageId });
    this.model.markSaved();
    // 视图按当前设置初始化度量，避免先按默认值渲染再重排造成的闪烁
    this.view = new EditorView(this.dom.editorRoot, this.model, {
      fontSize: this.setting('editor.fontSize'),
      lineHeight: this.setting('editor.lineHeight'),
      fontFamily: FONT_STACKS[this.setting('editor.fontFamily')],
      tabSize: this.setting('editor.tabSize'),
      bracketColorization: this.setting('editor.bracketPairColorization'),
    });

    // 查找高亮开关：关掉时不扫描全文
    this.view.setFindHighlightEnabled(this.setting('editor.findHighlight') !== false);

    this.view.on('cursor', (pos) => this._onCursorMoved(pos));
    this.view.on('content', () => this._onContentChanged());

    this.dom.fileName.textContent = opts.displayName || basename(path);
    this.dom.fileName.title = path;
    this.dom.langLabel.textContent = LANGUAGE_LABELS[languageId] || languageId;

    this._configureSidePanel(languageId);
    // 分栏状态定稿后再重排：构造视图时面板还没打开，编辑器宽度是临时的，
    // 据此算出的内容区宽度会偏大一倍，必须在这里纠正。
    this.view.relayout();
    this._refreshPreview(true);
    this._updateStatus();
    this.view.focus();
  }

  /**
   * 保存。
   *
   * exe 模式直接原子写回原文件（这才是"编辑器"该有的行为）；
   * 静态模式只能退回浏览器下载，并明确告知用户。
   */
  async save() {
    if (!this.model) return;
    const content = this.model.getValue();
    this.dom.statusLeft.textContent = '保存中…';

    try {
      const res = await saveFile(this.filePath, content);
      this.model.markSaved();
      this._updateStatus();
      if (res.mode === 'exe') {
        this.dom.statusLeft.textContent = `已保存 ${basename(this.filePath)}`;
      } else {
        this.dom.statusLeft.textContent = `已导出 ${res.name}（静态模式无法写回）`;
      }
    } catch (err) {
      this.dom.statusLeft.textContent = `保存失败：${err.message}`;
    }
  }

  /* ---------------- 文件树 ---------------- */

  /**
   * 渲染文件树。
   *
   * 只做单层展开：点击目录加载并展开子项，点文件则打开。
   * 不做递归全量扫描 —— 工作目录可能是整个仓库，全量遍历既慢又没必要。
   */
  async loadTree(dir = '.', container = null) {
    const target = container || this.dom.fileTree;
    if (!target) return;

    try {
      const { entries } = await listDir(dir);
      target.innerHTML = '';

      if (!entries.length) {
        target.innerHTML = '<div class="tree-empty">此目录没有可编辑的文本文件</div>';
        return;
      }

      for (const entry of entries) {
        const row = document.createElement('div');
        row.className = 'tree-item';
        row.dataset.path = entry.path;
        row.dataset.isDir = entry.isDir ? '1' : '0';
        row.style.paddingLeft = `${8 + this._treeDepth(entry.path) * 12}px`;

        const icon = document.createElement('span');
        icon.className = 'tree-icon';
        icon.textContent = entry.isDir ? '▸' : this._fileIcon(entry.name);

        const name = document.createElement('span');
        name.className = 'tree-name';
        name.textContent = entry.name;

        row.append(icon, name);
        target.appendChild(row);
      }
    } catch (err) {
      target.innerHTML = `<div class="tree-empty">读取目录失败：${err.message}</div>`;
    }
  }

  _treeDepth(path) {
    return Math.max(0, path.split('/').length - 1);
  }

  _fileIcon(name) {
    const lower = name.toLowerCase();
    if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'M';
    if (lower.endsWith('.json') || lower.endsWith('.jsonc')) return '{}';
    return '·';
  }

  /** 事件委托：目录展开 / 文件打开 */
  _wireTree() {
    if (!this.dom.fileTree) return;

    this.dom.fileTree.addEventListener('click', async (e) => {
      const row = e.target.closest('.tree-item');
      if (!row) return;

      // 目录：就地展开或收起
      if (row.dataset.isDir === '1') {
        const existing = row.nextElementSibling;
        if (existing && existing.classList.contains('tree-children')) {
          existing.remove();
          row.querySelector('.tree-icon').textContent = '▸';
          return;
        }
        const box = document.createElement('div');
        box.className = 'tree-children';
        row.after(box);
        row.querySelector('.tree-icon').textContent = '▾';
        await this.loadTree(row.dataset.path, box);
        return;
      }

      // 文件：打开
      this.dom.fileTree.querySelectorAll('.tree-item.active').forEach((el) => el.classList.remove('active'));
      row.classList.add('active');
      try {
        await this.openFile(row.dataset.path);
      } catch (err) {
        this.dom.statusLeft.textContent = `打开失败：${err.message}`;
      }
    });
  }

  /* ---------------- 侧面板 ---------------- */

  _configureSidePanel(languageId) {
    const isMd = PREVIEWABLE.has(languageId);
    const isJson = VALIDATABLE.has(languageId);

    this.dom.panel.hidden = !(isMd || isJson);
    this.dom.editorPane.classList.toggle('with-panel', isMd || isJson);
    // 预览隐藏时右侧分隔条也隐藏，否则会留一条无意义的拖拽区
    if (this.dom.resizerRight) this.dom.resizerRight.hidden = !(isMd || isJson);
    this.dom.panelTitle.textContent = isMd ? '预览' : '结构';
    this.dom.previewBody.innerHTML = '';
    this._previewLineMap = [];

    if (!isMd && !isJson) return;

    if (isJson) {
      this._renderJsonOutline();
    }
  }

  _renderJsonOutline() {
    const text = this.model.getValue();
    const res = jsonService.validate(text, this.model.languageId);
    const out = jsonService.outline(text, this.model.languageId);

    if (!res.valid) {
      const e = res.errors[0];
      this.dom.previewBody.innerHTML = `
        <div class="diag-item error">
          <div class="diag-title">JSON 校验失败</div>
          <div class="diag-loc">第 ${e.line} 行 第 ${e.column} 列</div>
          <div class="diag-msg">${escapeHtml(e.message)}</div>
        </div>`;
      return;
    }

    const renderNode = (node, depth) => {
      const kids = node.children?.length
        ? `<div class="outline-children">${node.children.map((c) => renderNode(c, depth + 1)).join('')}</div>`
        : '';
      return `<div class="outline-node">
        <span class="outline-kind k-${node.kind}">${node.kind}</span>
        <span class="outline-label">${escapeHtml(node.label)}</span>
      </div>${kids}`;
    };

    this.dom.previewBody.innerHTML = `
      <div class="outline-root">
        <div class="outline-head">JSON 有效 · ${out.length} 个顶层节点</div>
        ${out.map((n) => renderNode(n, 0)).join('')}
      </div>`;
  }

  /* ---------------- 预览 ---------------- */

  _onContentChanged() {
    this._updateStatus();
    this._schedulePreview();
    this._scheduleAutoSave();
  }

  _schedulePreview() {
    if (!PREVIEWABLE.has(this.model.languageId)) {
      if (VALIDATABLE.has(this.model.languageId)) {
        clearTimeout(this._lastDiagTimer);
        this._lastDiagTimer = setTimeout(() => this._renderJsonOutline(), 300);
      }
      return;
    }
    clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => this._refreshPreview(false), PREVIEW_DEBOUNCE_MS);
  }

  _refreshPreview(force) {
    if (!PREVIEWABLE.has(this.model.languageId)) return;
    const text = this.model.getValue();
    const { html } = renderMarkdown(text);

    // 记录每个预览行号对应的 DOM，供滚动同步
    morphHtml(this.dom.previewBody, html);
    this._previewLineMap = Array.from(this.dom.previewBody.querySelectorAll('.code-line'));

    if (force) {
      this.dom.previewBody.scrollTop = 0;
    }
    this._syncPreviewToCursor();
  }

  /** 编辑器光标行 → 预览滚动位置（二分定位最近块） */
  _syncPreviewToCursor() {
    if (!this.dom.syncScroll.checked) return;
    const lines = this._previewLineMap;
    if (!lines.length) return;

    const target = this._currentLine;
    if (!target) return;

    let lo = 0;
    let hi = lines.length - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const n = Number(lines[mid].dataset.line);
      if (n <= target) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    const el = lines[best];
    if (!el) return;

    // 高亮当前块
    for (const n of lines) n.classList.remove('code-active-line');
    el.classList.add('code-active-line');

    const bodyRect = this.dom.previewBody.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const delta = elRect.top - bodyRect.top;
    if (delta < 0 || elRect.bottom > bodyRect.bottom) {
      this.dom.previewBody.scrollTop += delta - bodyRect.height / 3;
    }
  }

  _onCursorMoved(pos) {
    this._currentLine = pos?.line || 1;
    this._updateStatus();
    if (PREVIEWABLE.has(this.model?.languageId)) this._syncPreviewToCursor();
  }

  /* ---------------- 工具栏 ---------------- */

  _wireToolbar() {
    this.dom.btnFormat.addEventListener('click', () => this.formatDocument());
    this.dom.btnMinify.addEventListener('click', () => this.minifyDocument());
    this.dom.btnUndo.addEventListener('click', () => {
      if (this.model?.undo()) this.view.afterEdit();
    });
    this.dom.btnRedo.addEventListener('click', () => {
      if (this.model?.redo()) this.view.afterEdit();
    });
    this.dom.btnSave.addEventListener('click', () => this.save());
    this.dom.btnOpen?.addEventListener('click', () => this.openViaDialog());
    this.dom.btnNew?.addEventListener('click', () => this.newFile());
    this.dom.btnWorkspace?.addEventListener('click', () => this.switchWorkspace());

    this._wireTree();

    // 全局快捷键：Ctrl+S 保存、Ctrl+N 新建、Ctrl+O 打开、Ctrl+Shift+O 换工作区
    window.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;

      // 输入框里的 Ctrl+N/O 不该被编辑器抢走
      const tag = (e.target?.tagName || '').toLowerCase();
      const inField = tag === 'input' || tag === 'textarea';
      if (inField && e.target !== this.view?.input) return;

      const k = e.key.toLowerCase();
      if (!e.shiftKey && k === 's') {
        e.preventDefault();
        this.save();
      }
      if (!e.shiftKey && k === 'n') {
        e.preventDefault();
        this.newFile();
      }
      if (!e.shiftKey && k === 'o') {
        e.preventDefault();
        this.openViaDialog();
      }
      if (e.shiftKey && k === 'o') {
        e.preventDefault();
        this.switchWorkspace();
      }
      if (e.shiftKey && k === 'f') {
        e.preventDefault();
        this.formatDocument();
      }
    });
  }

  /**
   * 通过系统文件框打开。
   *
   * 允许选工作区外的文件：服务端会自动把工作区切到该文件所在目录，
   * 然后返回新的 root。前端刷新文件树与路径显示。
   */
  async openViaDialog() {
    try {
      this.dom.statusLeft.textContent = '等待选择文件…';
      const picked = await pickFile();
      if (picked.cancelled) {
        this.dom.statusLeft.textContent = '已取消';
        return;
      }
      // 服务端可能改了工作区（选到工作区外的文件时）
      if (picked.root) this._updateRootDisplay(picked.root);
      await this.openFile(picked.path, { displayName: picked.name });
      await this.loadTree('.');
      this.dom.statusLeft.textContent = `已打开 ${picked.name}`;
    } catch (err) {
      this.dom.statusLeft.textContent = `打开失败：${err.message}`;
    }
  }

  /** 切换工作区：选目录后整体刷新 */
  async switchWorkspace() {
    try {
      this.dom.statusLeft.textContent = '等待选择目录…';
      const picked = await pickDirectory();
      if (picked.cancelled) {
        this.dom.statusLeft.textContent = '已取消';
        return;
      }
      const info = await setRoot(picked.path);
      const newRoot = info.root;
      this._updateRootDisplay(newRoot);
      await this.loadTree('.');

      // 目标目录没有可编辑文件时要说清楚，否则用户只看到一片空白，
      // 不知道是"选错了"还是"程序坏了"。
      if (!info.editable) {
        const hint = info.subdirs
          ? `该目录下 ${info.subdirs} 个子目录里可能有文件，点开看看`
          : '该目录下没有可编辑的文本文件';
        this.dom.statusLeft.textContent = `已切换到 ${newRoot} — ${hint}`;
        return;
      }
      this.dom.statusLeft.textContent = `工作区已切换到 ${newRoot}`;
    } catch (err) {
      this.dom.statusLeft.textContent = `切换失败：${err.message}`;
    }
  }

  _updateRootDisplay(root) {
    if (!this.dom.rootPath) return;
    this.dom.rootPath.textContent = root || '';
    this.dom.rootPath.title = `工作目录：${root}`;
  }

  /**
   * 新建文件。
   * 扩展名决定语言，所以默认给 .md。
   */
  async newFile() {
    const suggested = this._suggestNewName();
    const input = await this._askText({
      title: '新建文件名（可带路径，如 notes/a.md）',
      value: suggested,
    });
    if (input === null) return;

    const name = input.trim();
    if (!name) {
      this.dom.statusLeft.textContent = '文件名不能为空';
      return;
    }

    try {
      await createFile(name, '');
      await this.loadTree('.');
      await this.openFile(name, { displayName: name });
      this.dom.statusLeft.textContent = `已新建 ${name}`;
    } catch (err) {
      this.dom.statusLeft.textContent = `新建失败：${err.message}`;
    }
  }

  /**
   * 应用内文本输入弹层，替代 window.prompt。
   *
   * 为什么不用原生 prompt：它在部分 Chromium / Electron 环境被禁用，
   * 调用后直接返回 null 而不弹窗，表现就是「点新建毫无反应」，
   * 且没有任何错误可查。自带一个可控的弹层最稳。
   *
   * @param {{title:string, value?:string, validate?:(v:string)=>string|null}} opts
   * @returns {Promise<string|null>} 取消时返回 null
   */
  _askText({ title, value = '', validate = null }) {
    const overlay = document.getElementById('promptOverlay');
    const titleEl = document.getElementById('promptTitle');
    const inputEl = document.getElementById('promptInput');
    const errorEl = document.getElementById('promptError');
    const okBtn = document.getElementById('promptOk');
    const cancelBtn = document.getElementById('promptCancel');

    if (!overlay || !inputEl) {
      // 兜底：DOM 缺失时退回原生 prompt，至少不会彻底失效
      return Promise.resolve(window.prompt(title, value));
    }

    titleEl.textContent = title;
    inputEl.value = value;
    errorEl.hidden = true;
    errorEl.textContent = '';
    overlay.hidden = false;

    // 焦点与选区放到弹层里，避免残留的 textarea 抢按键
    inputEl.focus();
    const dot = value.lastIndexOf('.');
    inputEl.setSelectionRange(0, dot > 0 ? dot : value.length);

    return new Promise((resolve) => {
      let settled = false;

      const cleanup = (result) => {
        if (settled) return;
        settled = true;
        overlay.hidden = true;
        inputEl.removeEventListener('keydown', onKey);
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        overlay.removeEventListener('mousedown', onBackdrop);
        // 焦点还给编辑器，否则用户接着打字会丢
        try { document.querySelector('.editor-input')?.focus({ preventScroll: true }); } catch { /* 忽略 */ }
        resolve(result);
      };

      const submit = () => {
        const v = inputEl.value;
        if (validate) {
          const msg = validate(v);
          if (msg) {
            errorEl.textContent = msg;
            errorEl.hidden = false;
            inputEl.focus();
            return;
          }
        }
        cleanup(v);
      };

      const onKey = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          submit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cleanup(null);
        }
        // 拦掉冒泡，别让快捷键（Ctrl+N / Ctrl+O）穿透到底层编辑器
        e.stopPropagation();
      };
      const onOk = () => submit();
      const onCancel = () => cleanup(null);
      const onBackdrop = (e) => {
        if (e.target === overlay) cleanup(null);
      };

      inputEl.addEventListener('keydown', onKey);
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      overlay.addEventListener('mousedown', onBackdrop);
    });
  }

  /** 给一个不冲突的默认文件名 */
  _suggestNewName() {
    const taken = new Set(
      Array.from(this.dom.fileTree?.querySelectorAll('.tree-item') || [])
        .map((el) => el.querySelector('.tree-name')?.textContent)
        .filter(Boolean),
    );
    let i = 1;
    let name = 'untitled.md';
    while (taken.has(name)) {
      i++;
      name = `untitled-${i}.md`;
    }
    return name;
  }

  formatDocument() {
    if (!this.model) return;
    const lang = this.model.languageId;
    if (!VALIDATABLE.has(lang)) {
      this.dom.statusLeft.textContent = '当前语言无格式化器';
      return;
    }
    const res = jsonService.format(this.model.getValue(), { languageId: lang });
    if (!res.ok) {
      this.dom.statusLeft.textContent = `格式化失败：第 ${res.error.line} 行 ${res.error.message}`;
      return;
    }
    this.model.setValue(res.text);
    this.model.markSaved();
    this.view.refresh();
    this._renderJsonOutline();
    this._updateStatus();
    this.dom.statusLeft.textContent = '已格式化';
  }

  minifyDocument() {
    if (!this.model) return;
    const lang = this.model.languageId;
    if (!VALIDATABLE.has(lang)) return;
    const res = jsonService.minify(this.model.getValue(), { languageId: lang });
    if (!res.ok) {
      this.dom.statusLeft.textContent = `压缩失败：${res.error.message}`;
      return;
    }
    this.model.setValue(res.text);
    this.view.refresh();
    this._renderJsonOutline();
    this._updateStatus();
    this.dom.statusLeft.textContent = '已压缩';
  }

  _updateStatus() {
    if (!this.model) return;
    const pos = this.view?.cursor || { line: 1, column: 1 };
    this.dom.posLabel.textContent = `行 ${pos.line}, 列 ${pos.column}`;
    this.dom.sizeLabel.textContent = `${this.model.getLineCount()} 行 · ${this.model.length} 字符`;
    this.dom.dirtyLabel.hidden = !this.model.isDirty;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

export { METRICS };
