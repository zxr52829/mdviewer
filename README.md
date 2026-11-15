# mdviewer

打开 **Markdown / JSON** 的最小文本编辑器，按 Trae CN（VS Code 1.107.1 定制版）的编辑架构同构实现。前端零依赖，另有 Go 宿主可打包成单文件 exe。

## 两种运行方式

**一、exe（推荐）**

```bat
cd desktop
build.bat              :: 构建无窗口 GUI 版
build.bat console      :: 构建带控制台的版本（排错用）
mdviewer.exe           :: 双击即用，打开独立原生窗口
```

exe 会：起回环 HTTP 服务（随机端口）→ 用 **WebView2 打开自己的窗口** → 提供文件树、读写、保存、系统文件框。所有前端资源 embed 在二进制里，单文件 7MB，无需安装任何东西。

**窗口是原生的，不是浏览器。** 没有地址栏、书签栏、标签页，标题栏只有窗口控件。关闭窗口即退出进程，不留后台服务。若本机缺 WebView2 运行时（Win10/11 通常随 Edge 预装），才回退到系统浏览器并打印提示。

> WebView2 只能在主线程创建并跑消息循环，所以 `runWindow` 会阻塞调用方。`-no-open` 时不创建窗口，用于脚本/调试场景。

**托盘图标**（窗口关闭后仍有服务在跑、或用 `-no-open` 启动时有用）：

| 操作 | 效果 |
|---|---|
| 双击托盘图标 | 在系统浏览器里打开当前地址 |
| 右键 → 打开 mdviewer | 同双击 |
| 右键 → 复制访问地址 | 把 URL 写入剪贴板 |
| 右键 → 退出 | 关服务并结束进程 |

> 正常用过原生窗口的话，关窗就已经退出，托盘不会残留。托盘里的「打开」走系统浏览器——那时窗口已经没了，只能借浏览器。

命令行参数：

| 参数 | 作用 |
|---|---|
| `-root D:\docs` | 指定工作根目录（默认：exe 所在目录） |
| `-file a.md` | 启动后直接打开文件 |
| `-port 8080` | 固定端口（默认随机空闲端口） |
| `-no-open` | 不创建窗口（脚本/调试用） |
| `-console` | 强制启用控制台输出（排错时用） |
| `-tray` | 强制启用托盘 |

工作区**不记忆**：每次启动都从 `-root` 或 exe 所在目录开始。切换工作区（`Ctrl+Shift+O` 或工具栏按钮）只影响当前进程，不落盘。

两种构建由 build tag 区分：`-tags gui` 产出 GUI 版（`isGUIBuild = true`，默认启用托盘），不带 tag 产出控制台版（打印地址与日志）。启动失败时 GUI 版会弹 MessageBox，不会静默消失。

### exe 构建依赖

```bash
# Go 1.25+；Windows 平台（WebView2 与 Win32 调用只在 windows 构建里编译）
go install github.com/tc-hib/go-winres@latest   # 生成 exe 图标资源，装进 .toolchain/gopath/bin
```

`build.bat` 会自动跑完整链路：`tools/mkicon` 画图标 → `tools/pngexport` 导出 PNG → `go-winres` 编资源 → `go build`。缺 `go-winres` 时只跳过资源（exe 没有文件图标），其余照常。

拉依赖如卡在 `proxy.golang.org`，设 `GOPROXY=https://goproxy.cn,direct`。

**二、纯静态（仅调试前端）**

```bash
node serve.js          # http://127.0.0.1:5180
```

静态模式下文件树隐藏、保存退化为浏览器下载——因为浏览器无法直接写本地文件。

## 测试

```bash
node test/run-tests.js # 186 项核心逻辑测试
```

## 分层

