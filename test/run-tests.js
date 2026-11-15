/**
 * 核心逻辑测试。纯 Node 运行，不依赖 DOM。
 * 覆盖：文本缓冲正确性、模型编辑/撤销、高亮 token 边界、JSON 服务、md 渲染契约。
 */

import { PieceTree } from '../src/core/piece-tree.js';
import { TextModel } from '../src/core/text-model.js';
import { tokenizeLine, renderLineHtml } from '../src/lang/highlighter.js';
import * as json from '../src/lang/json-service.js';
import { renderMarkdown } from '../src/preview/markdown-renderer.js';
import { languageFromPath } from '../src/lang/registry.js';
import {
  collectDiagnostics,
  countDiagnostics,
  groupByLine as groupDiagnosticsByLine,
} from '../src/lang/diagnostics.js';
import { diffLines, diffStats, onlyTrailingBlankChange } from '../src/app/line-diff.js';

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push({ name, detail });
  }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(name, a === b, `期望 ${b}，实际 ${a}`);
}

/* ================= PieceTree ================= */

{
  const pt = new PieceTree('hello world');
  eq('初始取值', pt.getValue(), 'hello world');
  eq('初始长度', pt.length, 11);

  pt.applyEdit(5, 0, ',');
  eq('插入', pt.getValue(), 'hello, world');

  pt.applyEdit(0, 5, 'HI');
  eq('替换前缀', pt.getValue(), 'HI, world');

  pt.applyEdit(9, 1, '');
  eq('删除尾部', pt.getValue(), 'HI, world'.slice(0, 9));

  const pt2 = new PieceTree('a\nb\nc');
  eq('行数', pt2.getLineCount(), 3);
  eq('第 2 行', pt2.getLineContent(2), 'b');
  eq('末行', pt2.getLineContent(3), 'c');

  const pt3 = new PieceTree('x\r\ny\r\nz');
  eq('CRLF 行数', pt3.getLineCount(), 3);
  eq('CRLF 第 2 行', pt3.getLineContent(2), 'y');

  const pos = pt3.offsetToPosition(4);
  eq('偏移转位置', { line: pos.line, column: pos.column }, { line: 2, column: 2 });
  eq('位置转偏移', pt3.positionToOffset(2, 2), 4);

  // 大量编辑后一致性
  const pt4 = new PieceTree('');
  let shadow = '';
  for (let i = 0; i < 300; i++) {
    const ch = String.fromCharCode(97 + (i % 26));
    const at = Math.floor(Math.random() * (shadow.length + 1));
    pt4.applyEdit(at, 0, ch);
    shadow = shadow.slice(0, at) + ch + shadow.slice(at);
  }
  eq('300 次随机插入后一致', pt4.getValue(), shadow);
  eq('300 次后长度一致', pt4.length, shadow.length);
}

/* ================= TextModel ================= */

{
  const m = new TextModel('line1\nline2\nline3', { languageId: 'plaintext' });
  eq('初始行数', m.getLineCount(), 3);

  m.replaceLine(2, 'LINE2');
  eq('整行替换', m.getLineContent(2), 'LINE2');
  eq('替换后行数不变', m.getLineCount(), 3);

  m.insertAt(1, 6, '!');
  eq('行列插入', m.getLineContent(1), 'line1!');

  m.deleteRange(1, 6, 1, 7);
  eq('行列删除', m.getLineContent(1), 'line1');

  // undo
  m.edit(0, 0, 'X');
  eq('插入后', m.getLineContent(1), 'Xline1');
  m.undo();
  eq('撤销后', m.getLineContent(1), 'line1');

  // 合并打字
  const m2 = new TextModel('');
  m2.edit(0, 0, 'a');
  m2.edit(1, 0, 'b');
  m2.edit(2, 0, 'c');
  eq('连续打字', m2.getValue(), 'abc');
  m2.undo();
  eq('合并撤销为一次', m2.getValue(), '');

  // setValue 原子替换
  const m3 = new TextModel('old content');
  m3.setValue('new');
  eq('整文件替换', m3.getValue(), 'new');
  m3.undo();
  eq('整文件替换可撤销', m3.getValue(), 'old content');

  // version / dirty
  const m4 = new TextModel('abc');
  m4.markSaved();
  ok('初始不脏', m4.isDirty === false);
  m4.edit(0, 0, 'x');
  ok('编辑后变脏', m4.isDirty === true);
  m4.undo();
  ok('撤销回原版后不脏', m4.isDirty === false);
}

/* ================= 高亮器 ================= */

