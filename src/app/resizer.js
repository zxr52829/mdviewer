/**
 * 可拖动的分栏分隔条。
 *
 * 三个面板的宽度都要能调：左侧文件树、编辑区、右侧预览。
 * 实现用 pointer 事件而非 mouse 事件：
 *   - 自动处理触摸与手写笔
 *   - setPointerCapture 让拖出窗口再回来也不丢追踪
 *
 * 关键点：拖动只改**相邻面板**的 flex-basis，不动整体布局，
 * 否则会出现"拖一个把另一个挤没"或宽度总和漂移。
 */

/**
 * @param {HTMLElement} handle 分隔条元素
 * @param {object} opts
 * @param {HTMLElement} opts.before 分隔条左侧（或上侧）的被调整元素
 * @param {HTMLElement} opts.after 分隔条右侧（或下侧）的被调整元素
 * @param {'horizontal'|'vertical'} [opts.direction] horizontal = 左右分栏
 * @param {number} [opts.minBefore] 前一侧最小宽度
 * @param {number} [opts.minAfter] 后一侧最小宽度
 * @param {(beforePx:number, afterPx:number)=>void} [opts.onResize] 拖动中的回调
 * @param {(beforePx:number, afterPx:number)=>void} [opts.onEnd] 拖动结束回调
 */
export function makeResizer(handle, opts) {
  const {
    before,
    after,
    direction = 'horizontal',
    minBefore = 140,
    minAfter = 160,
    onResize,
    onEnd,
  } = opts;

  let dragging = false;
  let startPos = 0;
  let beforeStart = 0;
  let afterStart = 0;
  let lastBefore = 0;
  let lastAfter = 0;

  const isHorizontal = direction === 'horizontal';

  const getSize = (el) => (isHorizontal ? el.getBoundingClientRect().width : el.getBoundingClientRect().height);

  const applySizes = (b, a) => {
    // 用 setProperty 显式声明 important，压过 CSS 里的 `flex: 1 1 50%`：
    // 普通内联样式在带 !important 的类规则前会失效，导致拖动设的宽度
    // 被浏览器重新按 flex 分配，表现为"越拖越宽"。
    if (isHorizontal) {
      before.style.setProperty('flex', `0 0 ${b}px`, 'important');
      after.style.setProperty('flex', `0 0 ${a}px`, 'important');
      before.style.setProperty('width', `${b}px`, 'important');
      after.style.setProperty('width', `${a}px`, 'important');
    } else {
      before.style.setProperty('flex', `0 0 ${b}px`, 'important');
      after.style.setProperty('flex', `0 0 ${a}px`, 'important');
      before.style.setProperty('height', `${b}px`, 'important');
      after.style.setProperty('height', `${a}px`, 'important');
    }
  };

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startPos = isHorizontal ? e.clientX : e.clientY;
    beforeStart = getSize(before);
    afterStart = getSize(after);

    handle.setPointerCapture?.(e.pointerId);
    handle.classList.add('dragging');
    document.body.classList.add(isHorizontal ? 'resizing-h' : 'resizing-v');
    e.preventDefault();
  };

  const onPointerMove = (e) => {
    if (!dragging) return;

    const delta = (isHorizontal ? e.clientX : e.clientY) - startPos;
    const total = beforeStart + afterStart;

    // 分隔条向右移动 → 左侧变宽、右侧变窄。这是物理直觉，两个分隔条都一样。
    let b = beforeStart + delta;
    let a = afterStart - delta;

    // 双向夹紧：任何一侧触底就停住，另一侧按总数补偿。
    // 用 startPos 时的快照，不读实时宽度 —— 读实时值会让补偿量逐帧累积。
    if (b < minBefore) {
      b = minBefore;
      a = total - b;
    }
    if (a < minAfter) {
      a = minAfter;
      b = total - a;
    }

    lastBefore = b;
    lastAfter = a;
    applySizes(b, a);
    onResize?.(b, a);
  };

  const finish = (e) => {
    if (!dragging) return;
    dragging = false;
    try {
      handle.releasePointerCapture?.(e.pointerId);
    } catch {
      /* 已释放 */
    }
    handle.classList.remove('dragging');
    document.body.classList.remove('resizing-h', 'resizing-v');
    onEnd?.(lastBefore, lastAfter);
  };

  handle.addEventListener('pointerdown', onPointerDown);
  handle.addEventListener('pointermove', onPointerMove);
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);

  // 双击恢复默认宽度
  handle.addEventListener('dblclick', () => {
    for (const el of [before, after]) {
      el.style.removeProperty('flex');
      el.style.removeProperty('width');
      el.style.removeProperty('height');
    }
    onEnd?.(0, 0);
  });

  return {
    get sizes() {
      return { before: lastBefore, after: lastAfter };
    },
  };
}
