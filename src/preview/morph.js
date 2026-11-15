/**
 * 增量 DOM 打补丁（morphdom 的最小可用替代）。
 *
 * Trae 用的是 morphdom：把新 HTML 解析成节点树，与实际 DOM 逐节点对比，
 * 只动真正变化的节点。这样预览刷新不会丢失滚动位置、不会重置 <details>
 * 展开态、不会重新解码已加载的图片。
 *
 * 这里的实现覆盖同样场景：标签名相同则原地改属性与文本，不同则替换；
 * 带 data-key 的子节点按 key 匹配，其余按位置匹配。够用且无依赖。
 */

/** 判断两个节点是否可复用（同类型） */
function sameType(a, b) {
  if (a.nodeType !== b.nodeType) return false;
  if (a.nodeType === 1) return a.tagName === b.tagName;
  return true;
}

function patchAttributes(from, to) {
  const fromAttrs = from.attributes;
  const toAttrs = to.attributes;

  for (let i = fromAttrs.length - 1; i >= 0; i--) {
    const name = fromAttrs[i].name;
    if (!to.hasAttribute(name)) from.removeAttribute(name);
  }
  for (let i = 0; i < toAttrs.length; i++) {
    const { name, value } = toAttrs[i];
    if (from.getAttribute(name) !== value) from.setAttribute(name, value);
  }
}

function keyOf(node) {
  if (node.nodeType !== 1) return null;
  const k = node.getAttribute && node.getAttribute('data-key');
  return k == null ? null : k;
}

/**
 * 把 to 的形态打到 from 上，返回最终节点（可能是 to 本身）。
 */
export function morph(from, to) {
  if (!sameType(from, to)) {
    from.replaceWith(to);
    return to;
  }

  // 文本 / 注释：直接改值
  if (from.nodeType !== 1) {
    if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
    return from;
  }

  // 表单元素的值要单独处理，属性同步不会生效
  const tag = from.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    if ('value' in from && from.value !== to.value) from.value = to.value;
    if (from.checked !== to.checked) from.checked = to.checked;
  }

  // 输入框聚焦时不动它，否则会丢光标
  const isFocused = from === from.ownerDocument.activeElement;
  if (!isFocused) patchAttributes(from, to);

  // 子节点：带 key 的先建索引，其余按顺序对齐
  const fromChildren = Array.from(from.childNodes);
  const toChildren = Array.from(to.childNodes);

  const keyed = new Map();
  for (const child of fromChildren) {
    const k = keyOf(child);
    if (k != null) keyed.set(k, child);
  }

  let cursor = 0;
  for (const toChild of toChildren) {
    const k = keyOf(toChild);
    let target = null;

    if (k != null) {
      target = keyed.get(k) || null;
      if (target) keyed.delete(k);
    } else {
      // 按位置找一个未被 key 占用的对应节点
      while (cursor < fromChildren.length && keyOf(fromChildren[cursor]) != null) cursor++;
      target = fromChildren[cursor] || null;
      if (target) cursor++;
    }

    if (!target) {
      from.appendChild(toChild.cloneNode(true));
      continue;
    }
    if (target !== toChild) {
      const result = morph(target, toChild);
      if (result !== target) {
        // 类型不同已被替换，确保位置正确
        if (result.parentNode !== from) from.appendChild(result);
      }
    }
  }

  // 移除多余旧节点
  for (const child of Array.from(from.childNodes)) {
    const k = keyOf(child);
    if (k != null) {
      if (keyed.has(k)) child.remove();
      continue;
    }
    // 位置节点：用集合判断是否在 to 里出现过
    if (!toChildren.includes(child) && fromChildren.includes(child)) {
      const idx = fromChildren.indexOf(child);
      if (idx >= toChildren.length) child.remove();
    }
  }

  return from;
}

/**
 * 把 html 字符串打进容器，返回容器。内部用 template 解析，不触发资源加载。
 */
export function morphHtml(container, html) {
  const template = container.ownerDocument.createElement('template');
  template.innerHTML = html;
  const next = template.content;

  // 容器为空：直接整块挂上
  if (!container.firstChild) {
    container.appendChild(next.cloneNode(true));
    return container;
  }

  const scratch = container.ownerDocument.createElement(container.tagName);
  scratch.appendChild(next.cloneNode(true));
  morph(container, scratch);
  return container;
}
