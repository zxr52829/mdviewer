# mdviewer

一个可直接打开 **Markdown / JSON** 的文本编辑器，照着 Trae CN 的编辑架构写的最小同构实现。

## 架构分层

```
src/
├─ core/
│  ├─ piece-tree.js    文本缓冲（Piece Table，原文只读 + 增量缓冲）
│  └─ text-model.js    模型层（行索引、编辑归一化、undo/redo）
├─ lang/
│  ├─ registry.js      扩展名 → languageId
│  ├─ highlighter.js   按行 tokenize → span
│  └─ json-service.js  校验 / 格式化 / 压缩 / 折叠范围 / 大纲
├─ view/
│  └─ editor-view.js   视口虚拟滚动渲染 + 光标 + 选区 + 键盘输入
├─ preview/
│  ├─ markdown-renderer.js  md → HTML（每个块带 data-line）
│  └─ morph.js         增量 DOM diff
└─ app/
   ├─ app.js           装配层：分栏、预览同步、状态栏
   └─ main.js          入口
```

## 三个关键设计

**1. 文本缓冲与视图解耦。** 编辑不直接改 DOM，而是走
`view → model.edit(offset, deleteCount, text) → buffer.applyEdit → 变更事件 → 视图重绘`。
视图只读 `getLineContent(n)`，因此同一份模型可以同时喂给编辑器、预览和校验器。

**2. 视口虚拟滚动。** 行的位置是纯算术：`top = PAD_TOP + (line - 1) * LINE_HEIGHT`。
只有视口内（含 8 行缓冲）的行存在 DOM 节点，其余用容器总高度占位。

**3. 预览是增量打补丁。** 渲染器输出每个块都带 `data-line`，
`morph.js` 把新 HTML 与现有 DOM 逐节点对比，只改真正变化的部分，
所以刷新预览不会丢滚动位置、不会重置图片解码、不会丢失选区。

## 打开方式

任意静态服务器指向本目录即可（本项目已带 `serve.js`）：

```bash
node serve.js          # 默认 http://127.0.0.1:5180
```

然后访问：

- `http://127.0.0.1:5180/` → 打开本文件
- `http://127.0.0.1:5180/?file=samples/demo.json` → 打开 JSON 样例

## 快捷键

| 快捷键 | 作用 |
|---|---|
| `Ctrl+S` | 导出当前文件 |
| `Ctrl+Shift+F` | 格式化（JSON） |
| `Ctrl+Z` / `Ctrl+Shift+Z` | 撤销 / 重做 |
| `Ctrl+A` | 全选 |
| `Tab` | 插入两个空格 |

## 与 Trae 的对应关系

| 本项目 | Trae CN 里的对应物 |
|---|---|
| `piece-tree.js` | `vs/editor/common/model/pieceTreeTextBuffer` |
| `text-model.js` | `TextModel` + `UndoRedoService` |
| `editor-view.js` | `vs/editor/browser/view` + `viewModel` |
| `highlighter.js` | `vscode-textmate` + `oniguruma.wasm`（本项目用行内正则替代） |
| `registry.js` | 各扩展 `contributes.languages` |
| `markdown-renderer.js` | `markdown-language-features` 的 markdown-it |
| `morph.js` | `morphdom` |
| `json-service.js` | `json-language-features` 的语言服务 |
| 侧面板 | `contributes.customEditors`（默认 `priority: option`） |
