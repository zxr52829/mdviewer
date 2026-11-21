# 交接：诊断 / AI 改写 / 跨文件补全

给下一个对话。读完这一份就能接手，不必回溯历史。

写于 2026-11-16 的第一次大更新（第二轮）。上一版写于 11-15，只覆盖诊断与 AI 改写；
此后三轮修的缺陷与新增的跨文件补全已补进本文，**旧版里「224 条测试全绿」那句
当时是事实，但绿得没有意义** —— 缺陷全在测试覆盖之外。

## 一句话现状

三个功能可用，测试 302 条全过，两库已推送，工作区干净。

```
73b5a24  feat(mdviewer): 跨文件补全——工作区符号索引
8ce0c1c  test(mdviewer): 自扫测试——仓库源码零诊断
9941d69  fix(mdviewer): 识别正则字面量与嵌套模板，消除全部误报
d7354d1  fix(mdviewer): 诊断四处误报 + AI 改写失效校验加固
a7c82cd  docs(mdviewer): 交接报告（上一版 NEXT.md）
```

测试：**302 / 302 通过**（224 → 252 修诊断缺陷 → 254 加自扫 → 302 加索引）。

## 两个仓库

| 位置 | 用途 | HEAD |
|---|---|---|
| `F:\xmdsh-two` | 私有主开发库 | `73b5a24` |
| `github.com/zxr52829/mdviewer` | **公开镜像** | `3826f7b` |

镜像 HEAD 每次同步都会变，**别信这张表，用 `git ls-remote` 查**。

两边**独立历史**，改完要分别提交推送。移植方式整文件 `cp`：

```bash
cd /f/xmdsh-two && rm -rf .sync && mkdir .sync && cd .sync
git init -q -b main && git remote add origin https://github.com/zxr52829/mdviewer.git
git fetch -q origin main && git reset -q --hard origin/main
cp ../mdviewer/<改过的文件> <对应位置>
node test/run-tests.js          # 先在镜像副本验一遍
git add -A && git commit -m "..." && git push origin main
cd /f/xmdsh-two && rm -rf .sync  # 必须删，否则 pre-push 自检会拦「根目录杂物」
```

`.sync/` 已写进 `.gitignore`，但 `scripts/selfcheck.mjs` 会拦根目录杂物，**推主库前必须删掉**。

## 功能一：语法错误诊断

验收全部通过。

**行为**：出错字符画红色波浪线 → 行号旁红点 → 状态栏 `✗ N`（可点击跳下一个问题）。

**分级规则**（`src/lang/diagnostics.js`）：

| 情况 | 级别 | source |
|---|---|---|
| JSON 家族解析失败 | error | `json` |
| 未闭合的字符串 / 块注释 | error | `lexer` |
| 未闭合的 `(` `[` `{` | error | `bracket` |
| 多余或类型错配的右括号 | warning | `bracket` |

判据是「这段代码还能不能解析」。不能就是 error，能但可疑就是 warning。

**架构要点**：

- JSON 家族直接包装既有 `json-service.js` 的 `validate()`，真解析器，位置精确
- 其余语言走**带跨行状态传递**的词法扫描 + 括号配对
- 装饰走独立 overlay（`.diag-layer` + 实测矩形），**没有**并入 `renderLineHtml` 的三层边界并集 —— 走那条路要跟 token/match/bracket 三层切割对齐，改动面翻倍
- 防抖 300ms（`DIAG_DEBOUNCE`），按 `model.version` 缓存；9000 行全量扫描 12ms，不能放热路径

**性能实测**：编辑热路径 0.02ms/键（基线要求 3.4ms 以内）；连打 20 次 0 次诊断，停手后 1 次；滚动不触发重算。

## 功能二：AI 选区改写

选中 → `Ctrl+K` → 输入要求 → `Enter` → 看 diff → `Enter` 应用 / `Esc` 放弃。

**为什么必须走 Go 代理**（两条独立原因，指向同一架构）：

1. 仓库有公开镜像，key 进前端代码等于泄露
2. 浏览器直连 `api.deepseek.com` 会被 CORS 挡掉

**key 的存放边界**（实测校验过）：

