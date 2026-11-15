/**
 * 设置：定义、持久化、生效。
 *
 * 对照 Trae 的 editor.* 配置项，只保留真正影响编辑体验的几项。
 * 存 localStorage（纯前端可用），并与 CSS 变量 / 视图属性双向绑定。
 *
 * 设计原则：设置项名与 VS Code 保持一致，方便对照原版行为。
 */

const STORAGE_KEY = 'mdviewer.settings.v1';

/**
 * 设置定义表。
 * apply 说明该项如何生效：
 *   - 'css-var'  写入 :root 的 CSS 变量
 *   - 'attr'     交给 EditorView 处理（重建度量、重排）
 *   - 'self'     由 App 自行读取
 */
export const SETTINGS_SCHEMA = [
  {
    group: '外观',
    items: [
      {
        id: 'editor.fontSize',
        label: '字号',
        type: 'number',
        default: 13,
        min: 10,
        max: 28,
        unit: 'px',
        apply: 'attr',
        hint: '改变字号会重新测量字符宽度，光标与选区随之校准',
      },
      {
        id: 'editor.lineHeight',
        label: '行高',
        type: 'number',
        default: 20,
        min: 14,
        max: 48,
        unit: 'px',
        apply: 'attr',
        hint: '行高必须不小于字号，否则文字会重叠',
      },
      {
        id: 'editor.fontFamily',
        label: '字体',
        type: 'select',
        default: 'jetbrains',
        options: [
          { value: 'jetbrains', label: 'JetBrains Mono' },
          { value: 'cascadia', label: 'Cascadia Mono' },
          { value: 'consolas', label: 'Consolas' },
          { value: 'monospace', label: '系统等宽' },
        ],
        apply: 'attr',
        hint: '等宽字体；缺字体会自动回退，宽度会自动重新实测',
      },
      {
        id: 'editor.theme',
        label: '主题',
        type: 'select',
        default: 'dark',
        options: [
          { value: 'dark', label: '深色' },
          { value: 'light', label: '浅色' },
        ],
        apply: 'css-var',
        hint: '切换后语法着色配色同步变化',
      },
    ],
  },
  {
    group: '编辑',
    items: [
      {
        id: 'editor.tabSize',
        label: '制表符宽度',
        type: 'number',
        default: 2,
        min: 1,
        max: 8,
        unit: ' 空格',
        apply: 'attr',
        hint: '同时影响 Tab 键插入与制表符显示宽度',
      },
      {
        id: 'editor.autoClosingBrackets',
        label: '自动闭合括号',
        type: 'boolean',
        default: true,
        apply: 'self',
        hint: '输入 ( [ { " 时自动补全另一半',
      },
      {
        id: 'editor.autoIndent',
        label: '回车自动缩进',
        type: 'boolean',
        default: true,
        apply: 'self',
        hint: '按语言缩进规则继承上一行缩进',
      },
      {
        id: 'editor.findHighlight',
        label: '查找高亮',
        type: 'boolean',
        default: true,
        apply: 'self',
        hint: '选中文字时，全文相同文字标黄',
      },
    ],
  },
  {
    group: '显示',
    items: [
      {
        id: 'editor.renderWhitespace',
        label: '显示空白字符',
        type: 'select',
        default: 'selection',
        options: [
          { value: 'none', label: '不显示' },
          { value: 'selection', label: '仅选区' },
          { value: 'all', label: '总是' },
        ],
        apply: 'css-var',
        hint: '空格显示为中点，制表符显示为箭头',
      },
      {
        id: 'editor.renderLineHighlight',
        label: '高亮当前行',
        type: 'boolean',
        default: true,
        apply: 'css-var',
        hint: '在光标所在行加一层浅底',
      },
      {
        id: 'editor.cursorBlinking',
        label: '光标闪烁',
        type: 'boolean',
        default: true,
        apply: 'css-var',
        hint: '关闭后光标常亮，减少视觉干扰',
      },
      {
        id: 'editor.bracketPairColorization',
        label: '括号配对配色',
        type: 'boolean',
        default: true,
        apply: 'attr',
        hint: '按嵌套深度给括号上不同颜色',
      },
    ],
  },
  {
    group: '文件',
    items: [
      {
        id: 'files.autoSave',
        label: '自动保存',
        type: 'boolean',
        default: false,
        apply: 'self',
        hint: '停止输入 1 秒后自动写回原文件（仅 exe 模式）',
      },
    ],
  },
];

/** 扁平化的 id → 定义 */
export const SETTINGS_BY_ID = (() => {
  const map = new Map();
  for (const g of SETTINGS_SCHEMA) for (const item of g.items) map.set(item.id, item);
  return map;
})();

/** 默认值对象 */
export function defaultSettings() {
  const out = {};
  for (const [id, def] of SETTINGS_BY_ID) out[id] = def.default;
  return out;
}

/** 读取已保存设置，与默认值合并（新增项自动补齐） */
export function loadSettings() {
  const base = defaultSettings();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw);
    for (const id of Object.keys(base)) {
      if (Object.prototype.hasOwnProperty.call(saved, id)) {
        // 类型校正：数字越界、布尔值被存成字符串等都归一到合法值
        const def = SETTINGS_BY_ID.get(id);
        base[id] = coerce(def, saved[id]);
      }
    }
  } catch {
    /* 坏数据直接忽略，用默认值 */
  }
  return base;
}

function coerce(def, value) {
  if (!def) return value;
  if (def.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) return def.default;
    return Math.max(def.min ?? -Infinity, Math.min(def.max ?? Infinity, n));
  }
  if (def.type === 'boolean') return !!value;
  if (def.type === 'select') {
    const ok = def.options.some((o) => o.value === value);
    return ok ? value : def.default;
  }
  return value;
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* 存储被禁用时静默失败，设置仅在本次会话内有效 */
  }
}

/** 字体族映射 */
export const FONT_STACKS = {
  jetbrains: '"JetBrains Mono", "Cascadia Mono", Consolas, "Microsoft YaHei", monospace',
  cascadia: '"Cascadia Mono", Consolas, "Microsoft YaHei", monospace',
  consolas: 'Consolas, "Microsoft YaHei", monospace',
  monospace: 'monospace',
};

/**
 * 把设置应用到运行时。
 *
 * @param {object} settings
 * @param {{view?:object, root?:HTMLElement}} ctx
 */
export function applySettings(settings, ctx = {}) {
  const root = ctx.root || document.documentElement;

  // ---- css 变量 ----
  root.style.setProperty('--editor-font-size', `${settings['editor.fontSize']}px`);
  root.style.setProperty('--line-height', `${settings['editor.lineHeight']}px`);
  root.style.setProperty('--editor-font-family', FONT_STACKS[settings['editor.fontFamily']] || FONT_STACKS.monospace);

  const ws = settings['editor.renderWhitespace'];
  root.dataset.whitespace = ws;
  root.dataset.lineHighlight = settings['editor.renderLineHighlight'] ? '1' : '0';
  root.dataset.cursorBlink = settings['editor.cursorBlinking'] ? '1' : '0';
  root.dataset.theme = settings['editor.theme'];

  // ---- 视图层 ----
  if (ctx.view) {
    ctx.view.applyMetrics({
      fontSize: settings['editor.fontSize'],
      lineHeight: settings['editor.lineHeight'],
      fontFamily: FONT_STACKS[settings['editor.fontFamily']] || FONT_STACKS.monospace,
      tabSize: settings['editor.tabSize'],
      bracketColorization: settings['editor.bracketPairColorization'],
    });
  }
}