```
src/
├─ core/
│  ├─ piece-tree.js     文本缓冲：原文只读 + 增量 add 缓冲 + 片段表
│  └─ text-model.js     模型：行索引、编辑归一化、undo/redo
├─ lang/
│  ├─ registry.js       扩展名 → languageId
│  ├─ language-config.js 语言配置：词边界 / 自动闭合 / 缩进规则
│  ├─ edit-behavior.js  自动闭合、缩进、注释续行、成对删除
│  ├─ brackets.js       括号深度着色、配对查找、跨行深度传递
│  ├─ completion.js     补全候选生成（前缀识别 + 相关度排序）
│  ├─ symbol-library.js 内置符号库：C/C++/Python/Java/Go/JS 标准库
│  ├─ highlighter.js    tokenize（状态机）+ 三层标记合成
│  └─ json-service.js   校验 / 格式化 / 压缩 / 折叠范围 / 大纲
├─ view/
│  ├─ text-metrics.js   测量：Range 精测（定位）+ canvas 测宽（汇总）
│  ├─ find-highlight.js 查找命中：全文扫描 + 按行分组 + 逐字符遮罩
│  ├─ suggest-widget.js 补全下拉：定位、键盘导航、前缀高亮
│  └─ editor-view.js    视图：虚拟滚动、光标、选区、键盘、剪贴板
├─ preview/
│  ├─ markdown-renderer.js  md → HTML（每块带 data-line）
│  └─ morph.js          增量 DOM diff
└─ app/
   ├─ app.js            装配：分栏、文件树、预览同步、状态栏
   ├─ api.js            后端通信（exe / 静态双模式自适应）
   ├─ settings.js       设置定义、持久化、生效
   ├─ settings-panel.js 设置面板 UI
   ├─ resizer.js        可拖动分栏（侧栏 / 编辑区 / 预览）
   └─ main.js           入口

desktop/                Go 宿主
├─ main.go              embed 资源 + 回环服务 + 文件 API
├─ window_windows.go    原生窗口（WebView2，GUI 构建）
├─ windowicon_windows.go 运行时设置窗口/任务栏图标（ICO → HICON）
├─ iconembed_windows.go go:embed icon.ico
├─ window_other.go      非 GUI 构建的占位实现（恒失败，回退浏览器）
├─ tray_windows.go      托盘图标（纯 syscall 调 Win32，无第三方依赖）
├─ filedialog_windows.go 系统文件框（COM IFileOpenDialog，STA + owner 绑定）
├─ build_gui.go         GUI 构建标签：isGUIBuild = true
├─ build_console.go     控制台构建：isGUIBuild = false
├─ icon.ico             生成的图标（DIB 帧，7 个尺寸）
├─ rsrc_windows_amd64.syso  go-winres 生成的资源对象（exe 文件图标 + 版本信息）
├─ winres/winres.json   资源描述 + mkicon 导出的各尺寸 PNG
├─ go.mod
└─ build.bat            一键构建

tools/                  图标生成（独立模块，不参与 exe 构建）
├─ mkicon/main.go       画图标并输出 DIB 帧的 icon.ico
└─ pngexport/main.go    把 ICO 各帧导成 PNG，喂给 go-winres
```

第三方依赖：`github.com/jchv/go-webview2`（含 `go-winloader`、`golang.org/x/sys`）；构建期还需要 `github.com/tc-hib/go-winres`（装在 `.toolchain/gopath/bin`）。前端仍然零依赖。

### 图标是怎么进去的

图标有两条独立的路径，容易混：

**exe 文件图标（资源管理器里看到的）** 只能靠 PE 资源节里的 `RT_GROUP_ICON`。`go-winres` 负责生成 `rsrc_windows_amd64.syso`，`go build` 会自动链接同目录下的 `.syso`。顺带把 `FileDescription` / `ProductName` / 版本号写进 `RT_VERSION`。

**运行时窗口与任务栏图标** 走代码：`go:embed` 把 `icon.ico` 编进二进制，开窗后 `CreateIconFromResourceEx` 转成 `HICON` 再 `WM_SETICON`。

两条都留的原因是：资源节决定"文件长什么样"，运行时设置决定"窗口长什么样"，后者不依赖前者。早先试过只用手写 `.syso` 走资源节，失败原因是资源目录里数据项存的是相对 `.rsrc` 节起点的 RVA，链接器合并时会移动该节却不重写这些偏移，图标静默失效——所以生成 `.syso` 必须交给 `go-winres`，不能手拼。