| 位置 | 允许 | 说明 |
|---|---|---|
| 前端代码 / 构建产物 | 否 | 推送即泄露 |
| localStorage / 前端内存 | 否 | 任何页面脚本可读 |
| 任何 `/api/*` 响应体 | 否 | 前端只能查「是否已配置」 |
| `%APPDATA%\mdviewer\ai.json` | 是 | 0600 |
| 环境变量 `DEEPSEEK_API_KEY` | 是（优先） | 便于临时覆盖 |

实测：DOM、localStorage、接口响应里都搜不到 key 明文。

**三道防护**：

- **版本失效** — `apply()` 校验 `model.version`，请求期间文档变了就拒绝应用。原 offset 已失效，硬覆盖会吃掉不相干的文本
- **选区上限** — 前端默认 40KB（设置里可调到 200KB），Go 侧 200KB 是绝对底线。前端先拦，不白跑 API
- **可撤销** — 应用走 `model.edit()`，天然进撤销栈，`Ctrl+Z` 一步回退

**实测数据**：3 行函数改成箭头函数 = `171 + 17 tokens`。超限拦截提示：「选区 113.3KB，超过上限 40KB」。

## 功能三：跨文件补全（第二轮新增）

对齐 Trae 的 CUE 上下文补全。原补全只统计**当前文档**词频，跨文件调用全靠记忆手打 —— 这是功能面上最实际的一处差距。

新模块 `src/lang/workspace-index.js`（325 行，纯函数无 IO 无 DOM）。`EditorView.setCompletionSource()` 只收一个纯函数，视图不知道索引存在；App 负责递归列目录、读文件、建索引与失效。懒建，换工作区或保存后重建，设置 `ai.workspaceIndex` 可关闭。

**这不是语言服务，边界要守住**：只有名字级索引，没有类型推断、没有跳转定义、没有成员补全（`obj.` 之后列不出方法）。抽取靠正则，解构与动态导入抽不到 —— 漏，但不错。

四个实测发现（都是跑出来才发现的）：

1. `desktop/web/` 是 go:embed 拷贝目录，扫进去同一符号出现两次，「+1」来源计数是假的。索引文件数从 79 降到真实的 47
2. 注释里的示例代码被当真实声明 —— 本模块自己的注释写了「`const err = ...`」，`err` 就进了候选。抽取前先剥注释（等长替换，行号不错位）
3. Go 用 tab 缩进，只认空格把 `ai.go` 判成「全部顶层」，35 个符号里 22 个是 `err`/`cfg`/`body`。修好后回到 13 个
4. `styles.css` 贡献 165 个选择器占全部符号四成，在 .js 里补全时把有用名字全挤走。按语言过滤后 JS 里 CSS 混入为 0

实测：47 个文件 406 个符号名，建索引 168ms，无截断。

## 第二轮修的缺陷

用仓库自己的源码做真实扫描才发现：诊断误报率是 **100%**（27 个 .js 里 6 个报错、46 条）。当时 224 条测试全绿，因为**每条用例都是自己构造的**，构造不出的语法结构就测不到。

| 缺陷 | 症状 | 根因 |
|---|---|---|
| 未追踪模板字符串 | `` const t = `a(b` `` 报未闭合括号 | `traits.template` 声明了却从未被读取 |
| CSS 把 `//` 当行注释 | `url(http://…)` 后面的括号全部错配 | CSS 里 `//` 是无效语法 |
| YAML 撇号 | `msg: don't stop` 报未闭合字符串 | 值中间的撇号被当字符串开头 |
| 未闭合块注释位置偏移 | 行尾最后两个正常字符被划进波浪线 | 列号少算一格 |
| **正则字面量** | `/[&<>"]/g` 同时误报括号与字符串 | `/` 被当除号，`[` 与 `"` 当语法符号 |
| **嵌套模板** | `` push(a, `<ul>${m(t => `<li>${t}</li>`)}</ul>`) `` 整段错位 | 布尔态 `inTemplate` 在内层反引号处关闭 |

后两条是大头。正则用词法器的标准启发式（前一个有效字符决定正则还是除号），判不准时**退回除法** —— 宁可漏报，不在正确代码上画红线。嵌套模板改成栈，每层记自己的插值括号计数。

AI 侧：`apply()` 加第二道失效校验（除 version 外再比对目标区间实际文本，防「改了又撤销」）；差异只剩末尾空行时不再渲染空白 diff（LCS 会记空文本 add，界面显示 `+1 −0` 却看不出变化）；`.ai-wide` 此前只被 remove 从未被 add，是死代码。

