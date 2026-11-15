/**
 * 语言注册表：把文件扩展名映射到 languageId。
 *
 * 对照 Trae 的机制：它靠每个扩展 package.json 里 contributes.languages
 * 声明的 extensions 数组 + vscode-languagedetection 做兜底。
 * 这里退化成一张静态表 —— 我们只服务于少量文本格式，不需要动态插件。
 */

const EXT_MAP = {
  md: 'markdown',
  markdown: 'markdown',
  mdown: 'markdown',
  mkd: 'markdown',
  json: 'json',
  jsonc: 'jsonc',
  json5: 'json5',
  jsonl: 'jsonl',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  jsx: 'javascript',
  tsx: 'typescript',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  rb: 'ruby',
  sh: 'shell',
  bash: 'shell',
  ps1: 'powershell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  conf: 'ini',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  sql: 'sql',
  txt: 'plaintext',
  log: 'plaintext',
  csv: 'plaintext',
};

/** 这些语言默认挂 md 实时预览（对应 Trae 的 customEditors 优先级 option） */
export const PREVIEWABLE = new Set(['markdown']);

/** 这些语言默认运行 JSON 结构校验 */
export const VALIDATABLE = new Set(['json', 'jsonc', 'jsonl', 'json5']);

export function languageFromPath(path) {
  if (!path) return 'plaintext';
  const clean = path.split('?')[0].split('#')[0];
  const base = clean.substring(clean.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot < 0) return 'plaintext';
  const ext = base.substring(dot + 1).toLowerCase();
  return EXT_MAP[ext] || 'plaintext';
}

export function basename(path) {
  const clean = path.split('?')[0].split('#')[0];
  return clean.substring(clean.lastIndexOf('/') + 1) || 'untitled';
}

/** 人类可读的语言名，用于状态栏 */
export const LANGUAGE_LABELS = {
  markdown: 'Markdown',
  json: 'JSON',
  jsonc: 'JSON with Comments',
  json5: 'JSON5',
  jsonl: 'JSON Lines',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  python: 'Python',
  rust: 'Rust',
  go: 'Go',
  plaintext: 'Plain Text',
};