注意 `go-winres` 不认 DIB 帧的 ICO（报 `unknown format`），只吃 PNG，所以构建链路里多了一步 `pngexport`。这也是为什么 `mkicon` 输出 DIB 帧（Windows 需要）而 `winres/` 里是 PNG（go-winres 需要）。

## 设置项

面板里 13 项，全部即时生效并持久化到 localStorage：

| 项 | 说明 |
|---|---|
| 字号 / 行高 / 字体 | 改动会**重新实测字符宽度**，光标与选区自动校准 |
| 主题 | 深色 / 浅色，切换后语法配色同步变化 |
| 制表符宽度 | 同时影响 Tab 键插入与制表符显示 |
| 自动闭合括号 | 输入 `( [ { "` 自动补全另一半 |
| 回车自动缩进 | 按语言缩进规则继承上一行 |
| 查找高亮 | 选区文字在全文标黄 |
| 显示空白字符 | 不显示 / 仅选区 / 总是 |
| 高亮当前行 | 光标行加浅底 |
| 光标闪烁 | 关闭后常亮 |
| 括号配对配色 | 按嵌套深度着色 |
| 自动保存 | 停止输入 1 秒后写回（仅 exe 模式） |

## 三个关键设计

**1. 模型与视图解耦。** 编辑走 `view → model.edit(offset, deleteCount, text) → buffer.applyEdit → 变更事件 → 重绘`。视图只读 `getLineContent(n)`，同一份模型同时喂给编辑器、预览和校验器。

**2. 定位靠 Range 实测，不靠宽度乘法。** 这是最容易写错的一层。

光标与选区的像素位置由 `Range.setStart/setEnd + getClientRects()` 对**已渲染的真实文本**测量得出。对应 Trae 里的 `RangeUtil._readClientRects`：

```js
range.setStart(firstTextNode, 0)
range.setEnd(targetNode, targetOffset)
rects.getClientRects() → 取最后一个 rect 的 right
```

为什么不能「字符宽度 × 列数」：等宽字体只保证 ASCII 同宽。实测 Consolas 13px 下 ASCII 7.617px、CJK 13px（比 1.706 而非 2），还叠加粗体、字体回退、tab-stop、emoji 组合。任何固定档位假设都会逐列累积误差——第 10 列偏 8px，第 50 列偏 39px。

canvas 测宽只用于**整行宽度汇总**（横向滚动范围），逐字符结果按字符缓存，职责等价于 Trae 的 `getCharWidth(char, font)`。

**3. 查找高亮是独立的标记层。** 选中一段文字后，文档里**所有**相同的文字都会标黄，对应 VS Code 的 `editor.findMatchHighlightBackground`。

关键点是它不能简单套一层背景：命中区间会在任意位置切断语法 token。所以渲染时先取「token 边界 ∪ 命中边界」的全部切点，逐段判断各自的 token 类型与是否命中，再拼出嵌套结构。否则要么整段 token 被染色，要么命中把语法着色切断后颜色丢失。

标记层只用 `background` + `box-shadow`，不碰 `padding`/`font`，所以不会改变字符宽度把定位带偏（已验证高亮字符宽度仍为 7.625px）。

生命周期与 VS Code 的 `_selectionIsEmpty` 对齐：**选区为空则高亮必须消失**。点击空白处、Esc、编辑导致选区消失，都会清掉全部黄色标记——早期版本把"保留到 Esc"当特性，结果原选中区域还留着黄底，看着像选区没清掉。唯一例外是「选中后直接打字替换」：用户意图是继续用同一个词查找，所以记下当时的词，编辑完按新内容重扫。

**4. 着色按 tmLanguage scope 分层，不只是"关键字一种颜色"。**

Trae 的颜色层次感来自 tmLanguage 定义的细粒度 scope，例如：

| scope | 语义 | 本项目 token |
|---|---|---|
| `support.type.property-name.json` | JSON 键名 | `key`（浅蓝） |
| `string.quoted.double.json` | 字符串值 | `string`（橙） |
| `punctuation.definition.string` | 引号本身 | `punct` |
| `constant.character.escape.json` | `\n` `\u1234` | `escape` |
| `constant.language.json` | `true`/`null` | `bool` |
| `punctuation.separator.*` | `:` `,` | `operator`（更暗） |
| `markup.bold.markdown` | 粗体内容 | `bold` |
| `punctuation.definition.bold` | `**` 标记符 | `markup-sign`（压暗） |