Go 侧见上面「其它实测 bug」表最后一行。

## 自扫测试（重要，别删）

`test/run-tests.js` 末尾的「自扫：仓库源码零误报」遍历仓库全部 `.js/.mjs/.json/.css/.go`，逐个过 `collectDiagnostics`，断言零条。

**它的价值在于会失败**。已实测：放进用 JSX 的 .js 会红、放进未闭合花括号的 .go 会红，并精确报出文件与首条位置。同时断言「找到 ≥20 个文件」，防止路径算错导致静默空转、永远绿。

范围是实测校正过的：`desktop/` 必须扫（Go 有诊断能力），`.md/.html` 不扫（恒返回空，空跑）。改之前先读那段注释。

## 本次踩到的三个真实坑（都已修，别重犯）

### 1. `[hidden]` 被 `display` 覆盖（最严重，用户报障）

`.ai-overlay` 写 `display:flex`，优先级高于浏览器默认的 `[hidden]{display:none}`。`hidden=true` 完全不生效，全屏遮罩 `position:fixed; inset:0` 一直吃事件 —— 表现为**一打开就盖住编辑器、点哪都没反应、Esc 也关不掉**。

同一个坑项目里此前踩过 **8 次**（`.sidebar` / `.editor-selection` / `.resizer` / `.side-panel` / `.suggest-widget` / `.settings-overlay` / `.prompt-overlay` / `.prompt-error` 各写一条 `.{class}[hidden]` 补丁）。我写 `.ai-overlay` 时漏了这条，原样复现。

**修法**：CSS 根加 `[hidden] { display: none !important; }` 全局兜底。旧补丁保留（已被覆盖、无冲突，删要动 8 处既有代码，风险不抵收益）。

```css
/* 新组件一律不用再写 .xxx[hidden]{display:none} */
[hidden] { display: none !important; }
```

### 2. 跨行块注释掩码（诊断的正确性关键）

`brackets.js` 的 `scanLineBrackets` 每次调用都把 `inBlock` 重置为 false，**只跨行传 `depth`**。直接拿它做诊断，多行块注释里的括号会被当成代码，全部误报。

**所以诊断层自己写了扫描器**维护 `inBlock` / `inString` / `quote` / `stringStart` 四个跨行状态。这是 `diagnostics.js` 存在的核心理由，别想着「复用 brackets.js 就省事了」。

回归测试已覆盖：`/*\n  foo( bar\n*/\nconst y = 1;` 不报括号错。

### 3. 环境变量 key 读不到

`loadAIConfig` 在「配置文件不存在」分支提前 `return cfg, nil`，跳过了后面的环境变量覆盖。症状：`source:env` 但 `configured:false` 自相矛盾。

**修法**：先读文件（不存在不算错），再**无条件**应用 env 覆盖。

## 其它实测抓到的 bug（已修）

| 症状 | 根因 | 修法 |
|---|---|---|
| 修好错误后波浪线不消失 | 行 HTML 没变就不触发 `innerHTML` 重绘，旧 overlay 留在地上 | 无诊断时主动 `remove()` 掉 `.diag-layer` |
| 状态栏计数一直空 | 构造函数 `_listeners` 少了 `diagnostics` 键，`_emit` 静默丢弃 | 补上该键 |
| 换文件后诊断不刷新 | `setValue` / 格式化走 `content` 事件，不走 `afterEdit` | `_onContentChanged` 也调度诊断 |
| 「改成箭头函数」模型原样返回 | 系统提示词给了「无法完成就输出原文」的偷懒出口 | 第一版收紧为「只有语法上完全无法套用才原样输出」——**但这句本身成了新的出口**，第二轮已彻底移除，改为「指令与代码完全无关才允许原样返回」 |

