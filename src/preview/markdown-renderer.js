/**
 * Markdown → HTML 渲染器。
 *
 * 对照 Trae 的 markdown-language-features：预览侧用 markdown-it（在扩展进程里渲染），
 * webview 侧用 morphdom 做增量 DOM 打补丁，并把每行包成 .code-line[data-line=N]
 * 以实现编辑器↔预览的滚动同步与光标行高亮。
 *
 * 这里自己实现一个够用的 md 渲染器，保留那三个关键契约：
 *   1. 每个块级元素带 data-line（源码行号）
 *   2. 输出是"一行一节点"，可被 diff
 *   3. 渲染是纯函数，同一输入永远同一输出
 */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ESC[c]);
}

/** 行内语法：代码 → 粗体 → 斜体 → 删除线 → 链接 → 图片 */
export function renderInline(text) {
  let s = esc(text);

  // 行内代码先抽出来占位，避免内部被后续规则二次处理
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code);
    return `\u0000CODE${codes.length - 1}\u0000`;
  });

  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, alt, src, title) => {
    const t = title ? ` title="${title}"` : '';
    return `<img src="${src}" alt="${alt}"${t} loading="lazy" />`;
  });

  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, label, href, title) => {
    const t = title ? ` title="${title}"` : '';
    const external = /^https?:/i.test(href);
    const rel = external ? ' target="_blank" rel="noreferrer noopener"' : '';
    return `<a href="${href}"${t}${rel}>${label}</a>`;
  });

  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/  $/gm, '<br />');

  s = s.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
  return s;
}

/**
 * 把 markdown 源码渲染为 HTML。
 * @param {string} source
 * @returns {{html:string, lines:number}}
 */
export function renderMarkdown(source) {
  const lines = source.split(/\r?\n/);
  const out = [];
  let i = 0;

  const push = (line, html) => out.push(`<div class="code-line" data-line="${line}">${html}</div>`);

  while (i < lines.length) {
    const raw = lines[i];
    const lineNo = i + 1;

    // 空行
    if (!raw.trim()) {
      i++;
      continue;
    }

    // 围栏代码块
    const fence = /^ {0,3}(```|~~~)\s*([\w+-]*)/.exec(raw);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2] || '';
      const buf = [];
      const startLine = lineNo;
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker}`).test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 跳过闭合围栏
      const label = lang ? `<span class="code-lang">${esc(lang)}</span>` : '';
      push(startLine, `<pre class="code-block">${label}<code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // 标题
    const heading = /^ {0,3}(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      const level = heading[1].length;
      push(lineNo, `<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    // 分隔线
    if (/^ {0,3}(?:---|\*\*\*|___)\s*$/.test(raw)) {
      push(lineNo, '<hr />');
      i++;
      continue;
    }

    // 引用块（连续合并）
    if (/^ {0,3}>/.test(raw)) {
      const startLine = lineNo;
      const buf = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
        buf.push(lines[i].replace(/^ {0,3}>\s?/, ''));
        i++;
      }
      push(startLine, `<blockquote>${renderInline(buf.join('\n')).replace(/\n/g, '<br />')}</blockquote>`);
      continue;
    }

    // 表格：表头 + 分隔行
    if (/\|/.test(raw) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]) && /-/.test(lines[i + 1])) {
      const startLine = lineNo;
      const cells = (row) =>
        row
          .replace(/^\s*\|/, '')
          .replace(/\|\s*$/, '')
          .split('|')
          .map((c) => c.trim());
      const head = cells(raw);
      i += 2;
      const body = [];
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) {
        body.push(cells(lines[i]));
        i++;
      }
      let html = '<table><thead><tr>';
      for (const h of head) html += `<th>${renderInline(h)}</th>`;
      html += '</tr></thead><tbody>';
      for (const row of body) {
        html += '<tr>';
        for (let c = 0; c < head.length; c++) html += `<td>${renderInline(row[c] ?? '')}</td>`;
        html += '</tr>';
      }
      html += '</tbody></table>';
      push(startLine, html);
      continue;
    }

    // 无序列表
    if (/^ {0,3}[-*+]\s+/.test(raw)) {
      const startLine = lineNo;
      const items = [];
      while (i < lines.length && /^ {0,3}[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^ {0,3}[-*+]\s+/, ''));
        i++;
      }
      push(startLine, `<ul>${items.map((t) => `<li>${renderInline(t)}</li>`).join('')}</ul>`);
      continue;
    }

    // 有序列表
    if (/^ {0,3}\d+\.\s+/.test(raw)) {
      const startLine = lineNo;
      const items = [];
      while (i < lines.length && /^ {0,3}\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^ {0,3}\d+\.\s+/, ''));
        i++;
      }
      push(startLine, `<ol>${items.map((t) => `<li>${renderInline(t)}</li>`).join('')}</ol>`);
      continue;
    }

    // 段落：吃到空行或下一个块起始
    const startLine = lineNo;
    const buf = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^ {0,3}(?:#{1,6}\s|>|```|~~~|[-*+]\s|\d+\.\s|(?:---|\*\*\*|___)\s*$)/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    if (buf.length) {
      push(startLine, `<p>${buf.map(renderInline).join('<br />')}</p>`);
    } else {
      push(lineNo, `<p>${renderInline(raw)}</p>`);
      i++;
    }
  }

  return { html: out.join('\n'), lines: lines.length };
}
