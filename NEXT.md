# 交接：语法诊断 + AI 选区改写

给下一个对话。读完这一份就能接手，不必回溯历史。

写于 2026-11-15。上一份交接是 `NEXT.md`（诊断功能的规划稿），其内容已全部落地，只需在新工作中查阅，不必再执行。

## 一句话现状

两个功能都已完成、测试通过、两库已推送。工作区干净，无未提交改动。

```
9af3522  fix(mdviewer): AI 遮罩层 hidden 失效导致一打开就盖住编辑器
82d76b9  feat(mdviewer): AI 选区改写（Ctrl+K）——diff 预览 + 可撤销
c240e5e  feat(mdviewer): 语法错误诊断——波浪线 + 装订线红点 + 状态栏计数
70a0e46  docs(mdviewer): 交接文档（即上一份 NEXT.md）
```

测试：**224 / 224 通过**（原 186 + 诊断 22 + diff 16）。
## 两个仓库

| 位置 | 用途 | HEAD |
|---|---|---|
| `F:\xmdsh-two` | 私有主开发库 | `9af3522` |
| `github.com/zxr52829/mdviewer` | **公开镜像** | `4603545` |

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
| 「改成箭头函数」模型原样返回 | 系统提示词给了「无法完成就输出原文」的偷懒出口 | 收紧为「必须真正执行，只有语法上完全无法套用才原样输出」 |

## 关键文件

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/lang/diagnostics.js` | 283 | 诊断收集。JSON 包装 `validate()`，其余走带状态的词法+括号扫描 |
| `src/app/ai-panel.js` | 334 | 改写面板：指令输入、diff 渲染、应用/放弃 |
| `src/app/line-diff.js` | 59 | 行级 LCS diff。**无依赖，可脱离 DOM 单测** |
| `desktop/ai.go` | 393 | DeepSeek 代理。key 只在此进程与本机文件流转 |
| `src/view/editor-view.js` | 2070 | 诊断调度、overlay 绘制、`_updateLine` 第四层缓存键 |
| `src/app/app.js` | 905 | `_initAiPanel` / `openAiRewrite` / `_renderDiagnostics` / Ctrl+K |
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

- **非 JSON 语言只做到词法级 + 括号配对**。`if (x { }` 这类括号数量对但位置错的，发现不了。真解析器要每种语言塞一个 parser，会毁掉「前端零依赖」底线
- **AI 只做单轮选区改写**。没有多轮对话、没有跨文件上下文、没有工具调用
- `deepseek-chat` 不是为代码微调过的模型。简单重构稳定，复杂跨函数调整可能要试两三次
- 模型偶尔仍会吐 ``` 围栏，`stripCodeFence` 兜了一层
- **没有可视化回归测试**。本次 `[hidden]` 那个 bug 就是「单测全绿但真实浏览器里全屏遮罩」的典型。加真实浏览器截图比对要引依赖，与零依赖底线冲突，所以没做。如果要补，得先想清楚这条冲突

## 工作守则（本仓强制）

- **除工作区外一个字节都不许动**，全部落 `F:\xmdsh-two`
- 破坏性操作先备份（`scripts/backup.ps1 -Name "..."` 压 7z 到 `.system-backup/archives/`）
- 交付件修改前先 `read`，`write` 前必须先 `read`
- 跑不了的验证要明说，结论无证据写 `unknown`，不写「大概」
- 改前先立 `todo_write` 清单，完成一项标一项
- 推送主库前删 `.sync/`，否则自检拦截

## 下一步候选

用户没指定。当前无进行中的半成品。若要继续，方向大致是：

1. 补齐非 JSON 语言的括号位置检查（难度大，收益有限）
2. AI 多轮对话式改写（架构变化，要重设计面板）
3. 可视化回归测试（与零依赖冲突，需先决策）
4. 用户新提的需求

**动手前先问清楚要哪个**，「臃肿了」这类说法可能指体积、结构或认知负担，三个答案三种动作。
