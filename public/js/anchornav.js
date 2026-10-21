/**
 * R73：系统设置页的**卡片锚点导航栏**（紧贴工具栏下方）。
 *
 * ## 为什么独立成模块
 *
 * 这段逻辑的全部价值在于「锚点与实际卡片**一致**」，而这个性质只能靠**真的跑一遍**
 * 验证 —— 光看源码里写了 `querySelectorAll('.sysset-card')` 证明不了它跳过了隐藏的卡片、
 * 也证明不了点击后滚到的位置对。放在 `syssettings.js` 里就没法单独加载
 * （它一进来就牵动 `main.js` 的整张模块图与顶层 `init()`），因此这里单独成模块，
 * 由 `tests/settings-ux.test.js` 配一个轻量 DOM 桩**真实执行**。
 *（R36 的 `listdialog.js`、R37 的 `speedlimit.js` 是同一个理由。）
 *
 * ## 一致性的实现方式：**不维护第二份清单**
 *
 * 卡片顺序刚在 R73 调整过（「订单取回」下移到「用户管理」之下），而 `ADMIN_ONLY_CARDS`
 * 之外还有「关于」这类对所有角色可见的卡片。任何手写清单都会在「新增 / 移动 /
 * 按角色隐藏卡片」时**静默失配**（指向错位或已不存在的卡片）。这里直接读 DOM 里的
 * `.sysset-card` 并跳过 `hidden` 的 —— 一致性由构造方式本身保证，不靠人记得同步。
 */

/**
 * 取卡片标题 —— **不含**标签徽章、状态计数与操作按钮。
 *
 * `h3` 里除了标题本身还塞着 `<span class="sysset-tag">`（「站点」「取回」这类徽章）、
 * `<span class="lk-count">`（状态计数）与保存按钮；直接 `textContent` 会把它们一起
 * 拼进来（「站点站点设置 已启用」）。克隆后摘掉这些再取文本才是干净标题。
 *
 * @param {Element} card
 * @returns {string}
 */
export function cardAnchorTitle(card) {
  const h = card && (card.querySelector('.sysset-h3') || card.querySelector('h3'));
  if (!h) return '';
  const c = h.cloneNode(true);
  c.querySelectorAll('.sysset-tag, .lk-count, .sysset-action, button, input, label').forEach((n) => n.remove());
  return (c.textContent || '').replace(/\s+/g, ' ').trim();
}

/**
 * 把某张卡片滚到锚点栏正下方。
 *
 * ⚠️ 必须**减掉锚点栏自身高度**：它是 `position: sticky` 贴在滚动容器顶部的，
 * 直接用 `scrollIntoView` 会让卡片标题被这条栏压住 —— 表现为「点了像没定位」。
 *
 * @returns {number} 计算出的目标 scrollTop
 */
export function scrollToCard(sec, bar, card) {
  const cr = card.getBoundingClientRect();
  const sr = sec.getBoundingClientRect();
  const barH = bar && !bar.hidden ? bar.offsetHeight : 0;
  const top = Math.max(0, sec.scrollTop + (cr.top - sr.top) - barH - 10);
  sec.scrollTo({ top, behavior: 'smooth' });
  return top;
}

/**
 * 现生成锚点栏。
 *
 * @returns {Element[]} 参与导航的卡片（便于测试断言「锚点数 == 卡片数」）
 */
export function buildAnchorBar() {
  const sec = document.getElementById('systemsettings');
  const bar = document.getElementById('sysset-anchorbar');
  if (!sec || !bar) return [];
  const cards = Array.from(sec.querySelectorAll('.sysset-card')).filter((c) => !c.hidden);
  bar.textContent = '';
  // 只剩一张卡片时这条导航毫无意义（普通用户就只看到「关于」）—— 整条收起
  if (cards.length < 2) {
    bar.hidden = true;
    return [];
  }
  cards.forEach((card, i) => {
    if (!card.id) card.id = `sysset-anchor-card-${i}`;
    const a = document.createElement('a');
    a.className = 'sysset-anchor-link';
    // 仍是真链接（可中键 / 右键新开），但默认跳转由下面的平滑滚动接管
    a.href = `#${card.id}`;
    a.textContent = cardAnchorTitle(card) || `卡片 ${i + 1}`;
    a.dataset.target = card.id;
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      scrollToCard(sec, bar, card);
      syncAnchorActive();
    });
    bar.appendChild(a);
  });
  bar.hidden = false;
  return cards;
}

/**
 * 高亮「当前所处卡片」—— 判据：顶边已越过锚点栏下沿、且最靠下的那一张。
 *
 * @returns {string} 当前高亮项指向的卡片 id
 */
export function syncAnchorActive() {
  const sec = document.getElementById('systemsettings');
  const bar = document.getElementById('sysset-anchorbar');
  if (!sec || !bar || bar.hidden) return '';
  const links = Array.from(bar.querySelectorAll('.sysset-anchor-link'));
  if (!links.length) return '';
  const line = sec.getBoundingClientRect().top + bar.offsetHeight + 12;
  let active = links[0];
  for (const l of links) {
    const t = document.getElementById(l.dataset.target);
    if (t && !t.hidden && t.getBoundingClientRect().top <= line) active = l;
  }
  links.forEach((l) => l.classList.toggle('active', l === active));
  return active ? active.dataset.target : '';
}

/**
 * 滚动时刷新高亮（rAF 节流：scroll 每帧都触发，不必每帧都算一遍）。
 *
 * 绑 `#systemsettings` 而不是 window —— 它自己才是滚动容器（.card-view），
 * 绑 window 收不到这个容器的滚动。
 */
export function onAnchorScroll() {
  if (onAnchorScroll._raf) return;
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
  if (!raf) { syncAnchorActive(); return; }
  onAnchorScroll._raf = raf(() => { onAnchorScroll._raf = 0; syncAnchorActive(); });
}
onAnchorScroll._raf = 0;