最关键的是**区分「标记符」与「内容」**：`**bold**` 里的 `**` 与 `bold` 不同色，`#` 与标题文字不同色。原版看起来层次分明就是因为这个。

实现上不能用一张平铺的正则表，得用状态机。平铺表会踩两个坑，本项都实际踩过：
1. 宽匹配抢占窄匹配（`[^"\\]+` 把整段吞成字符串，导致 `**粗体**` 不再被识别）
2. 前后文依赖无法表达（同一行的引号，在 `"name":` 里是键名边界，在 `"value"` 里是值边界）

状态机天然解决这两点，而 tmLanguage 的本质本来就是状态机（`begin`/`end` 配对 + `captures` 分层）。

**5. 括号深度必须跨行传递。** 第 N 行的起始深度取决于前 N-1 行的括号净增量。漏掉这步，每行都从 0 开始，所有括号都是第 0 层的同一颜色。所以每次编辑都要整体重算一遍深度表（文本量小时开销可忽略）。

**6. 别信初始化时的 clientWidth。** 视图构造时右侧预览面板通常还没打开，编辑器临时占满整幅宽度，据此算出的内容区宽度会接近真实值的两倍。必须由外部在分栏定稿后显式调用 `relayout()`；`ResizeObserver` 只作窗口缩放的兜底，它在后台标签或无头驱动下不保证触发。

**7. 分栏必须「一方占余量、一方定宽」。** 编辑区和预览同时 `flex-grow` 会按各自 `flex-basis` 比例分配空间，`1 1 auto` 的编辑区被 `1 1 50%` 的预览挤到只剩 200 多像素。正确做法：编辑器 `flex: 1 1 0%` 吃掉剩余，预览 `flex: 0 0 420px` 定宽。拖动时写内联 `flex` 必须带 `!important`（`setProperty` 第三参数），否则被 CSS 类的 `!important` 规则压回去，表现为「越拖越宽」。

**8. 输入必须挂在隐藏 textarea 上。** 这是本项目返工最多的一处。

浏览器只在**可编辑元素**上派发 `beforeinput`、`compositionstart/end` 等输入事件。给普通 `div` 加 `tabindex` 只能收到 `keydown`——单个英文字母能靠 `keydown` 拼出来，但中文输入法、粘贴、退格全都不工作，表现为「完全打不了字」。

正确做法（VS Code 同样如此）是一个 1×1、`opacity:0` 的 `<textarea>` 作输入代理：它是唯一可聚焦并接收字符的节点。注意不能用 `display:none`——那样连焦点都拿不到。

**关键：绝不要把 textarea 的 `value` 清空。** 这是本项目最隐蔽的一处。textarea 为空时，浏览器认为「没有内容可删」，Backspace / Delete 会返回成功但**不派发任何** `beforeinput` / `input` 事件，表现为「退格没反应、补全不更新」。正确做法是让 textarea **镜像当前行文本**，并把 `selectionStart/End` 放在与光标一致的偏移上——这样浏览器的删除、移动、输入都有真实作用对象。代价是 `input` 事件里的 `value` 不再是「新增字符」，而要用最长公共前后缀与模型行做差，才能还原出一次编辑。

配套的坑：光标显隐原来用 `.editor-scroll:not(:focus-within)` 控制，但真正的焦点在 textarea 上（不在 scroll 容器内），这条选择器让光标永久透明，看起来就是「光标不见了」。改为 `.editor-root.focused` 类，由 input 的 `focus`/`blur` 事件驱动。

**第三个坑：两条编辑路径必须共用同一个收尾。** keydown 里对 Backspace/Delete/Enter/Tab 做了 `preventDefault`，浏览器就不再派发 `beforeinput`——于是「按键路径」和「`beforeinput` 路径」是分开的两条。只要其中一条忘了刷新补全，就会出现「打字能补全、删除不更新」这种半好半坏的状态。现在统一收敛到 `_afterInputEdit()`：同步输入代理 → 重绘 → 刷新建议，两条路径都调它。

