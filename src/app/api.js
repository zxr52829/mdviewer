/**
 * 后端通信层。
 *
 * 两种运行模式并存：
 *   - exe 模式：Go 宿主提供 /api/*，可读写本地文件、列目录、弹系统文件框
 *   - 纯静态模式：只有静态文件服务，退化为用 fetch 读样例、导出靠下载
 *
 * 前端不写死模式，启动时探测一次 /api/info 决定能力集。
 * 这样同一份前端既能被 Go 宿主托管，也能直接用任意静态服务器打开调试。
 */

const state = {
  mode: 'unknown', // 'exe' | 'static'
  root: '',
  version: '',
  ready: null,
};

/** 探测后端能力，结果缓存。多次调用只发一次请求。 */
export function detectBackend() {
  if (state.ready) return state.ready;

  state.ready = (async () => {
    try {
      const res = await fetch('/api/info', { cache: 'no-store' });
      if (!res.ok) throw new Error('no api');
      const info = await res.json();
      if (info && info.app) {
        state.mode = 'exe';
        state.root = info.root || '';
        state.version = info.version || '';
        return state;
      }
      throw new Error('bad payload');
    } catch {
      state.mode = 'static';
      return state;
    }
  })();

  return state.ready;
}

export function backendMode() {
  return state.mode;
}

export function backendRoot() {
  return state.root;
}

async function getJSON(url) {
  const res = await fetch(url, { cache: 'no-store' });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`返回内容不是 JSON：${text.slice(0, 120)}`);
  }
  if (!res.ok) {
    throw new Error((data && data.error) || `请求失败 ${res.status}`);
  }
  return data;
}

/**
 * 读文件。exe 模式走 /api/read，静态模式退化为 fetch 相对路径。
 * @param {string} path 相对工作根目录的路径
 * @returns {Promise<{content:string, name:string, path:string}>}
 */
export async function readFile(path) {
  await detectBackend();

  if (state.mode === 'exe') {
    const data = await getJSON(`/api/read?path=${encodeURIComponent(path)}`);
    return { content: data.content, name: data.name, path: data.path };
  }

  // 静态模式：路径相对站点根
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`打开失败 ${res.status}：${path}`);
  const content = await res.text();
  const name = decodeURIComponent(path.substring(path.lastIndexOf('/') + 1));
  return { content, name, path };
}

/**
 * 保存文件。exe 模式原子写回原文件；静态模式只能导出下载。
 * @param {string} path
 * @param {string} content
 * @returns {Promise<{saved:boolean, mode:string, name?:string}>}
 */
export async function saveFile(path, content) {
  await detectBackend();

  if (state.mode === 'exe') {
    const res = await fetch('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content }),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new Error('保存响应格式异常');
    }
    if (!res.ok) throw new Error((data && data.error) || `保存失败 ${res.status}`);
    return { saved: true, mode: 'exe' };
  }

  // 静态模式：触发浏览器下载
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = path.substring(path.lastIndexOf('/') + 1) || 'untitled.txt';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return { saved: true, mode: 'static', name: a.download };
}

/**
 * 列目录。仅 exe 模式可用。
 * @param {string} dir 相对路径，'.' 表示根
 */
export async function listDir(dir = '.') {
  await detectBackend();
  if (state.mode !== 'exe') return { dir, entries: [] };
  return getJSON(`/api/list?dir=${encodeURIComponent(dir)}`);
}

/**
 * 弹系统文件选择框。exe 模式可用。
 * 若所选文件在工作区外，服务端会自动把工作区切到该文件所在目录，
 * 返回值里会带上新的 root。
 * @returns {Promise<{path?:string, name?:string, root?:string, cancelled?:boolean}>}
 */
export async function pickFile() {
  await detectBackend();
  if (state.mode !== 'exe') {
    throw new Error('当前为静态模式，不支持系统文件框');
  }
  const res = await getJSON('/api/pick');
  if (res && res.root) state.root = res.root;
  return res;
}

/** 弹系统目录选择框，用于切换工作区 */
export async function pickDirectory() {
  await detectBackend();
  if (state.mode !== 'exe') {
    throw new Error('当前为静态模式，不支持目录选择');
  }
  return getJSON('/api/pickdir');
}

/** 切换工作区根目录 */
export async function setRoot(path) {
  await detectBackend();
  if (state.mode !== 'exe') {
    throw new Error('当前为静态模式，无法切换工作区');
  }
  const res = await fetch('/api/root', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error('切换工作区响应格式异常');
  }
  if (!res.ok) throw new Error((data && data.error) || '切换失败');
  state.root = data.root;
  return data;
}

/**
 * 新建文件。拒绝覆盖已存在的文件。
 * @param {string} path 相对工作根目录
 * @param {string} [content]
 */
export async function createFile(path, content = '') {
  await detectBackend();
  if (state.mode !== 'exe') {
    throw new Error('当前为静态模式，无法新建文件');
  }
  const res = await fetch('/api/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content }),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error('新建响应格式异常');
  }
  if (!res.ok) throw new Error((data && data.error) || '新建失败');
  return data;
}
