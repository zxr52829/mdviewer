/**
 * 编辑行为：自动闭合、自动缩进、注释续行。
 *
 * 对应 Trae / VS Code 的 AutoClosingBracketController 与
 * TypingActions。规则来源全部是 language-config.js 的配置，
 * 这里不含任何语言特例。
 */

import { getLanguageConfiguration, getSyntaxStateAt } from './language-config.js';

/** 取某字符的自动闭合伙伴；不参与闭合则返回 null */
export function getAutoClosePair(ch, languageId, line, column) {
  const cfg = getLanguageConfiguration(languageId);
  const pairs = cfg.autoClosingPairs || [];
  const hit = pairs.find((p) => p.open === ch);
  if (!hit) return null;

  if (hit.notIn && hit.notIn.length) {
    const state = getSyntaxStateAt(line, column, languageId);
    if (hit.notIn.includes('string') && state.inString) return null;
    if (hit.notIn.includes('comment') && state.inComment) return null;
  }
  return hit;
}

/** 该字符是否是某对的闭合符号 */
export function isClosingChar(ch, languageId) {
  const cfg = getLanguageConfiguration(languageId);
  return (cfg.autoClosingPairs || []).some((p) => p.close === ch);
}

/** 能否用 surroundingPairs 包裹选区 */
export function getSurroundingPair(ch, languageId) {
  const cfg = getLanguageConfiguration(languageId);
  const pairs = cfg.surroundingPairs || [];
  const found = pairs.find((p) => (Array.isArray(p) ? p[0] : p.open) === ch);
  if (!found) return null;
  return Array.isArray(found) ? { open: found[0], close: found[1] } : found;
}

/**
 * 按回车时的自动缩进。
 *
 * 规则来自 language-config 的 indentation / onEnterRules：
 *   - 上一行匹配 increaseIndentPattern → 多缩进一级
 *   - 新行（即将成为的）匹配 decreaseIndentPattern → 少缩进一级
 *   - onEnterRules 命中 → 追加注释前缀等
 *
 * @param {string} prevLine 回车前的行内容（不含光标后部分）
 * @param {string} nextLine 光标后的剩余内容
 * @param {string} languageId
 * @param {number} indentSize
 * @returns {{indent:string, extraText:string}}
 */
export function getEnterAction(prevLine, nextLine, languageId, indentSize = 2) {
  const cfg = getLanguageConfiguration(languageId);

  // onEnterRules 优先：例如 JSON 里 // 注释后回车自动续 // 
  for (const rule of cfg.onEnterRules || []) {
    const beforeOk = rule.beforeTextPattern ? new RegExp(rule.beforeTextPattern).test(prevLine) : true;
    const afterOk = rule.afterTextPattern ? new RegExp(rule.afterTextPattern).test(nextLine) : true;
    if (beforeOk && afterOk) {
      const leading = /^[ \t]*/.exec(prevLine)[0];
      return { indent: leading, extraText: rule.appendText || '' };
    }
  }

  const leading = /^[ \t]*/.exec(prevLine)[0];

  if (!cfg.indentation) {
    // 无缩进规则：原样保留上一行的前导空白。
    // 不能走下面的 countIndent 重整：那会把 3 空格压成 1 级、再输出 2 空格，
    // 破坏 Markdown 这类靠空格对齐的格式（代码块缩进、列表延续）。
    return { indent: leading, extraText: '' };
  }

  const base = leading.replace(/\t/g, ' '.repeat(indentSize));
  const { increaseIndentPattern, decreaseIndentPattern } = cfg.indentation;

  let level = countIndent(base, indentSize);

  if (increaseIndentPattern && new RegExp(increaseIndentPattern).test(prevLine)) {
    level += 1;
  }
  if (decreaseIndentPattern && new RegExp(decreaseIndentPattern).test(nextLine)) {
    level = Math.max(0, level - 1);
  }

  return { indent: ' '.repeat(level * indentSize), extraText: '' };
}

function countIndent(leading, indentSize) {
  let width = 0;
  for (const ch of leading) width += ch === '\t' ? indentSize : 1;
  return Math.floor(width / indentSize);
}

/**
 * 退格是否应该成对删除（如在 "()" 中间按 Backspace 同时删掉两个）。
 * 对应 Trae 的 isAutoClosingPairDelete。
 */
export function shouldDeletePair(chBefore, chAfter, languageId) {
  const cfg = getLanguageConfiguration(languageId);
  return (cfg.autoClosingPairs || []).some((p) => p.open === chBefore && p.close === chAfter);
}