## 补全

补全候选来自三类来源，按相关度排序：

1. **文档内标识符**——JSON 只收键名，其他语言收普通标识符。用户自己写过的名字最相关，权重最高。
2. **标准库符号**——内置 6 种语言的符号表：C（`printf`/`malloc`）、C++（`std::vector`/`std::sort`）、Python（`print`/`os.path.join`）、Java、Go、JS/TS。每个约 100–160 个高频符号。
3. **语言关键字**与 **Markdown 片段**。

前缀识别支持限定符链：`std::ve`、`os.path.`、`a.b.c.` 都能正确切出前缀（`os.path.` 不会被截成 `.`）。

触发规则：输入字母后自动弹出；`Ctrl+Space` 手动触发；`↑↓` 导航、`Enter`/`Tab` 接受、`Esc` 关闭。前缀不足 2 字符时不弹（避免每敲一个字就打扰），但刚打完限定符时不限。

**与 Trae 的差距**：Trae 的补全来自语言服务（Pylance / clangd），有完整类型推断与跨文件符号。本项目是离线符号表 + 文档词频，能做「补全常用名」，做不了「补全某个对象的成员」。这是架构级差异，不是实现遗漏。

## 诊断：语法错误与警告标识

出错的字符画红色波浪线，行号旁标红点，状态栏显示 `✗ N`（可点击跳到下一个问题）。

**分级规则**（`src/lang/diagnostics.js`）：

| 情况 | 级别 | 来源 |
|---|---|---|
| JSON 家族解析失败 | error | `json` |
| 未闭合的字符串 / 块注释 | error | `lexer` |
| 未闭合的 `(` `[` `{` | error | `bracket` |
| 多余或类型错配的右括号 | warning | `bracket` |

判据是「这段代码还能不能解析」：不能就是 error，能但可疑就是 warning。

**与 Trae 的差距**：诊断同样不是语言服务。`highlighter.js` 是状态机词法分析器，不是解析器，因此：

| 能发现 | 发现不了 |
|---|---|
| 未闭合字符串 / 块注释 | `if (x { }` 括号位置错但数量对 |
| 括号不配对 | `def f(:` 参数列表错误 |
| — | `{a: 1,, b: 2}` 多余逗号 |

换句话说，**非 JSON 语言只做到词法级 + 括号配对**。真解析器要每种语言塞一个 parser（acorn / 手写递归下降），会毁掉「前端零依赖」这条底线，20 种语言也不可能都覆盖。JSON 家族是例外——它本来就是真解析，诊断是精确的。

这条边界和上面的补全说明同源：**能做的是「离线能判定的」，做不了的是「需要语义分析的」**。

**性能**：全量诊断在 9000 行文件上约 12ms，同步跑会吃掉一帧的 75%。所以走 300ms 防抖 + 按 `model.version` 缓存，编辑热路径（实测 0.02ms/键）不承担诊断开销。

## AI 选区改写

选中一段代码 → `Ctrl+K` → 写一句要求 → `Enter` 发送 → 看 diff → `Enter` 应用 / `Esc` 放弃。

**key 的存放位置是这个功能最要紧的设计点。** 仓库有公开镜像，所以：

| 位置 | 是否允许 | 原因 |
|---|---|---|
| 前端代码 / 构建产物 | 否 | 推送即泄露 |
| localStorage / 前端内存 | 否 | 任何页面脚本都能读 |
| 任何 `/api/*` 响应体 | 否 | 前端连回读都做不到，只能查「是否已配置」 |
| Go 侧配置文件 `%APPDATA%/mdviewer/ai.json` | 是 | 0600，只有本机当前用户可读 |
| 环境变量 `DEEPSEEK_API_KEY` | 是（优先） | 便于临时覆盖而不写盘 |

前端 `aiStatus()` 只拿到 `{configured, model, source}` 三个字段。实测校验过：DOM、localStorage、接口响应里都搜不到 key 明文。

**为什么必须走 Go 代理**：一是 key 不能进前端；二是浏览器直连 `api.deepseek.com` 会被 CORS 挡掉。两道原因指向同一个架构。

