/**
 * 补全下拉列表。
 *
 * 对应 Trae 的 SuggestWidget：
 *   - 定位在光标下方，空间不够时翻到上方
 *   - 键盘可导航（上下移动、Enter/Tab 确认、Esc 关闭）
 *   - 高亮匹配到的前缀部分
 *
 * 这里只负责「显示 + 选择」，候选生成与插入由 EditorView 负责。
 */

export class SuggestWidget {
  constructor(mount) {
    this.mount = mount;
    this.items = [];
    this.activeIndex = 0;
    this.visible = false;
    this._prefix = '';

    this.el = document.createElement('div');
    this.el.className = 'suggest-widget';
    this.el.hidden = true;
    this.el.setAttribute('role', 'listbox');
    mount.appendChild(this.el);

    // 点击选择：用 mousedown 而非 click，避免焦点先被抢走导致编辑器失焦
    this.el.addEventListener('mousedown', (e) => {
      const row = e.target.closest('.suggest-item');
      if (!row) return;
      e.preventDefault();
      const idx = Number(row.dataset.index);
      if (Number.isInteger(idx)) this._commit(idx);
    });
  }

  get isVisible() {
    return this.visible;
  }

  get active() {
    return this.items[this.activeIndex] || null;
  }

  /**
   * 显示候选。
   * @param {Array} items
   * @param {string} prefix 用于高亮匹配部分
   * @param {{left:number, top:number, lineHeight:number, containerHeight:number}} pos
   *   坐标相对编辑器内容区
   */
  show(items, prefix, pos) {
    if (!items.length) {
      this.hide();
      return;
    }
    this.items = items;
    this._prefix = prefix || '';
    this.activeIndex = 0;
    this.visible = true;
    this._render();
    this._position(pos);
    this.el.hidden = false;
  }

  hide() {
    this.visible = false;
    this.el.hidden = true;
    this.items = [];
    this.activeIndex = 0;
    // 清空残留节点：只设 hidden 会留下上一轮的 .suggest-item，
    // 无障碍树和外部检查仍能读到它们，看起来像"列表没跟着更新"。
    this.el.textContent = '';
  }

  /** 上下移动，循环 */
  move(delta) {
    if (!this.visible || !this.items.length) return;
    const n = this.items.length;
    this.activeIndex = (this.activeIndex + delta + n) % n;
    this._updateActive();
  }

  /** 翻页 */
  movePage(delta) {
    if (!this.visible || !this.items.length) return;
    const page = 8;
    const n = this.items.length;
    this.activeIndex = Math.max(0, Math.min(n - 1, this.activeIndex + delta * page));
    this._updateActive();
  }

  _updateActive() {
    const rows = this.el.querySelectorAll('.suggest-item');
    rows.forEach((row, i) => {
      row.classList.toggle('active', i === this.activeIndex);
    });
    const active = rows[this.activeIndex];
    if (active && active.scrollIntoView) {
      active.scrollIntoView({ block: 'nearest' });
    }
  }

  _commit(index) {
    const item = this.items[index];
    if (item && this.onAccept) this.onAccept(item);
  }

  /** 由外部设置接受回调 */
  onAccept = null;

  _render() {
    const frag = document.createDocumentFragment();
    this.items.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'suggest-item' + (i === 0 ? ' active' : '');
      row.dataset.index = String(i);
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', i === 0 ? 'true' : 'false');

      const kind = document.createElement('span');
      kind.className = `suggest-kind k-${item.kind}`;
      kind.textContent = kindIcon(item.kind);

      const label = document.createElement('span');
      label.className = 'suggest-label';
      // 高亮已输入的前缀
      const p = this._prefix;
      const lowerLabel = item.label.toLowerCase();
      const lowerP = p.toLowerCase();
      const at = lowerP ? lowerLabel.indexOf(lowerP) : -1;
      if (at >= 0) {
        label.append(
          escapeSpan(item.label.slice(0, at)),
          Object.assign(document.createElement('span'), {
            className: 'suggest-match',
            textContent: item.label.slice(at, at + p.length),
          }),
          escapeSpan(item.label.slice(at + p.length)),
        );
      } else {
        label.textContent = item.label;
      }

      row.append(kind, label);

      if (item.detail) {
        const detail = document.createElement('span');
        detail.className = 'suggest-detail';
        detail.textContent = item.detail;
        row.appendChild(detail);
      }

      frag.appendChild(row);
    });

    this.el.innerHTML = '';
    this.el.appendChild(frag);
  }

  _position(pos) {
    const { left, top, lineHeight, containerHeight } = pos;
    const rowH = 22;
    const maxH = 220;
    const estH = Math.min(maxH, this.items.length * rowH + 8);

    // 默认放在光标下一行；下方空间不足且上方更宽裕时翻上去
    let y = top + lineHeight;
    if (y + estH > containerHeight && top - estH > 0) {
      y = top - estH;
    }

    this.el.style.left = `${Math.max(0, left)}px`;
    this.el.style.top = `${y}px`;
    this.el.style.maxHeight = `${maxH}px`;
  }
}

function escapeSpan(text) {
  const s = document.createElement('span');
  s.textContent = text;
  return s;
}

function kindIcon(kind) {
  switch (kind) {
    case 'keyword':
      return 'K';
    case 'snippet':
      return 'S';
    default:
      return 'A';
  }
}
