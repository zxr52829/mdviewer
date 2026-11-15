/**
 * 入口：把 DOM 句柄交给 App，按 URL 参数或默认样例打开文件。
 *
 * 打开方式：
 *   /index.html                      → 默认打开 samples/welcome.md
 *   /index.html?file=samples/a.json  → 打开指定文件
 */

import { App } from './app.js';
import { detectBackend, backendMode, backendRoot } from './api.js';

async function boot() {
  const dom = {
    editorRoot: document.getElementById('editorRoot'),
    editorPane: document.getElementById('editorPane'),
    panel: document.getElementById('panel'),
    panelTitle: document.getElementById('panelTitle'),
    previewBody: document.getElementById('previewBody'),
    syncScroll: document.getElementById('syncScroll'),
    fileName: document.getElementById('fileName'),
    dirtyLabel: document.getElementById('dirtyLabel'),
    statusLeft: document.getElementById('statusLeft'),
    posLabel: document.getElementById('posLabel'),
    sizeLabel: document.getElementById('sizeLabel'),
    langLabel: document.getElementById('langLabel'),
    btnFormat: document.getElementById('btnFormat'),
    btnMinify: document.getElementById('btnMinify'),
    btnUndo: document.getElementById('btnUndo'),
    btnRedo: document.getElementById('btnRedo'),
    btnSave: document.getElementById('btnSave'),
    btnOpen: document.getElementById('btnOpen'),
    btnNew: document.getElementById('btnNew'),
    btnWorkspace: document.getElementById('btnWorkspace'),
    btnSettings: document.getElementById('btnSettings'),
    btnSettingsClose: document.getElementById('btnSettingsClose'),
    btnSettingsReset: document.getElementById('btnSettingsReset'),
    settingsOverlay: document.getElementById('settingsOverlay'),
    settingsBody: document.getElementById('settingsBody'),
    fileTree: document.getElementById('fileTree'),
    sidebar: document.getElementById('sidebar'),
    rootPath: document.getElementById('rootPath'),
    resizerLeft: document.getElementById('resizerLeft'),
    resizerRight: document.getElementById('resizerRight'),
  };

  // 先探测后端能力，决定状态栏与按钮可用性
  await detectBackend();
  const mode = backendMode();

  if (dom.rootPath) {
    dom.rootPath.textContent = mode === 'exe' ? (backendRoot() || '') : '静态模式';
    dom.rootPath.title = mode === 'exe'
      ? `工作目录：${backendRoot()}`
      : '当前由静态服务器提供，只能读取内置样例，保存会触发浏览器下载';
  }

  const app = new App(dom);
  window.__mdviewer = app; // 便于验收脚本与调试

  const params = new URLSearchParams(location.search);

  // 默认打开的文件。两种部署下样例位置不同：
  //   exe 模式 → web/samples/welcome.md（embed 目录结构）
  //   静态模式 → samples/welcome.md
  // 写死任一个都会让另一种模式启动即报错。这里按顺序探测第一个可读的。
  const candidates = params.get('file')
    ? [params.get('file')]
    : ['samples/welcome.md', 'web/samples/welcome.md'];

  let opened = false;
  let lastErr = null;
  for (const file of candidates) {
    try {
      await app.openFile(file, { silent: true });
      if (mode === 'exe') dom.statusLeft.textContent = '就绪';
      opened = true;
      break;
    } catch (err) {
      lastErr = err;
    }
  }

  if (!opened) {
    // 都不存在时给一个可直接编辑的空文档，而不是报错停在那
    app.openText('', 'untitled.md', { displayName: '未命名.md' });
    dom.statusLeft.textContent = lastErr
      ? `未找到默认文件，已新建空白文档`
      : '就绪';
  }

  // 文件树：exe 模式才可用，静态模式下隐藏侧栏避免误导
  if (mode === 'exe' && dom.sidebar) {
    await app.loadTree('.');
  } else {
    if (dom.sidebar) dom.sidebar.hidden = true;
    // 侧栏隐藏后左侧分隔条没有意义，一并隐藏
    if (dom.resizerLeft) dom.resizerLeft.hidden = true;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => boot());
} else {
  boot();
}