**交互上防的三件事**：

1. **版本失效**——从发请求到点应用之间文档可能被改过，此时原 offset 已指向错误位置。`apply()` 校验 `model.version`，不一致就拒绝并要求重选，宁可让用户重来也不覆盖不相干的文本。
2. **超大选区**——默认上限 40KB。超过既超模型有效上下文，也多半是误选（比如全选整个大文件）。前端先拦，不白跑一次 API。
3. **不可撤销**——应用走 `model.edit()`，天然进撤销栈，`Ctrl+Z` 一步回退。

**与 Cursor 的差距**：只做单轮选区改写，没有多轮对话、没有跨文件上下文、没有工具调用。`deepseek-chat` 也不是为代码补全微调的模型。这是「够用」而不是「对齐」。

## 已修的关键缺陷（都是真实踩到的）

| 现象 | 根因 | 修法 |
|---|---|---|
| 点击文字后光标跑到右边约 7 列 | `_hitTest` 横向基准是滚动容器，漏了 56px 行号栏 | 改用 `.editor-content` 的矩形作基准 |
| 选任何列都偏一个 padding 宽度 | Range 实测值已含行元素 `padding-left`，代码又加了一次 `PAD_LEFT` | 实测分支不再叠加 |
| 选区左边界伸进行首空白，文字像没被选住 | `columnToX(行, 1)` 返回 0 而非文字起点 12px | 改为量第一个字符的左边缘 |
| 中间行选区铺满超宽空白 | 内容区宽度按初始化时的未定稿布局算成 1358px（可视区仅 644） | 面板定稿后 `relayout()` 重算，且宽度可收缩 |
| 跨行选区首行左边、末行右边被多涂 | 用一个矩形从起点盖到终点 | 按视觉行拆多条矩形：首行到行尾、中间整行、末行从行首 |
| 修好错误后波浪线不消失 | 行 HTML 没变时不会触发 `innerHTML` 重绘，旧 overlay 留在地上 | `_applyDiagnosticMarks` 在无诊断时主动 `remove()` 掉 `.diag-layer` |
| 状态栏计数一直是空的 | 构造函数里 `_listeners` 少了 `diagnostics` 键，`_emit` 静默丢弃 | 补上该键 |
| 换文件后诊断不刷新 | `setValue` / 格式化走 `content` 事件，不走 `afterEdit` | `_onContentChanged` 也调度诊断 |
| 配了环境变量 key 却显示未配置 | `loadAIConfig` 在「配置文件不存在」时提前 return，跳过了环境变量覆盖 | 先读文件，再无条件应用 env 覆盖 |
| **一打开就被遮罩盖住、点哪都没反应、Esc 也关不掉** | `.ai-overlay` 是 `display:flex`，优先级高于浏览器默认的 `[hidden]{display:none}`，`hidden=true` 不生效，全屏遮罩一直吃事件 | 根上加 `[hidden]{display:none !important}` 兜底 |
| 同一段文字被标两次 | 浏览器原生选区叠加自绘高亮 | `user-select:none` + `::selection` 透明，复制改为键位驱动 |
| 上下移动后列号塌成 1 | 每次 `setCursor` 都把被行尾夹过的列写回「理想列」 | `keepDesired` 只让水平移动更新理想列 |
| 选区矩形不再显示 | 清空选区时 `innerHTML=''` 移除了节点，池子仍持有孤儿引用 | 只设 `hidden`，不摘除节点 |
| 插入字符吞掉整行 | 普通移动光标时留下了指向旧位置的零长度锚点 | 锚点只在 shift 扩展时建立 |
| 一次按键 18.7ms | `getValue()` 每次调用都重新拼接全文，定位逻辑高频依赖它 | 按 version 缓存全文，降至 3.4ms |
| 选中文字后其他相同文字没标黄 | 未实现查找高亮层 | 新增 `find-highlight.js`，选区即查找词，逐字符遮罩 |
| 高亮把语法着色切没了 | 命中区间与 token 边界不对齐 | 取两组边界的并集切段，再逐段嵌套 |
| 编辑后高亮闪断 | 清缓存时把查找词一并清掉 | 编辑后保留原词重扫 |
| 跨行选区被当成查找词 | 选区文本含换行符仍参与匹配 | 含 `\n` 时不做标记 |
| 点击空白处后原选区仍留黄底 | 把"保留高亮到 Esc"当特性，与 VS Code 的 `_selectionIsEmpty` 语义相反 | 选区为空即清全部标记 |
| 完全打不了字 | 输入事件挂普通 div，浏览器只在可编辑元素上派发 `beforeinput` | 改用隐藏 textarea 作输入代理 |
| 打得进字但光标不显示 | CSS `.editor-scroll:not(:focus-within)` 让光标永久透明（焦点在 textarea 上） | 改由 `.editor-root.focused` 类 + input 的 focus/blur 驱动 |
| 文件对话框能弹出但点确定/取消没反应 | COM 文件框是 STA 模态窗口，未 `LockOSThread` 就初始化，消息循环跑错线程 | 先锁 OS 线程再 CoInitializeEx + Show |
| 对话框文件名栏被填成目录路径 | 用 `SetFileName` 传 `"目录\"` 当作初始目录，这是错误用法 | 改用 `SetFolder` + `SHCreateItemFromParsingName` |
| 编辑器被预览挤到只剩 200 多像素 | 两者同时 `flex-grow`，按 flex-basis 比例分配 | 编辑器 `1 1 0%` 吃余量，预览 `0 0 420px` 定宽 |
| 拖动分栏越拖越宽 | 内联 `flex` 被 CSS 的 `!important` 规则压回去 | `setProperty('flex', v, 'important')` |
| `os.path.` 前缀被截成 `.` | 正则交替分支顺序错，纯限定符分支先命中 | 完整限定符链放前面 |
| `**粗体**` 不再被识别 | 平铺正则表里 `[^"\\]+` 宽匹配抢占了窄规则，整段被吞成字符串 | 改用状态机，按位置与前后文推进 |
| 键名与字符串值同色 | 只做"字符串"一种类型，未按 tmLanguage scope 分层 | 拆出 key/string/punct/escape/operator |
| 括号全是同一个颜色 | 算出了单行深度但未跨行传递，每行都从 0 开始 | 每次编辑重算全表起始深度 |
| 退格没反应、补全不跟着变 | textarea 的 `value` 被清空，浏览器认为"无内容可删"，Backspace 返回成功但不派发 `beforeinput`/`input` | `_syncInputValue` 改为镜像当前行并把 selection 放到光标位置 |
| 删掉字母后补全列表不更新 | 编辑收尾只调 `afterEdit()`，没有刷新建议；键盘分支 `preventDefault` 后浏览器不再派发 `beforeinput`，绕过了唯一会刷新列表的路径 | 抽出 `_afterInputEdit()`（同步 → 重绘 → 刷新建议），keydown 与 beforeinput 两条路径统一走它 |
| 补全列表开着时按 Delete 出现串字乱码 | 键未被拦截，浏览器对 textarea 执行默认删除，`_onInputFallback` 把"textarea 与当前行的差异"当成新输入合进模型 | 浮层分支显式拦截 Backspace/Delete 并走模型 |
| 空前缀列出文档里所有标识符 | `matchScore` 对空前缀一律返回 1（那是留给「限定符之后」的兜底），空前缀时变成无条件全量 | 前缀为空直接返回空列表 |
| 列表已隐藏，无障碍树里仍有选项 | `hide()` 只设 `hidden`，上一轮的 `.suggest-item` 残留在 DOM 里 | `hide()` 同时清空子节点 |
| 点「新建」毫无反应 | 依赖 `window.prompt`，它在部分 Chromium / Electron 环境被禁用，直接返回 `null`，且无任何错误可查 | 换成应用内输入弹层，默认值选中文件名主体、保留扩展名 |
| 每次启动打开都是空白目录 | root 默认取 `os.Getwd()`；从快捷方式/别的目录启动时 cwd 各不相同 | 优先级改为：命令行 `-root` > 上次工作区 > exe 所在目录 > cwd；上次工作区记在用户配置目录 |
| 选了工作区仍是一片空白 | 切换后不校验目标目录里有没有可编辑文件，空目录与"程序坏了"无法区分 | `/api/root` 回传 `editable` / `subdirs` 计数，前端据此给出具体提示 |
| 目录选择框弹出但看不见 | `vtShow(0)` 的对话框不归属任何窗口，常被浏览器盖住 | 托盘缺失时用本进程前台窗口作 owner，并另起协程把窗口拉到最前 |
| exe 打开后是浏览器，带地址栏和标签页 | 只调了 `openBrowser()`，那是「把 URL 交给默认浏览器」，不是「开自己窗口」 | GUI 构建改用 WebView2 原生窗口，关窗即退出；缺运行时才回退浏览器 |
| 程序没有图标，exe 和窗口都是系统默认图标 | exe 图标只能由 PE 资源节提供，手写 `.syso` 的 RVA 不会被链接器重定位，资源结构合法但指向错位置，系统静默回退 | 用 `go-winres` 生成 `.syso`（自带重定位）；窗口/任务栏图标另走运行时 `CreateIconFromResourceEx` + `WM_SETICON` |
| `go-winres` 报 `image: unknown format` | 它只解析 PNG，不认 DIB 帧的 ICO | 构建链路加一步 `pngexport`，把 ICO 各帧导成 PNG 放进 `winres/` |

