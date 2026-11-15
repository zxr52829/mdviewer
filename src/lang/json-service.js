/**
 * JSON 结构分析：校验、格式化、折叠范围。
 *
 * 对照 Trae：json 文件的编辑走纯 Monaco 文本 + json-language-features 的
 * LanguageService 做诊断（squiggles）与格式化。诊断由独立进程/worker 提供，
 * 主线程只拿结果。
 *
 * 这里同一套分层，只是把"语言服务"缩成一个同步函数：输入全文，
 * 输出 {errors:[{line,column,length,message}], outline:[...]}。
 */

/** 容错解析：返回 value 或抛带位置信息的错误 */
export function parseWithLocation(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    // V8 的报错形如 "Unexpected token } in JSON at position 12"
    const m = /position\s+(\d+)/i.exec(e.message || '');
    let offset = m ? Number(m[1]) : 0;
    if (!m) {
      const lm = /line\s+(\d+)\s+column\s+(\d+)/i.exec(e.message || '');
      if (lm) {
        const lines = text.split('\n');
        const line = Math.max(1, Math.min(Number(lm[1]), lines.length));
        let acc = 0;
        for (let i = 0; i < line - 1; i++) acc += lines[i].length + 1;
        offset = acc + Math.max(0, Number(lm[2]) - 1);
      }
    }
    offset = Math.max(0, Math.min(offset, text.length));

    // offset → line/column
    let line = 1;
    let lineStart = 0;
    for (let i = 0; i < offset; i++) {
      if (text.charCodeAt(i) === 10) {
        line++;
        lineStart = i + 1;
      }
    }

    return {
      ok: false,
      error: {
        line,
        column: offset - lineStart + 1,
        offset,
        length: 1,
        message: cleanMessage(e.message),
      },
    };
  }
}

function cleanMessage(msg) {
  if (!msg) return 'JSON 解析失败';
  return msg
    .replace(/^JSON\.parse:\s*/i, '')
    .replace(/\s+in JSON at position \d+/i, '')
    .replace(/^Unexpected token\s*/i, '意外的字符 ')
    .trim();
}

/**
 * 校验。jsonc/jsonl 走各自宽松策略；纯 json 严格解析。
 * @returns {{valid:boolean, errors:Array, value:any}}
 */
export function validate(text, languageId = 'json') {
  if (!text.trim()) return { valid: true, errors: [], value: null };

  if (languageId === 'jsonl') {
    const errors = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].trim();
      if (!raw) continue;
      try {
        JSON.parse(raw);
      } catch (e) {
        errors.push({
          line: i + 1,
          column: 1,
          length: raw.length || 1,
          message: `第 ${i + 1} 行不是合法 JSON：${cleanMessage(e.message)}`,
        });
      }
    }
    return { valid: errors.length === 0, errors, value: null };
  }

  let source = text;
  if (languageId === 'jsonc' || languageId === 'json5') {
    source = stripJsonComments(text);
    if (languageId === 'json5') source = stripTrailingCommas(source);
  }

  const res = parseWithLocation(source);
  if (res.ok) return { valid: true, errors: [], value: res.value };
  return { valid: false, errors: [{ ...res.error, message: res.error.message }], value: null };
}

/** 去掉注释，保留字符串内的内容不动 */
export function stripJsonComments(text) {
  let out = '';
  let i = 0;
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];

    if (inLineComment) {
      if (c === '\n') {
        inLineComment = false;
        out += c;
      }
      i++;
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && n === '/') {
        inBlockComment = false;
        i += 2;
        continue;
      }
      if (c === '\n') out += c;
      i++;
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && n === '/') {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (c === '/' && n === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 去掉对象/数组末尾多余逗号（字符串内不动） */
export function stripTrailingCommas(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') {
        out += text[i + 1] ?? '';
        i++;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += c;
  }
  return out;
}

/** 格式化：2 空格缩进，行尾保留换行 */
export function format(text, { indent = 2, languageId = 'json' } = {}) {
  const v = validate(text, languageId);
  if (!v.valid) return { ok: false, error: v.errors[0], text };
  if (v.value === null && !text.trim()) return { ok: true, text: '' };
  return { ok: true, text: JSON.stringify(v.value, null, indent) + '\n' };
}

/** 压缩：去掉所有可省空白 */
export function minify(text, { languageId = 'json' } = {}) {
  const v = validate(text, languageId);
  if (!v.valid) return { ok: false, error: v.errors[0], text };
  return { ok: true, text: JSON.stringify(v.value) };
}

/**
 * 折叠范围：找出每个可折叠块的 { fromLine, toLine }（1-based）。
 * 做法是逐字符扫描统计括号深度，比递归 AST 更省事也更容错。
 */
export function foldRanges(text) {
  const ranges = [];
  const lines = text.split(/\r?\n/);
  const stack = [];
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let line = 1;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];

    if (c === '\n') {
      line++;
      inLineComment = false;
      continue;
    }
    if (inLineComment) continue;
    if (inBlockComment) {
      if (c === '*' && n === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '/' && n === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === '/' && n === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (c === '{' || c === '[') {
      stack.push({ ch: c, line });
    } else if (c === '}' || c === ']') {
      const open = stack.pop();
      if (open && open.line < line) {
        ranges.push({ fromLine: open.line, toLine: line, kind: 'bracket' });
      }
    }
  }

  // 连续行注释块也折叠
  let runStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('//')) {
      if (runStart < 0) runStart = i + 1;
    } else if (runStart > 0) {
      if (i > runStart) ranges.push({ fromLine: runStart, toLine: i, kind: 'comment' });
      runStart = -1;
    }
  }
  if (runStart > 0 && lines.length > runStart) {
    ranges.push({ fromLine: runStart, toLine: lines.length, kind: 'comment' });
  }

  return ranges;
}

/** 大纲：顶层键路径树，用于侧边导航 */
export function outline(text, languageId = 'json') {
  const v = validate(text, languageId);
  if (!v.valid || v.value === null || typeof v.value !== 'object') return [];
  const walk = (node, path, depth) => {
    if (depth > 6 || node === null || typeof node !== 'object') return [];
    const out = [];
    if (Array.isArray(node)) {
      for (let i = 0; i < Math.min(node.length, 200); i++) {
        out.push({
          label: `${path}[${i}]`,
          kind: Array.isArray(node[i]) ? 'array' : typeof node[i],
          children: walk(node[i], `${path}[${i}]`, depth + 1),
        });
      }
    } else {
      for (const k of Object.keys(node).slice(0, 200)) {
        out.push({
          label: `${path}.${k}`,
          kind: Array.isArray(node[k]) ? 'array' : typeof node[k],
          children: walk(node[k], `${path}.${k}`, depth + 1),
        });
      }
    }
    return out;
  };
  return walk(v.value, '$', 0);
}
