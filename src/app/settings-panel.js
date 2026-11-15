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

    this.mount.appendChild(this._renderAiKeySection());
  }

  /**
   * API key 区块。
   *
   * 刻意不入 SETTINGS_SCHEMA：schema 走 localStorage，
   * 而 key 必须留在 Go 侧配置文件里，前端连回读都做不到 ——
   * 仓库有公开镜像，任何进 localStorage 或前端代码的 key 都算泄露。
   * 这里只负责「写入」和「显示是否已配置」。
   */
  _renderAiKeySection() {
    const section = document.createElement('section');
    section.className = 'set-group';

    const title = document.createElement('h3');
    title.className = 'set-group-title';
    title.textContent = 'AI 改写';
    section.appendChild(title);

    const row = document.createElement('div');
    row.className = 'set-item';

    const label = document.createElement('label');
    label.className = 'set-label';
    label.textContent = 'DeepSeek API key';
    label.htmlFor = 'set-ai-key';
    row.appendChild(label);

    const input = document.createElement('input');
    input.type = 'password';
    input.id = 'set-ai-key';
    input.className = 'set-input ai-key-input';
    input.placeholder = 'sk-...';
    input.autocomplete = 'off';
    input.spellcheck = false;
    row.appendChild(input);

    const actions = document.createElement('div');
    actions.className = 'ai-key-actions';

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn';
    save.textContent = '保存 key';

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'btn';
    clear.textContent = '清除';

    const status = document.createElement('span');
    status.className = 'ai-key-status';

    actions.appendChild(save);
    actions.appendChild(clear);
    actions.appendChild(status);
    row.appendChild(actions);

    const hint = document.createElement('div');
    hint.className = 'set-hint';
    hint.textContent = 'key 只写入本机配置文件，不经过浏览器存储，也不会出现在任何接口响应里';
    row.appendChild(hint);

    section.appendChild(row);

    // 载入状态
    this._refreshAiStatus(status);

    save.addEventListener('click', async () => {
      const value = input.value.trim();
      if (!value) {
        status.textContent = '请输入 key';
        status.className = 'ai-key-status is-warn';
        return;
      }
      status.textContent = '保存中…';
      status.className = 'ai-key-status';
      try {
        const { aiSaveKey } = await import('./api.js');
        await aiSaveKey(value);
        input.value = '';
        status.textContent = '已保存';
        status.className = 'ai-key-status is-ok';
        this._refreshAiStatus(status, true);
      } catch (err) {
        status.textContent = err.message || '保存失败';
        status.className = 'ai-key-status is-warn';
      }
    });

    clear.addEventListener('click', async () => {
      status.textContent = '清除中…';
      try {
        const { aiSaveKey } = await import('./api.js');
        await aiSaveKey('');
        status.textContent = '已清除';
        status.className = 'ai-key-status is-ok';
        this._refreshAiStatus(status, true);
      } catch (err) {
        status.textContent = err.message || '清除失败';
        status.className = 'ai-key-status is-warn';
      }
    });

    return section;
  }

  async _refreshAiStatus(statusEl, keepText = false) {
    try {
      const { aiStatus } = await import('./api.js');
      const st = await aiStatus();
      if (st.reason === 'static') {
        if (!keepText) statusEl.textContent = '静态模式不可用（需要 exe）';
        statusEl.className = 'ai-key-status is-warn';
        return;
      }
      if (st.configured) {
        const from = st.source === 'env' ? '环境变量' : '配置文件';
        statusEl.textContent = `已配置（来源：${from} · ${st.model}）`;
        statusEl.className = 'ai-key-status is-ok';
      } else if (!keepText) {
        statusEl.textContent = '未配置';
        statusEl.className = 'ai-key-status is-warn';
      }
    } catch {
      if (!keepText) statusEl.textContent = '无法查询状态';
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