## 与 Trae 的对应关系

| 本项目 | Trae CN 里的对应物 |
|---|---|
| `piece-tree.js` | `vs/editor/common/model/pieceTreeTextBuffer` |
| `text-model.js` | `TextModel` + `UndoRedoService` |
| `editor-view.js` | `vs/editor/browser/view` + `viewModel` |
| `text-metrics.js`（Range 精测） | `RangeUtil._readClientRects` / `readHorizontalRanges` |
| `text-metrics.js`（canvas 测宽） | `getCharWidth(char, font)` + `_canvas.measureText` |
| `find-highlight.js` | `editor.findMatchHighlightBackground` + FindModel |
| `highlighter.js` | `vscode-textmate` + `oniguruma.wasm`（此处用状态机替代） |
| `language-config.js` | `language-configuration.json`（词边界 / 自动闭合 / 缩进规则） |
| `edit-behavior.js` | `AutoClosingBracketController` + `TypingActions` |
| `brackets.js` | `bracketPairColorization` + `editorBracketHighlight.foreground1..3` |
| `registry.js` | 各扩展 `contributes.languages` |
| `markdown-renderer.js` | `markdown-language-features` 的 markdown-it |
| `morph.js` | `morphdom` |
| `json-service.js` | `json-language-features` 的语言服务 |
| 侧面板 | `contributes.customEditors`（`priority: option`） |

