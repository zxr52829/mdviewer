/**
 * 设置面板：把 SETTINGS_SCHEMA 渲染成可操作的表单。
 *
 * 面板本身不含业务逻辑，只负责「显示当前值」和「把改动回调出去」。
 * 真正生效与应用由 app.js 调 applySettings 完成。
 */

import { SETTINGS_SCHEMA } from './settings.js';

export class SettingsPanel {
  /**
   * @param {HTMLElement} mount 挂载点
   * @param {object} settings 当前设置值
   * @param {(id:string, value:any)=>void} onChange 单项变更回调
   */
  constructor(mount, settings, onChange) {
    this.mount = mount;
    this.settings = settings;
    this.onChange = onChange;
    this._render();
  }

  _render() {
    this.mount.innerHTML = '';

    for (const group of SETTINGS_SCHEMA) {
      const section = document.createElement('section');
      section.className = 'set-group';

      const title = document.createElement('h3');
      title.className = 'set-group-title';
      title.textContent = group.group;
      section.appendChild(title);

      for (const item of group.items) {
        section.appendChild(this._renderItem(item));
      }
      this.mount.appendChild(section);
    }
  }

  _renderItem(item) {
    const row = document.createElement('div');
    row.className = 'set-item';

    const head = document.createElement('div');
    head.className = 'set-head';

    const label = document.createElement('label');
    label.className = 'set-label';
    label.textContent = item.label;
    label.htmlFor = `set-${item.id}`;
    head.appendChild(label);

    row.appendChild(head);

    let control;
    if (item.type === 'boolean') {
      control = document.createElement('input');
      control.type = 'checkbox';
      control.className = 'set-checkbox';
      control.checked = !!this.settings[item.id];
      control.addEventListener('change', () => this._commit(item, control.checked));
    } else if (item.type === 'number') {
      control = document.createElement('input');
      control.type = 'number';
      control.className = 'set-number';
      control.min = item.min;
      control.max = item.max;
      control.value = this.settings[item.id];
      // 用 change 而非 input：避免拖动/半输入状态触发重排抖动
      control.addEventListener('change', () => this._commit(item, Number(control.value)));
    } else if (item.type === 'select') {
      control = document.createElement('select');
      control.className = 'set-select';
      for (const opt of item.options) {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        if (opt.value === this.settings[item.id]) o.selected = true;
        control.appendChild(o);
      }
      control.addEventListener('change', () => this._commit(item, control.value));
    }

    control.id = `set-${item.id}`;
    row.appendChild(control);

    if (item.unit && item.type === 'number') {
      const unit = document.createElement('span');
      unit.className = 'set-unit';
      unit.textContent = item.unit;
      row.appendChild(unit);
    }

    if (item.hint) {
      const hint = document.createElement('div');
      hint.className = 'set-hint';
      hint.textContent = item.hint;
      row.appendChild(hint);
    }

    return row;
  }

  _commit(item, value) {
    this.settings[item.id] = value;
    this.onChange(item.id, value);
  }

  /** 外部改了值（如恢复默认）后刷新控件 */
  sync(settings) {
    this.settings = settings;
    this._render();
  }
}