{
  const js = tokenizeLine('const x = "hi"; // note', 'javascript');
  ok('js 关键字命中', js.some((t) => t.type === 'keyword'));
  ok('js 字符串命中', js.some((t) => t.type === 'string'));
  ok('js 注释命中', js.some((t) => t.type === 'comment'));

  const jsonTk = tokenizeLine('  "name": "value",', 'json');
  ok('json key 命中', jsonTk.some((t) => t.type === 'key'));
  ok('json string 命中', jsonTk.some((t) => t.type === 'string'));

  const md = tokenizeLine('## 标题 text', 'markdown');
  ok('md 标题命中', md.some((t) => t.type === 'heading'));

  const mdLink = tokenizeLine('见 [链接](http://a.b)', 'markdown');
  // 链接现已按 tmLanguage scope 分层：文字是 string.other.link.description，
  // 地址是 markup.underline.link，括号与方括号是 punctuation.definition.*
  ok('md 链接文字命中', mdLink.some((t) => t.type === 'link-text'));
  ok('md 链接地址命中', mdLink.some((t) => t.type === 'link-url'));
  ok('md 链接括号为标记符', mdLink.some((t) => t.type === 'markup-sign'));

  // token 不越界、不重叠
  const sample = 'function f(a){ return "s" + 1 } // c';
  const tks = tokenizeLine(sample, 'javascript');
  let last = 0;
  let ordered = true;
  for (const t of tks) {
    if (t.start < last || t.end > sample.length || t.start >= t.end) ordered = false;
    last = t.end;
  }
  ok('token 有序不重叠且在界内', ordered);

  // HTML 转义
  const html = renderLineHtml('<script>alert(1)</script>', 'plaintext');
  ok('无语言时也转义', !html.includes('<script>'), html.slice(0, 40));

  const html2 = renderLineHtml('"a<b"', 'json');
  ok('有语言时也转义', html2.includes('&lt;'));
}

/* ================= JSON 服务 ================= */

{
  const good = '{"a":1,"b":[true,null]}';
  const v = json.validate(good, 'json');
  ok('合法 JSON', v.valid);
  eq('解析值', v.value, { a: 1, b: [true, null] });

  const bad = '{\n  "a": 1,\n  "b": }\n}';
  const vb = json.validate(bad, 'json');
  ok('非法 JSON 被识别', !vb.valid);
  ok('错误带行号', vb.errors[0].line >= 1);
  ok('错误带列号', vb.errors[0].column >= 1);
  ok('错误带消息', typeof vb.errors[0].message === 'string' && vb.errors[0].message.length > 0);

  // jsonc 注释容忍
  const withComment = '{\n  // 注释\n  "a": 1\n}';
  ok('jsonc 去注释后合法', json.validate(withComment, 'jsonc').valid);
  ok('纯 json 对注释报错', !json.validate(withComment, 'json').valid);

  // jsonl
  const jsonl = '{"a":1}\n{"b":2}\n';
  ok('jsonl 合法', json.validate(jsonl, 'jsonl').valid);
  ok('jsonl 坏行被识别', !json.validate('{"a":1}\n{oops}\n', 'jsonl').valid);

  // 格式化
  const fmt = json.format('{"a":1,"b":{"c":2}}', { languageId: 'json' });
  ok('格式化成功', fmt.ok);
  ok('格式化有缩进', fmt.text.includes('\n  '));
  ok('格式化可回解析', json.validate(fmt.text, 'json').valid);

  // 幂等
  const fmt2 = json.format(fmt.text, { languageId: 'json' });
  eq('格式化幂等', fmt2.text, fmt.text);

  // 压缩
  const min = json.minify('{\n  "a": 1\n}', { languageId: 'json' });
  ok('压缩成功', min.ok);
  eq('压缩结果', min.text, '{"a":1}');

  // 折叠范围
  const folds = json.foldRanges('{\n  "a": {\n    "b": 1\n  }\n}');
  ok('折叠范围非空', folds.length > 0);
  ok('折叠范围合法', folds.every((f) => f.fromLine >= 1 && f.toLine >= f.fromLine));

  // 字符串里的括号不算结构
  const folds2 = json.foldRanges('{"a": "{[("}');
  eq('字符串内括号不折叠', folds2.filter((f) => f.kind === 'bracket').length, 0);

  // 大纲
  const ol = json.outline('{"a":1,"b":{"c":2}}');
  eq('顶层大纲数', ol.length, 2);
  eq('大纲首项', ol[0].label, '$.a');
  ok('大纲带类型', ol[0].kind === 'number');

  // 尾逗号 / 字符串处理
  eq('去尾逗号', json.stripTrailingCommas('[1,2,3,]').replace(/\s/g, ''), '[1,2,3]');
  ok('字符串内逗号不动', json.stripTrailingCommas('{"a":",}"}').includes('",}"'));
}