## 快捷键

| 快捷键 | 作用 |
|---|---|
| `Ctrl+S` | 保存（exe 写回原文件） |
| `Ctrl+N` | 新建文件 |
| `Ctrl+O` | 打开文件（系统文件框，仅 exe；可选工作区外文件，自动切换工作区） |
| `Ctrl+Shift+O` | 切换工作区目录 |
| `Ctrl+Shift+F` | 格式化（JSON） |
| `Ctrl+Z` / `Ctrl+Shift+Z` | 撤销 / 重做 |
| `Ctrl+A` | 全选 |
| `Ctrl+D` | 选中下一个相同词 |
| `Ctrl+Space` | 手动触发补全 |
| `↑` `↓` | 补全列表导航 |
| `Enter` / `Tab` | 接受补全（列表打开时） |
| `Ctrl+C` / `Ctrl+X` | 复制 / 剪切选区 |
| `Tab` | 插入缩进 |
| `Esc` | 取消选区 / 清除高亮 / 关闭设置 |

## 性能（8999 行 / 180K 字符实测）

| 操作 | 耗时 |
|---|---|
| 载入并首次渲染 | 18 ms |
| 滚动一屏 | 5–9 ms |
| 单次按键 | 3.4 ms |
| `getValue` × 1000 | 0.4 ms |
| 光标定位 × 200 | 2.6 ms |

DOM 行节点恒定在 49–59 个，与文件行数无关。
