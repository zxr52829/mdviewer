# 交接：语法错误提示与警告标识

给下一个对话。读完这一份就能接手，不必回溯历史。

## 要做的功能

编辑器里标出语法错误，并在状态栏显示数量（"错了 N 个"）。

用户原话：「语法错误提醒还有警告标识（错了几个）」。

拆成三件事：

1. **行内标记**：出错的字符区间画红色波浪下划线
2. **装订线标记**：出错行的行号旁显示红点/图标
3. **状态栏计数**：显示 `✗ N`，点击可跳到下一个错误

## 当前代码状态

仓库：`F:\xmdsh-two`（私有，主开发库）/ https://github.com/zxr52829/mdviewer （公开镜像）

两边是**独立历史**，改完要分别提交推送。移植方式是整文件 `cp`：

```bash
cd /f/xmdsh-two && rm -rf .sync && mkdir .sync && cd .sync
git init -q -b main && git remote add origin https://github.com/zxr52829/mdviewer.git
git fetch -q origin main && git reset -q --hard origin/main
cp ../mdviewer/<改过的文件> <对应位置>
git add -A && git commit -m "..." && git push origin main
```

最新提交：`f56ed43`（两边内容一致）。测试 186/186 通过。

| 位置 | 现状 |
|---|---|
| `src/lang/json-service.js` | `validate()` 第 68 行，已返回 `{valid, errors:[{line, column, length, message}]}` |
| `src/view/editor-view.js` | 有 `updateFindHighlight` 系列的装饰层，可照抄模式 |
| 状态栏 | `index.html` 第 83-88 行：`#statusLeft` → spacer → `#posLabel` / `#sizeLabel` / `#langLabel` |
| 语言支持 | `registry.js` 20+ 扩展名，但只有 JSON 家族有真校验 |

## 已具备的基础

`validate()` 的输出结构正好是需要的形状，直接复用：

```js
// src/lang/json-service.js:68
export function validate(text, languageId = 'json') {
  // 返回 { valid, errors: [{ line, column, length, message }], value }
}
```

JSON / JSONC / JSON5 / JSONL 已有完整校验（含注释剥离、尾逗号处理、行列定位）。

## 核心难点：非 JSON 语言没有校验器

这是本次功能的真正工作量所在，先说清楚，别低估。

`highlighter.js` 是**状态机词法分析器**，不是解析器。它能发现词法级错误，发现不了语法级错误：

| 能发现（词法） | 发现不了（语法） |
|---|---|
| 未闭合的字符串 `"abc` | `if (x { }` 括号不配对 |
| 未闭合的块注释 `/* ...` | `def f(:` 参数列表错误 |
| 非法的转义序列 | `{a: 1,, b: 2}` 多余逗号 |

所以有两条路，必须选一条：

**路线 A：只做词法级（成本低，1-2 小时）**
复用 `highlighter.js` 的 tokenize 结果，收集未闭合的字符串/注释作为"警告"（黄色），不算"错误"（红色）。诚实、零误报，但覆盖窄。

**路线 B：词法 + 括号配对（推荐，半天）**
词法级错误 + `brackets.js` 的 `scanLineBrackets` / `findMatchingBracket` 做括号配对检查。能覆盖最常见的 `( [ {` 不配对。仍然做不了表达式级语法。

**路线 C：引入真解析器（不推荐）**
每种语言塞一个 parser（acorn / esprima / 手写递归下降）。会毁掉"前端零依赖"这条设计底线，且 20 种语言不可能都覆盖。

建议路线 B。README 里已有一条同性质的说明（补全是离线符号表不是语言服务），新功能的诚实边界应写在同一个位置。

## 实现方案

### 1. 新建 `src/lang/diagnostics.js`

```js
export function collectDiagnostics(text, languageId) -> Array<{
  severity: 'error' | 'warning',
  line: number,      // 1-based
  column: number,    // 1-based
  length: number,
  message: string,
  source: 'json' | 'lexer' | 'bracket',
}>
```

JSON 家族直接包装 `validate()`，把 `errors` 转成 `severity: 'error'`。
其它语言走词法 + 括号检查，按严重程度分级。

### 2. 视图层加装饰

照 `updateFindHighlight` 的模式做，**不要**另立一套渲染路径。三层标记已经靠边界并集合成，新加一层要么并入那个并集，要么用独立 overlay（波浪线用 CSS `text-decoration` 更省事）。

关键：`_lineEls` 里每行是 `{row, gutter, content}`，装订线标记直接往 `gutter` 里塞子元素。

### 3. 防抖

诊断必须防抖（建议 300ms）并只在空闲时跑。当前性能基线是一次按键 3.4ms，同步跑全量诊断会直接掉帧。

### 4. 状态栏

`app.js` 的 `_updateStatus()` 里加计数。`0` 个错误时不显示，避免噪音。

## 边界与陷阱

- **不要**在 `renderVisible` 里同步跑诊断，那是渲染热路径
- 诊断结果要按 `model.version` 缓存，未改动时直接复用
- 大文件（README 提到 8999 行基线）必须限制诊断范围或做增量
- 波浪线用 `text-decoration: underline wavy` 比画绝对定位的 SVG 便宜得多，但无法控制单个字符高度——先试 CSS 方案
- 错误区间跨行时（如未闭合字符串），只标到行尾，不要跨行画

## 验收标准

1. 打开有语法错误的 JSON，对应字符下有红色波浪线，行号旁有红点
2. 状态栏显示错误数量；修好后计数归零且标记消失
3. 切换文件后标记不串（上一文件的错误不能留在新文件上）
4. 186 项既有测试仍全过：`node test/run-tests.js`
5. 打开 9000 行文件，滚动不卡；输入时不掉帧（基线 3.4ms/键）

## 构建与推送

```bash
# 构建（需仓内 Go 工具链，见 README「exe 构建依赖」）
cd /f/xmdsh-two/mdviewer/desktop
export PATH="/f/xmdsh-two/.toolchain/go/bin:$PATH"
export GOCACHE=/f/xmdsh-two/.toolchain/gocache
export GOPATH=/f/xmdsh-two/.toolchain/gopath
export GOPROXY=https://goproxy.cn,direct
rm -rf web && mkdir -p web && cp -r ../index.html ../styles.css ../src ../samples web/
go build -tags gui -trimpath -ldflags "-s -w -H windowsgui" -o mdviewer.exe .

# 推送 xmdsh-two（有 pre-push 自检，根目录白名单在 scripts/selfcheck.mjs）
cd /f/xmdsh-two && git add -A && git commit -m "..." && git push origin main
```

## 容易踩的坑（都是真实踩过的）

**输入代理**：真正的输入焦点在一个 1×1 的隐藏 `<textarea>` 上，它的 `value` 必须**镜像当前行文本**。清空它会导致 Backspace 静默失效（浏览器认为无可删，不派发 `beforeinput`）。

**两条编辑路径**：keydown 对 Backspace/Delete/Enter/Tab 做了 `preventDefault`，浏览器就不再派发 `beforeinput`。任何"编辑后要做的事"必须收敛到 `_afterInputEdit()`，只挂一条路径会出现"打字触发、删除不触发"的半好半坏状态。

**像素几何**：所有位置必须来自 `Range` 实测，不能用「字宽 × 列号」推算。CJK 混排会漂移，之前修过一次 21.53px 的偏移。

**不要读 `.agent-teams` 或 plugin 源码**改计划；不要在本仓外写任何文件（含 C 盘、Temp）。
