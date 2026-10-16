/**
 * R44：侧边栏「文件类型」筛选。
 *
 * 取代原先的「文件夹导航」树 —— 那棵树与顶部的地址栏（面包屑）在做同一件事：
 * 在目录之间跳转。重复的导航入口只会让侧栏挤占空间，而「按类型筛掉不相关文件」
 * 是地址栏给不了的能力，因此把这个位置让给它。
 *
 * 职责边界（刻意的）：
 *  - 本模块**只负责 UI**：渲染 7 个类型项、显示各类型在当前目录里的数量、把点击
 *    翻译成 `App.state.typeFilter` 的取值；
 *  - 「什么算该类型」由 `util.js` 的 `FILE_TYPES` 给出（与服务端 `TYPE_EXT` 同源，
 *    前端不另存一份后缀表）；
 *  - 「过滤后显示哪些项」只有 `explorer.js` 的 `visibleItems()` 一份实现 ——
 *    若侧栏也过滤一遍，两处规则迟早会不一致（一个按类型、一个忘了排除文件夹）。
 *
 * 语义：筛选作用于**当前目录**（当前前缀）已加载的列表，纯前端即时生效、不发请求；
 * 选中某个具体类型时**文件夹不显示**（文件夹不属于任何文件类型），「全部」恢复显示。
 */
import { explorer } from './explorer.js';
import { FILE_TYPES } from './util.js';

export const filetype = {
  init() {
    const el = document.getElementById('filetype');
    if (!el) return;
    el.innerHTML = FILE_TYPES.map((t) => `
      <div class="ft-row" data-type="${t.id}" role="button" tabindex="0" title="${t.id ? '只看' + t.label : '显示全部文件'}">
        <span class="ft-ic">${chipIcon(t)}</span>
        <span class="ft-lb">${t.label}</span>
        <span class="ft-ct" data-count="${t.id}"></span>
      </div>`).join('');
    el.querySelectorAll('.ft-row').forEach((row) => {
      const pick = () => explorer.setTypeFilter(row.dataset.type);
      row.onclick = pick;
      row.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
    });
    // 只在第一次 init 时订阅：登录 / 换桶会再次调用 init()，重复订阅会叠加回调
    if (!this._subscribed) {
      explorer.onListChanged(() => this.sync());
      this._subscribed = true;
    }
    this.sync();
  },

  /** 重算各类型数量并高亮当前选中项（列表每次变化后由 explorer 回调） */
  sync() {
    const el = document.getElementById('filetype');
    if (!el) return;
    const items = explorer.allItems();
    const counts = new Map();
    for (const it of items) counts.set(it.isFolder ? 'folder' : it.type, (counts.get(it.isFolder ? 'folder' : it.type) || 0) + 1);
    const active = explorer.currentTypeFilter();
    el.querySelectorAll('.ft-row').forEach((row) => {
      const t = row.dataset.type;
      // 「全部」= 目录里的**所有条目**（含文件夹）；具体类型只数文件（文件夹不参与分类）
      const n = t === '' ? items.length : (counts.get(t) || 0);
      const ct = row.querySelector('.ft-ct');
      if (ct) {
        ct.textContent = String(n);
        ct.hidden = n === 0 && t !== '';
      }
      row.classList.toggle('active', t === active);
    });
  },
};

/**
 * 类型项左侧的小图标。
 *
 * 有分类的走雪碧里的同款图标（与文件列表里看到的完全一致，用户一眼能对上）；
 * 「全部」没有对应的文件类型，故用一枚中性底色的四宫格，保持整列的视觉节奏。
 */
function chipIcon(t) {
  const id = t.icon || 'fic-all';
  return `<svg class="fic" viewBox="0 0 1024 1024" aria-hidden="true"><use href="#${id}"></use></svg>`;
}