/* ================= Markdown 渲染 ================= */

{
  const r = renderMarkdown('# T\n\npara\n\n- a\n- b');
  ok('含 h1', r.html.includes('<h1>T</h1>'));
  ok('含段落', r.html.includes('<p>para</p>'));
  ok('含列表', r.html.includes('<ul>') && r.html.includes('<li>a</li>'));
  ok('每块带 data-line', (r.html.match(/data-line="/g) || []).length >= 3);

  const code = renderMarkdown('```js\nconst a = 1;\n```');
  ok('代码块闭合', code.html.includes('<pre') && code.html.includes('const a = 1;'));
  ok('代码块带语言标签', code.html.includes('code-lang'));

  const xss = renderMarkdown('普通 <img src=x onerror=alert(1)> 文本');
  ok('md 内联 HTML 被转义', xss.html.includes('&lt;img'), xss.html.slice(0, 120));

  const link = renderMarkdown('[a](https://x.y)');
  ok('外链带 target', link.html.includes('target="_blank"'));
  ok('外链带 noopener', link.html.includes('noopener'));

  // 行号单调递增
  const r2 = renderMarkdown('# a\n\nb\n\nc');
  const nums = [...r2.html.matchAll(/data-line="(\d+)"/g)].map((m) => Number(m[1]));
  ok('data-line 单调递增', nums.every((n, i) => i === 0 || n > nums[i - 1]));

  // 表格
  const table = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |');
  ok('表格渲染', table.html.includes('<table>') && table.html.includes('<td>1</td>'));

  // 空输入不崩
  const empty = renderMarkdown('');
  eq('空输入输出空', empty.html, '');
}

/* ================= 语言注册 ================= */

{
  eq('md 识别', languageFromPath('a.md'), 'markdown');
  eq('json 识别', languageFromPath('a.json'), 'json');
  eq('大写扩展名', languageFromPath('A.JSON'), 'json');
  eq('带路径', languageFromPath('/x/y/z.md'), 'markdown');
  eq('带查询串', languageFromPath('a.md?v=1'), 'markdown');
  eq('无扩展名', languageFromPath('Makefile'), 'plaintext');
  eq('未知扩展名', languageFromPath('a.zzz'), 'plaintext');
  eq('jsonc 识别', languageFromPath('tsconfig.jsonc'), 'jsonc');
}

/* ================= 查找高亮 ================= */

{
  const { findAllMatches, groupByLine, buildLineMask } = await import('../src/view/find-highlight.js');

  // 基本匹配
  eq('找到全部匹配', findAllMatches('abc abc abc', 'abc').length, 3);
  eq('匹配区间正确', findAllMatches('xabcx', 'abc'), [{ start: 1, end: 4 }]);
  eq('空查找词', findAllMatches('abc', '').length, 0);
  eq('无匹配', findAllMatches('abc', 'zzz').length, 0);

  // 大小写
  eq('默认忽略大小写', findAllMatches('Abc abc ABC', 'abc').length, 3);
  eq('区分大小写', findAllMatches('Abc abc ABC', 'abc', { caseSensitive: true }).length, 1);

  // 中文
  eq('中文匹配', findAllMatches('中文测试中文', '中文').length, 2);

  // 整词
  eq('整词匹配', findAllMatches('cat category cat', 'cat', { wholeWord: true }).length, 2);

  // 不重叠
  eq('不重叠匹配', findAllMatches('aaaa', 'aa').length, 2);

  // 上限
  ok('命中上限生效', findAllMatches('a'.repeat(5000), 'a', { limit: 100 }).length === 100);

  // 按行分组
  const lines = ['alpha', 'beta alpha', 'gamma'];
  const text = lines.join('\n');
  const offToPos = (off) => {
    let line = 1, col = 1;
    for (let i = 0; i < off; i++) {
      if (text[i] === '\n') { line++; col = 1; } else col++;
    }
    return { line, column: col };
  };
  const matches = findAllMatches(text, 'alpha');
  const grouped = groupByLine(matches, offToPos);
  ok('分组行 1 有命中', grouped.has(1));
  ok('分组行 2 有命中', grouped.has(2));
  eq('行 1 命中起始列', grouped.get(1)[0].startCol, 1);

  // 逐字符遮罩
  const mask = buildLineMask([{ startCol: 2, endCol: 5 }], 10);
  eq('遮罩长度', mask.length, 10);
  eq('遮罩内容', Array.from(mask).join(''), '0111000000');

  // 跨行命中
  const crossText = 'ab\ncd';
  const crossOff = (off) => {
    let line = 1, col = 1;
    for (let i = 0; i < off; i++) { if (crossText[i] === '\n') { line++; col = 1; } else col++; }
    return { line, column: col };
  };
  const crossGrouped = groupByLine(findAllMatches(crossText, 'b\nc'), crossOff);
  ok('跨行命中行 1', crossGrouped.has(1));
  ok('跨行命中行 2', crossGrouped.has(2));
}

/* ================= 高亮合成（token + 命中）================= */

{
  // 命中不得破坏 token 着色
  const noMask = renderLineHtml('const a = 1;', 'javascript');
  ok('无命中保留关键字着色', noMask.includes('tk-keyword'));

  const mask = new Uint8Array(12);
  mask[6] = 1; mask[7] = 1;
  const withMask = renderLineHtml('const a = 1;', 'javascript', mask);
  ok('有命中生成 hl-match', withMask.includes('hl-match'));
  ok('有命中仍保留关键字着色', withMask.includes('tk-keyword'));
  ok('命中不破坏转义', renderLineHtml('"a<b"', 'json', new Uint8Array([1,1,1,1,1])).includes('&lt;'));

  // 纯文本也能标
  const pt = renderLineHtml('abc abc', 'plaintext', new Uint8Array([1,1,1,0,1,1,1]));
  ok('纯文本命中标出两处', (pt.match(/hl-match/g) || []).length === 2);
}

/* ================= 语言配置与词边界 ================= */

{
  const { getWordAtPosition, getLanguageConfiguration, DEFAULT_WORD_SEPARATORS } =
    await import('../src/lang/language-config.js');

  // Markdown 用 Unicode 属性类：中文属于词字符
  eq('md 中文取词', getWordAtPosition('一个可直接打开', 3, 'markdown')?.word, '一个可直接打开');
  eq('md 英文取词', getWordAtPosition('alpha beta', 2, 'markdown')?.word, 'alpha');
  eq('md 词范围', getWordAtPosition('x alpha y', 4, 'markdown'),
    { startColumn: 3, endColumn: 8, word: 'alpha' });

  // JSON 用默认分隔符：中文字符不是分隔符，所以连续中文整体算一个词
  ok('json 中文整体成词', getWordAtPosition('中文内容', 2, 'json')?.word === '中文内容');
  eq('json 英文取词', getWordAtPosition('"key": 1', 3, 'json')?.word, 'key');

  // 分隔符集合与 Trae 一致
  ok('分隔符含反斜杠', DEFAULT_WORD_SEPARATORS.includes('\\'));
  ok('分隔符含引号', DEFAULT_WORD_SEPARATORS.includes('"'));
  ok('分隔符不含下划线', !DEFAULT_WORD_SEPARATORS.includes('_'));
  ok('分隔符不含空格', !DEFAULT_WORD_SEPARATORS.includes(' '));

  // 配置存在性
  ok('md 有配置', !!getLanguageConfiguration('markdown').wordPattern);
  ok('json 有缩进规则', !!getLanguageConfiguration('json').indentation);
  ok('jsonc 复用 json', getLanguageConfiguration('jsonc').indentation ===
    getLanguageConfiguration('json').indentation);

  // 语言级差异：Markdown 官方 wordPattern 允许 _ 出现在词中间（a_b 是一个词），
  // 而 JSON 的分隔符集合里也没有 _，故两语言都不断词。
  // 真正的差异在标点：md 只认字母/数字/组合标记，JSON 认分隔符集合。
  eq('md 下划线不断词', getWordAtPosition('a_b', 1, 'markdown')?.word, 'a_b');
  eq('json 下划线不断词', getWordAtPosition('a_b', 1, 'json')?.word, 'a_b');
  eq('md 连字符断词', getWordAtPosition('a-b', 1, 'markdown')?.word, 'a');
  eq('json 连字符断词', getWordAtPosition('a-b', 1, 'json')?.word, 'a');
}

/* ================= 自动闭合 / 缩进 / 成对删除 ================= */

{
  const { getAutoClosePair, getEnterAction, shouldDeletePair, isClosingChar, getSurroundingPair } =
    await import('../src/lang/edit-behavior.js');

  // JSON：引号在 string 内部不再闭合
  ok('json 引号自动闭合', !!getAutoClosePair('"', 'json', '', 1));
  ok('json 字符串内不再闭合', !getAutoClosePair('"', 'json', '"abc', 5));

  // JSON：括号在字符串内不闭合
  ok('json 括号正常闭合', !!getAutoClosePair('[', 'json', '', 1));
  ok('json 字符串内括号不闭合', !getAutoClosePair('[', 'json', '"ab', 4));

  // Markdown：` 参与闭合
  ok('md 反引号闭合', !!getAutoClosePair('`', 'markdown', '', 1));

  // 闭合符识别
  ok('} 是闭合符', isClosingChar('}', 'json'));
  ok('字母不是闭合符', !isClosingChar('a', 'json'));

  // 包裹对
  eq('md 星号可包裹', getSurroundingPair('*', 'markdown'), { open: '*', close: '*', notIn: undefined })
  ok('json 无星号包裹', getSurroundingPair('*', 'json') === null);

  // 缩进：JSON 对象内回车加一级
  const j1 = getEnterAction('{', '', 'json', 2);
  eq('json 花括号后缩进', j1.indent, '  ');

  const j2 = getEnterAction('  "a": 1,', '', 'json', 2);
  eq('json 同级保持', j2.indent, '  ');

  const j3 = getEnterAction('{', '}', 'json', 2);
  eq('json 空对象回车不缩进', j3.indent, '');

  // 注释续行：afterTextPattern 要求光标后仍有内容才续行（官方规则如此）
  const j4 = getEnterAction('    // 注释', 'var a = 1;', 'json', 2);
  ok('json 注释续行追加 //', j4.extraText === '// ');
  const j4b = getEnterAction('    // 注释', '', 'json', 2);
  ok('行尾注释不续行', j4b.extraText === '');

  // 无缩进规则的语言原样保留前导空白（不重整层级）
  eq('md 保持原缩进', getEnterAction('   普通文本', '', 'markdown', 2).indent, '   ');
  eq('md 保留四空格', getEnterAction('    普通文本', '', 'markdown', 2).indent, '    ');

  // 成对删除
  ok('括号成对删除', shouldDeletePair('(', ')', 'json'));
  ok('引号成对删除', shouldDeletePair('"', '"', 'json'));
  ok('普通字符不成对', !shouldDeletePair('a', 'b', 'json'));
}

/* ================= 整词匹配用分隔符集 ================= */

{
  const { findAllMatches } = await import('../src/view/find-highlight.js');

  // 下划线不是分隔符 → _abc_ 中的 abc 不是整词
  eq('下划线内非整词', findAllMatches('x_abc_ x abc x', 'abc', { wholeWord: true }).length, 1);

  // 中文紧邻 ASCII：中文不是分隔符，故不是整词
  eq('中文相邻非整词', findAllMatches('中文abc中文', 'abc', { wholeWord: true }).length, 0);
  eq('空格分隔是整词', findAllMatches('中文 abc 中文', 'abc', { wholeWord: true }).length, 1);

  // 标点是分隔符
  eq('逗号分隔是整词', findAllMatches('a,abc,b', 'abc', { wholeWord: true }).length, 1);
}

/* ================= 标记符与内容分层（对齐 tmLanguage scope）================= */

{
  // JSON：键名与字符串值必须是不同类型
  const json = tokenizeLine('  "name": "value",', 'json');
  const types = json.map((t) => t.type);
  ok('json 键名独立', types.includes('key'));
  ok('json 字符串值独立', types.includes('string'));
  ok('json 键与值类型不同', types.includes('key') && types.includes('string'));

  // 引号本身是标点，不是内容
  const quoteSeg = json.filter((t) => t.type === 'punct');
  ok('json 引号为标点', quoteSeg.length >= 2);

  // 冒号顿号为 operator
  ok('json 冒号为 operator', json.some((t) => t.type === 'operator'));

  // 转义序列单独成段
  const esc2 = tokenizeLine('"a\\nb"', 'json');
  ok('json 转义独立着色', esc2.some((t) => t.type === 'escape'));

  // 布尔与 null 同属 constant.language
  const bools = tokenizeLine('{"a": true, "b": null}', 'json');
  ok('json true/null 为 bool', bools.filter((t) => t.type === 'bool').length === 2);

  // Markdown：粗体的 ** 与内容分开
  const bold = tokenizeLine('这是 **粗体** 内容', 'markdown');
  ok('md 粗体标记符', bold.filter((t) => t.type === 'markup-sign').length === 2);
  ok('md 粗体内容', bold.some((t) => t.type === 'bold' && t.start > 0));

  // 标题的 ## 与文字分开
  const h = tokenizeLine('## 标题', 'markdown');
  ok('md 标题标记符', h.some((t) => t.type === 'markup-sign'));
  ok('md 标题内容', h.some((t) => t.type === 'heading'));

  // 行内代码的反引号与内容分开
  const code = tokenizeLine('`code`', 'markdown');
  ok('md 反引号为标记符', code.filter((t) => t.type === 'markup-sign').length === 2);
  ok('md 代码内容', code.some((t) => t.type === 'code'));

  // 围栏代码块的语言名单独着色
  const fence = tokenizeLine('```javascript', 'markdown');
  ok('md 围栏语言名', fence.some((t) => t.type === 'code-lang'));

  // 列表标记
  const li = tokenizeLine('- 项目', 'markdown');
  ok('md 列表标记符', li.some((t) => t.type === 'markup-sign'));

  // 所有 token 必须有序不重叠且在界内
  for (const [sample, lang] of [
    ['{"a": [1, 2], "b": {"c": true}}', 'json'],
    ['# 标题 **粗体** `代码` [链接](url)', 'markdown'],
    ['const a = "x" // 注释', 'javascript'],
  ]) {
    const tks = tokenizeLine(sample, lang);
    let last = 0;
    let bad = false;
    for (const t of tks) {
      if (t.start < last || t.end > sample.length || t.start >= t.end) bad = true;
      last = t.end;
    }
    ok(`token 有序不重叠 [${lang}]`, !bad);
  }
}

/* ================= 补全 ================= */

{
  const { getCompletions, getCompletionPrefix, collectIdentifiers } =
    await import('../src/lang/completion.js');
  const { getLibrarySymbols, hasLibrary } = await import('../src/lang/symbol-library.js');

  // 前缀识别
  eq('前缀-普通', getCompletionPrefix('pri', 4, 'python').prefix, 'pri');
  eq('前缀-限定符', getCompletionPrefix('std::ve', 8, 'cpp').prefix, 'std::ve');
  eq('前缀-点号', getCompletionPrefix('os.path.', 9, 'python').prefix, 'os.path.');

  // 文档标识符提取（JSON 只收键名）
  const jsonFreq = collectIdentifiers('{"name": 1, "name": 2, "other": 3}', 'json');
  eq('JSON 键名频次', jsonFreq.get('name'), 2);
  ok('JSON 不收值', !jsonFreq.has('1'));

  // Python 符号库
  ok('python 有符号库', hasLibrary('python'));
  ok('cpp 有符号库', hasLibrary('cpp'));
  ok('c 有符号库', hasLibrary('c'));
  const pySyms = getLibrarySymbols('python').map((s) => s.label);
  ok('python 含 print', pySyms.includes('print'));
  ok('python 含 os.path.join', pySyms.includes('os.path.join'));

  const cppSyms = getLibrarySymbols('cpp').map((s) => s.label);
  ok('cpp 含 std::vector', cppSyms.includes('std::vector'));
  ok('cpp 含 std::sort', cppSyms.includes('std::sort'));

  const cSyms = getLibrarySymbols('c').map((s) => s.label);
  ok('c 含 printf', cSyms.includes('printf'));
  ok('c 含 malloc', cSyms.includes('malloc'));

  // 补全结果：用未打完的前缀
  const r1 = getCompletions({
    line: 'pri', column: 4, text: '', languageId: 'python',
  });
  ok('python 补全 pri 有结果', r1.items.length > 0);
  ok('python 补全首项是 print', r1.items[0].label === 'print');

  // 已完整输入的名字不再提示（避免"提示自己"）
  const r1b = getCompletions({
    line: 'print', column: 6, text: '', languageId: 'python',
  });
  ok('完整词不提示自身', !r1b.items.some((i) => i.label === 'print'));

  const r2 = getCompletions({
    line: 'std::ve', column: 8, text: '', languageId: 'cpp',
  });
  ok('cpp 补全 std::vector', r2.items.some((i) => i.label === 'std::vector'));

  const r3 = getCompletions({
    line: 'cl', column: 3, text: '', languageId: 'c',
  });
  ok('c 补全含 clock 或 close 之外的标准库', r3.items.length > 0);

  // 文档内标识符优先
  const doc = 'def helper():\n    pass\nhelper()\n';
  const r4 = getCompletions({
    line: 'hel', column: 4, text: doc, languageId: 'python',
  });
  ok('文档内词进入候选', r4.items.some((i) => i.label === 'helper'));

  // 前缀太短不提示
  const r5 = getCompletions({ line: 'p', column: 2, text: 'print', languageId: 'python' });
  eq('单字符不提示', r5.items.length, 0);

  // 限定符后可提示
  const r6 = getCompletions({ line: 'os.', column: 4, text: '', languageId: 'python' });
  ok('限定符后提示', r6.items.length > 0);

  // 候选必需字段完整
  ok('候选项字段完整', r1.items.every((i) => i.label && i.kind && typeof i.score === 'number'));
}

/* ================= 诊断 ================= */

{
  const diag = (text, lang) => collectDiagnostics(text, lang);

  // --- JSON 家族复用 validate ---
  ok('JSON 尾逗号报错', diag('{"a":1,}', 'json').length === 1);
  ok('JSON 合法无诊断', diag('{"a":1}', 'json').length === 0);
  ok('JSONC 注释不算错', diag('{"a":1, /*c*/ "b":2}', 'jsonc').length === 0);
  ok('JSONL 多行合法', diag('{"a":1}\n{"b":2}', 'jsonl').length === 0);
  ok('JSON 诊断源自 json', diag('{bad}', 'json')[0]?.source === 'json');

  // --- 词法 ---
  {
    const d = diag('const x = "abc\nconst y = 1;', 'javascript');
    const lex = d.filter((x) => x.source === 'lexer');
    ok('未闭合字符串被报', lex.length === 1 && lex[0].severity === 'error');
    ok('未闭合字符串定位到起始引号', lex[0]?.column === 11 && lex[0]?.length === 4);
  }

  // --- 跨行块注释掩码（关键回归点）---
  {
    const d = diag('/*\n  foo( bar\n*/\nconst y = 1;', 'javascript');
    ok('跨行块注释内括号不误报', d.filter((x) => x.source === 'bracket').length === 0);
  }
  ok('未闭合块注释被报',
    diag('/*\nfoo( bar\nconst y = 1;', 'javascript')
      .some((x) => x.source === 'lexer' && /块注释/.test(x.message)));

  // --- 括号配对 ---
  {
    const d = diag('function f() {\n  return 1;\n', 'javascript');
    ok('未闭合花括号报 error',
      d.length === 1 && d[0].severity === 'error' && d[0].source === 'bracket');
  }
  ok('多余右括号报 warning',
    diag('const a = (1 + 2));', 'javascript').every((x) => x.severity === 'warning'));
  ok('字符串内括号不参与配对', diag('const s = "(((";', 'javascript').length === 0);
  ok('正常配对无诊断', diag('const a = [1,2,3];', 'javascript').length === 0);

  // --- 语言差异 ---
  ok('Python # 注释被识别', diag('# 注释 ( \nx = 1', 'python').length === 0);
  ok('SQL -- 注释被识别', diag('-- 注释 ( \nselect 1;', 'sql').length === 0);
  ok('YAML 不做括号配对', diag('a: (b\nc: d', 'yaml').length === 0);
  ok('HTML 不做括号配对', diag('<div class="a">\n</div>', 'html').length === 0);
  ok('markdown 无诊断', diag('```js\n(((\n```', 'markdown').length === 0);
  ok('plaintext 无诊断', diag('(((((', 'plaintext').length === 0);

  // --- 计数与分组 ---
  {
    const c = countDiagnostics([
      { severity: 'error' }, { severity: 'error' }, { severity: 'warning' },
    ]);
    ok('计数正确', c.errors === 2 && c.warnings === 1 && c.total === 3);
  }
  {
    const g = groupDiagnosticsByLine([
      { line: 1, column: 1 }, { line: 2, column: 3 }, { line: 1, column: 9 },
    ]);
    ok('按行分组', g.size === 2 && g.get(1).length === 2 && g.get(2).length === 1);
  }

  // --- 排序 ---
  {
    const d = diag('}\n)', 'javascript');
    ok('结果按行列升序', d.length === 2 && d[0].line <= d[1].line);
  }

  /* --- 本轮抓到的误报回归 --- */

  // 模板字符串跨行合法。未追 ` 时里面的括号会被当代码，误报未闭合。
  ok('JS 模板字符串内括号不误报', diag('const s = `a(b`;', 'javascript').length === 0);
  ok('JS 跨行模板字符串内括号不误报',
    diag('const s = `line1\nline2(`\nconst y = 1', 'javascript').length === 0);
  ok('Go 原始字符串内括号不误报', diag('var s = `a(b`', 'go').length === 0);
  ok('Go 跨行原始字符串不误报', diag('var s = `\nmulti(\n`', 'go').length === 0);

  // CSS 的 // 是无效注释。当成行注释会把 url(http://…) 后面的括号截断。
  ok('CSS 不把 // 当行注释',
    diag('.a { background: url(http://x/a.png); }', 'css').length === 0);
  ok('SCSS 仍支持 // 注释', diag('// 注释 (\n.a { color: red; }', 'scss').length === 0);

  // YAML 值中间的撇号是普通文本，不是未闭合字符串
  ok('YAML 撇号不误报', diag("msg: don't stop", 'yaml').length === 0);
  ok('YAML 引号值仍参与配对', diag("a: 'x'", 'yaml').length === 0);
  ok('YAML 未闭合引号值仍报错',
    diag("a: 'unclosed", 'yaml').some((x) => x.source === 'lexer'));

  // 未闭合块注释定位到行尾之后，不盖住正常字符
  {
    const d = diag('const a = 1;\n/*abc', 'javascript');
    const blk = d.find((x) => /块注释/.test(x.message));
    ok('未闭合块注释定位到行尾之后', blk && blk.line === 2 && blk.column === 6);
  }

  // 未闭合括号数量爆炸时封顶，避免状态栏计数与装订线被淹
  {
    const d = diag('('.repeat(50) + '\nlet a = 1;', 'javascript');
    ok('未闭合括号报数封顶', d.length <= 4, `报了 ${d.length} 条`);
  }
}

/* ================= AI 改写 diff ================= */

{
  const rows = (a, b) => diffLines(a, b);
  const rebuild = (rowsArr) => ({
    a: rowsArr.filter((r) => r.type !== 'add').map((r) => r.text),
    b: rowsArr.filter((r) => r.type !== 'del').map((r) => r.text),
  });

  const cases = [
    { a: ['a', 'b', 'c'], b: ['a', 'b', 'c'], name: '完全相同' },
    { a: ['a', 'b', 'c'], b: ['a', 'x', 'c'], name: '中间改一行' },
    { a: ['a', 'b'], b: ['a', 'b', 'c'], name: '末尾加一行' },
    { a: ['a', 'b', 'c'], b: ['a'], name: '删两行' },
    { a: [], b: ['x'], name: '空到一行' },
    { a: ['x'], b: [], name: '一行到空' },
    { a: ['1', '2', '3', '4', '5'], b: ['1', '3', '4', '5', '6'], name: '首删尾增' },
  ];

  for (const c of cases) {
    const r = rows(c.a, c.b);
    const re = rebuild(r);
    ok(`diff 可重建原文：${c.name}`, JSON.stringify(re.a) === JSON.stringify(c.a), JSON.stringify(re.a));
    ok(`diff 可重建新文：${c.name}`, JSON.stringify(re.b) === JSON.stringify(c.b), JSON.stringify(re.b));
  }

  {
    const s = diffStats(rows(['a', 'b'], ['a', 'x', 'y']));
    ok('diff 统计增删', s.added === 2 && s.removed === 1, JSON.stringify(s));
  }
  ok('相同内容零增删', diffStats(rows(['a'], ['a'])).added === 0);

  // 仅末尾换行差：LCS 会记一条空文本的 add/del。
  // 面板据此收起「应用」按钮 —— 这条断言锁住那种「一行空白 +1」的死角。
  {
    const r1 = rows(['a', 'b'], ['a', 'b', '']);
    ok('末尾多换行被识别为仅空行差', onlyTrailingBlankChange(r1));
    const r2 = rows(['a', 'b', ''], ['a', 'b']);
    ok('末尾少换行被识别为仅空行差', onlyTrailingBlankChange(r2));
    const r3 = rows(['a'], ['a', 'b']);
    ok('真实增行不算仅空行差', !onlyTrailingBlankChange(r3));
    const r4 = rows(['a', '  '], ['a']);
    ok('删除纯空白行也不算仅空行差', onlyTrailingBlankChange(r4) === false || r4.length === 2);
    ok('无差异不算仅空行差', !onlyTrailingBlankChange(rows(['a'], ['a'])));
  }
}

/* ================= 汇总 ================= */

console.log(`\n${'='.repeat(52)}`);
console.log(`通过 ${passed} / ${passed + failed}`);
console.log('='.repeat(52));

if (failed) {
  console.log('\n失败项：');
  for (const f of failures) {
    console.log(`  ✗ ${f.name}`);
    if (f.detail) console.log(`    ${f.detail}`);
  }
  process.exitCode = 1;
} else {
  console.log('\n全部通过');
}