## 关键文件

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/lang/diagnostics.js` | 537 | 诊断收集。JSON 包装 `validate()`，其余走带状态的词法+括号扫描（含正则字面量与嵌套模板状态机） |
| `src/lang/workspace-index.js` | 325 | 跨文件符号索引。纯函数无 IO：抽符号、建索引、按前缀查询 |
| `src/app/ai-panel.js` | 368 | 改写面板：指令输入、diff 渲染、应用/放弃 |
| `src/app/line-diff.js` | 81 | 行级 LCS diff。**无依赖，可脱离 DOM 单测** |
| `desktop/ai.go` | 425 | DeepSeek 代理。key 只在此进程与本机文件流转 |
| `src/view/editor-view.js` | 2099 | 诊断调度、overlay 绘制、`_updateLine` 缓存键、补全候选注入点 |
| `src/app/app.js` | 1034 | AI 面板 / Ctrl+K / 诊断渲染 / 工作区索引的建立与失效 |
| `test/run-tests.js` | 1028 | 302 条测试含自扫（遍历仓库源码断言零误报） |
| `styles.css` | — | `[hidden]` 兜底、`.diag-*`、`.ai-*` |

## 构建

```bash
cd /f/xmdsh-two/mdviewer/desktop
export PATH="/f/xmdsh-two/.toolchain/go/bin:$PATH"
export GOCACHE=/f/xmdsh-two/.toolchain/gocache
export GOPATH=/f/xmdsh-two/.toolchain/gopath
export GOPROXY=https://goproxy.cn,direct
rm -rf web && mkdir -p web && cp -r ../index.html ../styles.css ../src ../samples web/
go build -tags gui -trimpath -ldflags "-s -w -H windowsgui" -o mdviewer.exe .
```

`go vet` 会报 `tray_windows.go:401` 的 unsafe.Pointer 警告 —— **既有代码，不是本次引入的，我没动**。

本地调试用 `./mdviewer.exe -console -port <端口>`，可看启动日志。

## 已知未做 / 边界

- **非 JSON 语言只做到词法级 + 括号配对**。`if (x { }` 这类括号数量对但位置错的发现不了。真解析器要每种语言塞一个 parser，会毁掉「前端零依赖」底线
- **诊断器的正则判别有已知漏报**：`a = b` 换行后接 `/re/.test(c)` 这类会退化成除法理解。这是刻意的取舍（漏 > 误），别当 bug 修
- **JSX / 装饰器等语法未支持**。写进仓库会让自扫测试红 —— 这是设计意图，逼着补支持
- **AI 只做单轮选区改写**。没有多轮对话、没有跨文件上下文、没有工具调用
- **跨文件补全没有跳转定义**。索引里已有 path/line/kind，缺的只是「点了就跳」那一步；但它会突破「名字级索引」的自觉边界，要做先想清楚
- `deepseek-chat` 不是为代码微调过的模型。简单重构稳定，复杂跨函数调整可能要试两三次
- 模型偶尔仍会吐 ``` 围栏，`stripCodeFence` 兜了一层
- **没有可视化回归测试**。`[hidden]` 那个 bug 就是「单测全绿但真实浏览器全屏遮罩」的典型。加截图比对要引依赖，与零依赖底线冲突

## 工作守则（本仓强制）

- **除工作区外一个字节都不许动**，全部落 `F:\xmdsh-two`
- 破坏性操作先备份（`scripts/backup.ps1 -Name "..."` 压 7z 到 `.system-backup/archives/`）
- 交付件修改前先 `read`，`write` 前必须先 `read`
- 跑不了的验证要明说，结论无证据写 `unknown`，不写「大概」
- 改前先立 `todo_write` 清单，完成一项标一项
- 推送主库前删 `.sync/`，否则自检拦截

## 待办任务（按优先级，含依赖）

用户尚未指定下一个。以下是按「成本 × 收益」排的候选，**动手前先问要哪个**。

| # | 任务 | 成本 | 依赖 | 备注 |
|---|---|---|---|---|
| 1 | **Rules 项目规则** | 低 | 无 | 对齐 Trae 的 `.trae/rules/`。把「用中文说明」「不引框架」写一次生效，与本项目 AI 改写天然契合 |
| 2 | **从索引做跳转定义** | 中 | 跨文件补全（已完成） | 索引已有 path/line/kind，缺调用点。会突破「名字级索引」边界，需先决策 |
| 3 | AI 多轮对话式改写 | 高 | 无 | 架构变化，要重设计面板 |
| 4 | 非 JSON 语言括号位置检查 | 高 | 无 | 收益有限，会破坏零依赖 |
| 5 | 可视化回归测试 | 中 | 需先决策 | 与零依赖冲突 |

**排序理由**：1 成本最低且能立刻被用到；2 是已有工作的自然延伸但要先过边界那道判断；3 之后都是架构级改动。想更快见效就从 1 起。

「臃肿了」这类说法可能指体积、结构或认知负担，三个答案三种动作 —— 先问清楚。
