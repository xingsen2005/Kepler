/** 文件操作 —— 新建 / 重命名 / 移动 / 删除 / 下载 / 复制链接 */
import { API } from './api.js';
import { toast, confirmDialog, promptDialog, openModal, escapeHtml, fmtSize, fmtTime, isStaffRole } from './util.js';
import { App } from './main.js';
import { openDownload } from './enc.js';
// R37：文件分享的「下载限速」与「链接管理」是**同一份字段**（同一条分享记录上的
// `speedLimit`），因此单位换算、入参校验、上层提示文案都复用同一个实现点，
// 避免两个入口各写一套（最典型的分叉是「一边允许负号、另一边拦住」）。
import { parseMbpsInput, ceilingText, fetchCeiling, toMBps } from './speedlimit.js';

export const ops = {
  needConfig() {
    const isAdmin = isStaffRole(App.state.user && App.state.user.role);
    if (isAdmin) {
      toast('请先在密钥管理中配置访问密钥与存储桶', { type: 'warn' });
      import('./settings.js').then((m) => m.settings.open());
    } else {
      toast('尚未配置访问密钥，请联系管理员', { type: 'warn' });
    }
  },

  async newFolder() {
    if (!configured()) return this.needConfig();
    const name = await promptDialog({
      title: '新建文件夹', label: '文件夹名称',
      hint: '支持多级创建：输入 a/b/c 将逐级创建',
    });
    if (!name) return;
    if (/[\\:*?"<>|]/.test(name)) return toast('名称不能包含 \\ / : * ? " < > | 字符', { type: 'error' });
    try {
      // 多级创建：逐级 mkdir
      const parts = name.split('/').filter(Boolean);
      let cur = App.state.prefix;
      for (const p of parts) {
        await API.mkdir(cur + p + '/');
        cur += p + '/';
      }
      toast('文件夹已创建', { type: 'success' });
      explorerRefresh();
    } catch (e) {
      toast(e.message, { type: 'error' });
    }
  },

  renameSelected() {
    const s = App.state.selection;
    if (s.size !== 1) return;
    this.renameOne([...s][0]);
  },

  async renameOne(key) {
    /**
     * R27-01：原实现调用 `currentItems()` —— 该标识符**全库从未定义**，而抛错点在
     * 下面的 `try` 之外、`renameSelected()` 又没有 `await`/`catch`，于是重命名
     * （工具栏 `#op-rename` / F2 / 右键菜单三个入口）整体变成一个 rejected promise：
     * 对话框不弹、无提示、无任何反应。
     *
     * 列表项的唯一归属地是 `explorer` 模块的私有 `state.items`，这里用与
     * `explorerRefresh()` 同源的**动态 import** 取用（静态 import 会与
     * `explorer.js → main.js → ops.js` 形成循环）。
     */
    const { explorer } = await import('./explorer.js');
    const item = explorer.itemOf(key);
    const oldName = key.endsWith('/') ? key.slice(0, -1).split('/').pop() : key.split('/').pop();
    const name = await promptDialog({ title: '重命名', label: '新名称', value: oldName });
    if (!name || name === oldName) return;
    if (/[\\/:*?"<>|]/.test(name)) return toast('名称不能包含 \\ / : * ? " < > | 字符', { type: 'error' });
    try {
      toast('正在重命名…');
      await API.rename(key, name, item ? item.size : 0);
      toast('重命名完成', { type: 'success' });
      // R90：这里原本连着调了两次 explorerRefresh() —— 每次都是一整轮 /fs/list
      // 往返，用户看到的是「重命名完成后列表闪一下再闪一下」。一次就够。
      explorerRefresh();
    } catch (e) {
      toast('重命名失败：' + e.message, { type: 'error' });
    }
  },

  deleteSelected() { this.deleteKeys([...App.state.selection]); },

  async deleteKeys(keys) {
    if (!keys.length) return;
    if (!configured()) return this.needConfig();
    const desc = keys.length === 1
      ? `“${escapeHtml(displayName(keys[0]))}”`
      : `${keys.length} 项（含其内部全部内容）`;
    const ok = await confirmDialog({ allowHtml: true,
      title: '确认删除',
      message: `确定要永久删除 ${desc} 吗？<br><b style="color:var(--danger)">删除后无法恢复。</b>`,
      okText: '永久删除', danger: true,
    });
    if (!ok) return;
    try {
      toast('正在删除…');
      const r = await API.del(keys);
      const failed = (r.results || []).filter((x) => !x.ok);
      if (failed.length) toast(`删除完成，${failed.length} 项失败：${failed[0].error}`, { type: 'warn', duration: 6000 });
      else toast(`已删除（共 ${r.deleted} 个对象）`, { type: 'success' });
      App.state.selection.clear();
      updateOpsButtons();
      explorerRefresh();
      App.refreshStorage && App.refreshStorage(); // 立即刷新状态栏存储用量
    } catch (e) {
      toast('删除失败：' + e.message, { type: 'error' });
    }
  },

  moveSelected() { this.moveKeysTo([...App.state.selection]); },

  /**
   * 移动选中的项到目标目录。
   *
   * R52-02 修的就是这个方法「前端报成功、实际没动」的老毛病。两个根因：
   *
   * ① 目标被**默认预选成当前目录**。`openFolderPicker` 原先 `let selected =
   *    fixedTarget || App.state.prefix`，而 `fixedTarget` 只有「拖到文件夹行上」
   *    这一条路径才会给 —— 于是从工具栏 / 右键点「移动」时，目标**默认就等于
   *    这些文件自己的父目录**，服务端算出的 `newKey === key`，直接返回
   *    `{ok:true, skipped:true}` 什么也没搬。用户点了「移动」，弹窗里一路默认
   *    确认下去，看到的是「移动完成」，文件却纹丝不动。
   *    现在改为**不预选**（`selected = null`），必须显式点一个目录才能确定；
   *    当前目录在树里只作「当前位置」提示，不再冒充已选项。
   *
   * ② `skipped` 被**当成成功**统计。服务端对「本来就在目标位置」的项返回
   *    `{ok:true, skipped:true}`（见 `server/routes/fs.js` 的 `moveOne`），旧代码
   *    只筛 `!x.ok`，于是「跳过 N 项」也报成「移动完成」。现在三类分开数：
   *    **成功 / 跳过 / 失败**，跳过不再冒充成功。
   *
   * 另外在提交前就拦住「目标与源完全相同」这种纯粹的空操作，比让用户看着
   * 一句轻飘飘的「移动完成」要有用得多。
   */
  moveKeysTo(keys, fixedTarget) {
    if (!keys.length) return;
    if (!configured()) return this.needConfig();
    openFolderPicker({
      title: `移动 ${keys.length} 项到…`,
      confirmText: '移动',
      fixedTarget,
      exclude: keys,
      onPick: async (targetPrefix) => {
        // 空操作拦截：所有项本来就在目标目录里 ⇒ 一次云端往返都不必发
        const same = keys.filter((k) => parentPrefixOf(k) === targetPrefix);
        if (same.length === keys.length) {
          toast('所选项目已经在该文件夹中，无需移动', { type: 'warn', duration: 5000 });
          return;
        }
        try {
          toast('正在移动…');
          const r = await API.move(keys, targetPrefix);
          const out = Array.isArray(r.results) ? r.results : [];
          const moved = out.filter((x) => x.ok && !x.skipped).length;
          const skipped = out.filter((x) => x.ok && x.skipped).length;
          const failed = out.filter((x) => !x.ok);
          const to = targetPrefix || '根目录';
          if (failed.length) {
            toast(`移动未全部完成：成功 ${moved} 项、跳过 ${skipped} 项、失败 ${failed.length} 项。首个错误：${failed[0].error}`, { type: 'error', duration: 8000 });
          } else if (!moved) {
            // 全被跳过 —— 不能报「完成」，那正是这条 bug 的原始症状
            toast(`未移动任何项目：${skipped} 项本就在「${to}」中`, { type: 'warn', duration: 6000 });
          } else if (skipped) {
            toast(`已移动 ${moved} 项到「${to}」，${skipped} 项本就在该文件夹中已跳过`, { type: 'success', duration: 6000 });
          } else {
            toast(`已移动 ${moved} 项到「${to}」`, { type: 'success' });
          }
          App.state.selection.clear();
          updateOpsButtons();
          explorerRefresh();
        } catch (e) {
          toast('移动失败：' + e.message, { type: 'error' });
        }
      },
    });
  },

  downloadSelected() { this.downloadKeys([...App.state.selection]); },

  downloadKeys(keys) {
    const files = keys.filter((k) => !k.endsWith('/'));
    if (!files.length) return toast('文件夹不支持直接下载，请选择文件', { type: 'warn' });
    if (files.length > 5) {
      toast(`将依次下载 ${files.length} 个文件，请在浏览器下载提示中确认`, { type: 'info', duration: 5000 });
    }
    files.forEach((k, i) => {
      setTimeout(() => openDownload(k), i * 600); // 加密文件自动先验证权限并携带令牌
    });
  },

  /* ------------------------- 复制 / 粘贴（R52-03） ------------------------- */

  copySelected() { this.copyKeys([...App.state.selection]); },

  /**
   * 把选中的项放进「剪贴板」。
   *
   * 剪贴板内容是可序列化的 `{ keys, at }`，存 `sessionStorage`（与分享页的勾选状态
   * 同一理由：这是**当前标签页**的临时状态，不该跨标签页、更不该在关掉浏览器后还留着，
   * 也不该被别的标签页的复制动作覆盖成半份）。
   *
   * 这里**只做「复制」**，不做「剪切」。UI 上少一个「剪切」按钮不是遗漏 ——
   * 剪切语义是「粘贴成功后才删源」，而复制接口的冲突协议允许**逐项跳过**，
   * 于是「粘贴了一半」时源该删哪些、不该删哪些，是一套需要单独设计并验证的
   * 事务语义。在没有把它做对之前，给一个会静默丢数据的「剪切」比不给更糟。
   */
  copyKeys(keys) {
    const list = (Array.isArray(keys) ? keys : []).filter((k) => typeof k === 'string' && k);
    if (!list.length) return toast('请选择要复制的文件或文件夹', { type: 'warn' });
    writeClipboard(list);
    toast(`已复制 ${list.length} 项，可在目标文件夹右键「粘贴」`, { type: 'success' });
  },

  /** 粘贴到当前目录（工具栏按钮 / Ctrl+V / 空白处右键） */
  paste() { return this.pasteTo(App.state.prefix || ''); },

  /** 剪贴板里的项数（0 表示空）。供右键菜单把「粘贴」标成「粘贴（N 项）」 */
  clipboardCount() {
    const clip = readClipboard();
    return clip ? clip.keys.length : 0;
  },

  /**
   * 粘贴到指定目录（文件夹行右键的「粘贴到此处」）。
   *
   * 两段式提交：第一次**不带** `decisions`，服务端只探测冲突；回 `needsDecision` 时
   * 逐项问用户「覆盖 / 跳过」，再把决策带回去重发 —— 详见 `server/routes/fs.js`
   * 的 `POST /fs/copy`。绝不能省略第一段直接「默认覆盖」：云端覆盖不可撤销。
   */
  async pasteTo(targetPrefix) {
    const clip = readClipboard();
    if (!clip || !clip.keys.length) return toast('剪贴板为空，请先复制文件或文件夹', { type: 'warn' });
    if (!configured()) return this.needConfig();
    const dest = String(targetPrefix || '');
    const destLabel = dest || '根目录';
    const keys = clip.keys.filter((k) => k !== dest); // 粘到自己所在位置没有意义，先摘掉
    if (!keys.length) return toast('这些项目本来就在目标文件夹中，无需粘贴', { type: 'warn' });
    try {
      toast('正在复制…');
      let r = await API.copy(keys, dest);
      if (r && r.needsDecision) {
        const decisions = await resolveCopyConflicts(r.conflicts || []);
        if (!decisions) return toast('已取消复制', { type: 'info' });
        toast('正在复制…');
        r = await API.copy(keys, dest, decisions);
        // 第二轮理论上仍可能回 needsDecision（例如询问途中目标又被别的会话改写），
        // 此时不再弹第二轮 —— 如实说出来，而不是假装成功
        if (r && r.needsDecision) return toast('目标位置在询问期间发生变化，请重新粘贴', { type: 'warn', duration: 6000 });
      }
      summarizeCopy(r, destLabel);
      App.state.selection.clear();
      updateOpsButtons();
      explorerRefresh();
    } catch (e) {
      toast('复制失败：' + e.message, { type: 'error', duration: 8000 });
    }
  },

  copyLinkSelected() { this.copyLinkKeys([...App.state.selection]); },

  /**
   * 创建分享链接（有效期 / 次数 / 密码可任意组合；也可生成预签名直链）。
   *
   * R51 起支持**多文件与文件夹**：`keys` 是任意长度的数组，元素可以是文件 key
   * 或**以 `/` 结尾的目录前缀**。服务端会为它们做一份创建时冻结的条目快照，
   * 分享页据此渲染分页列表。
   *
   * 「预签名直链」这个单选项只有**单选一个普通文件**时才可用 —— 直链是
   * 「对某个 key 签名」的能力，一次只能签一个对象；多选或含目录时它没有意义
   * （旧实现直接把这种组合拒掉了，现在改为把不可用的选项当场禁用并说明原因，
   * 比让人选完再报错更好懂）。
   */
  async copyLinkKeys(keys) {
    const list = (Array.isArray(keys) ? keys : []).filter((k) => typeof k === 'string' && k);
    if (!list.length) return toast('请选择要分享的文件或文件夹', { type: 'warn' });
    const singleFile = list.length === 1 && !list[0].endsWith('/');
    // 预览：最多列 6 条，其余折成「…还有 N 项」。长路径要能换行，否则会把弹窗撑破。
    const shown = list.slice(0, 6).map((k) => `<div style="word-break:break-all">· ${escapeHtml(k)}</div>`).join('');
    const more = list.length > 6 ? `<div>· …还有 ${list.length - 6} 项</div>` : '';

    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="form-item"><label>分享内容${list.length > 1 ? `（${list.length} 项）` : ''}</label>
        <div class="hint">${shown}${more}</div></div>
      <div class="form-item"><label>链接类型</label>
        <div class="link-type-row">
          <label class="radio-line"><input type="radio" name="lk-type" value="managed" checked>  托管链接<i class="rl-sub"> · 支持有效期 / 次数 / 密码，访问者经本服务下载</i></label>
          <label class="radio-line"><input type="radio" name="lk-type" value="direct"${singleFile ? '' : ' disabled'}>  预签名直链<b>（高危）</b><i class="rl-sub"> · 不经过本服务，仅支持有效期</i></label>
        </div>
        ${singleFile ? '' : '<div class="hint">预签名直链一次只能签一个文件，因此多选或包含文件夹时只有托管链接可用。</div>'}</div>
      <div class="form-item"><label>链接有效时间</label>
        <select id="lk-expires" class="full">
          <option value="1">1 小时</option>
          <option value="24">1 天</option>
          <option value="168" selected>7 天</option>
          <option value="720">30 天</option>
          <option value="0">永久有效</option>
        </select>
        <div class="hint">到期后链接自动失效，访问时提示"链接已过期"。</div></div>
      <div id="lk-managed-fields">
        <div class="form-item"><label>可下载次数</label>
          <input id="lk-count" type="number" min="0" step="1" value="0" placeholder="0">
          <div class="hint">允许的最大下载次数，达到上限后链接自动关闭；填 0 表示不限制。</div></div>
        <div class="form-item"><label>访问密码</label>
          <label class="check-line"><input id="lk-pw-on" type="checkbox">  启用密码保护</label>
          <input id="lk-pw" type="text" maxlength="64" placeholder="访问者需输入此密码才能下载" disabled autocomplete="off">
          <div class="hint">启用后，访问者需输入正确密码方可下载。</div></div>
        <div class="form-item"><label>付费下载</label>
          <label class="check-line"><input id="lk-paid-on" type="checkbox">  需要付费后才能下载</label>
          <div id="lk-paid-row" style="display:none;margin-top:8px">
            <input id="lk-paid-amount" type="number" min="0.01" step="0.01" value="1.00" placeholder="1.00">
            <div class="hint">当前仅支持人民币（CNY），最低 <b>0.01</b> 元。下载者完成支付后方可取得下载权限；未支付、支付中或支付失败时会被拦截并给出提示。</div>
          </div></div>
        <div class="form-item"><label>下载限速</label>
          <div class="sl-line" style="margin-top:2px">
            <input id="lk-speed" class="sl-input" type="number" min="0" step="0.1" placeholder="0" value="" autocomplete="off">
            <span class="sl-unit">MB/s</span>
          </div>
          <div class="hint">填 <b>0</b> 或留空表示<b>不限速</b>。限速按<b>链接聚合</b>：这条链接上的并发下载共享这一份带宽。上层（API Key / 存储桶 / 用户）若已设了更小的值，实际按那个更小的走。</div>
          <div class="sl-ceil" id="lk-speed-ceil" hidden></div></div>
      </div>`;

    const expiresSel = wrap.querySelector('#lk-expires');
    const countInput = wrap.querySelector('#lk-count');
    const pwOn = wrap.querySelector('#lk-pw-on');
    const pwInput = wrap.querySelector('#lk-pw');
    const paidOn = wrap.querySelector('#lk-paid-on');
    const paidRow = wrap.querySelector('#lk-paid-row');
    const paidAmount = wrap.querySelector('#lk-paid-amount');
    const managedFields = wrap.querySelector('#lk-managed-fields');
    const speedInput = wrap.querySelector('#lk-speed');
    const speedCeil = wrap.querySelector('#lk-speed-ceil');
    pwOn.addEventListener('change', () => { pwInput.disabled = !pwOn.checked; if (pwOn.checked) pwInput.focus(); });
    paidOn.addEventListener('change', () => {
      paidRow.style.display = paidOn.checked ? '' : 'none';
      if (paidOn.checked) paidAmount.focus();
    });
    wrap.querySelectorAll('input[name=lk-type]').forEach((r) => {
      r.addEventListener('change', () => {
        const direct = wrap.querySelector('input[name=lk-type]:checked').value === 'direct';
        managedFields.style.display = direct ? 'none' : '';
        if (direct) expiresSel.value = expiresSel.value === '0' ? '168' : expiresSel.value; // 直链不支持永久
        expiresSel.querySelector('option[value="0"]').disabled = direct;
      });
    });

    // R37：上层限速提示。需求原文：在「文件分享」里设限速时，若 API Key 管理已设了
    // 更小的值，要提示「已在 API Key 管理中设置限速为 xx MB/S」。
    //
    // 「这个桶归哪把密钥」的归属判据**只在服务端**（`config-store.activeCredential`），
    // 所以提示值一律向 `/throttle/ceiling` 要 —— 在浏览器里重写一份归属推导，
    // 必然与下载时真正生效的那份分叉（前端算出一个数、实际按另一个数跑）。
    // 异步查、失败降级为「无提示」：提示不能成为保存的前置条件。
    // 此刻链接还不存在，因此按「当前生效桶」查；创建者就是当前登录用户。
    let ceilData = null;
    const refreshCeil = () => {
      const r = parseMbpsInput(speedInput.value);
      const txt = ceilingText(ceilData, r.ok ? r.bytes : 0);
      speedCeil.hidden = !txt;
      speedCeil.textContent = txt;
    };
    speedInput.addEventListener('input', refreshCeil);
    refreshCeil();
    (async () => {
      const bucketName = (App.state.config && App.state.config.bucket) || App.state.bucket || '';
      if (!bucketName) return;
      ceilData = await fetchCeiling({ scope: 'link', bucket: bucketName });
      refreshCeil();
    })();

    const modal = openModal({
      title: '创建分享链接', body: wrap,
      foot: [
        { text: '取消' },
        { text: '生成链接', cls: 'primary', onClick: async (o, close) => {
          const hours = Number(expiresSel.value) || 0;
          const direct = wrap.querySelector('input[name=lk-type]:checked').value === 'direct';
          try {
            if (direct) {
              // 双保险：单选项在非「单选一个文件」时已被 disable，这里再判一次
              if (!singleFile) return toast('预签名直链只能用于单个文件', { type: 'error' });
              const r = await API.presign(list[0], hours || 3600);
              const cfg = App.state.config || {};
              let url = r.url;
              const domain = cfg.domains && cfg.domains.primary;
              if (domain) {
                try {
                  const u = new URL(url);
                  url = 'https://' + domain.replace(/^https?:\/\//, '') + u.pathname + u.search;
                } catch (e) { /* 保持原地址 */ }
              }
              close();
              // 直链没有服务端记录，`fileName` 由这里补上（改版后的弹窗要显示文件名）
              showLinkResult(url, { direct: true, hours, fileName: list[0] });
              return;
            }
            // R51：多文件 / 文件夹走 `paths`；单个文件也统一走它（服务端对单文件
            // 落盘成与旧记录完全一致的形态，故不必再分两条路径）。
            const body = { paths: list, expiresHours: hours || null };
            // 次数校验
            const cnt = countInput.value.trim();
            if (cnt !== '') {
              const n = Number(cnt);
              if (!Number.isInteger(n) || n < 0) return toast('可下载次数必须是不小于 0 的整数（0 表示不限制）', { type: 'error' });
              body.maxDownloads = n;
            }
            // 密码校验
            if (pwOn.checked) {
              const pw = pwInput.value;
              if (!pw) return toast('已启用密码保护，请填写访问密码', { type: 'error' });
              // R94（审核 M08-05）：下界与服务端同日提到 6（单字符口令等于没有保护）
              if (pw.length < 6) return toast('访问密码至少 6 个字符', { type: 'error' });
              if (pw.length > 64) return toast('密码长度不能超过 64 个字符', { type: 'error' });
              body.password = pw;
            }
            // 付费校验（最低 0.01 元；金额以元提交，服务端转「分」存储）
            if (paidOn.checked) {
              const amount = Number(paidAmount.value);
              if (!Number.isFinite(amount) || amount < 0.01) {
                return toast('付费金额最低 0.01 元', { type: 'error' });
              }
              body.paid = { required: true, amount };
            }
            // 下载限速（R37）：0 / 留空 = 不限速。判据与服务端 `limits.parseSpeedLimitInput`
            // 完全一致（前端这一层只为当场给出看得懂的提示，服务端仍会再校验一次）。
            // 刻意**不**因「超过上层限制」而拒绝保存 —— 允许多层配置里先把下层配好、
            // 等上层放宽后自然生效；实际速率由服务端取各层最小值。
            const sp = parseMbpsInput(speedInput.value);
            if (!sp.ok) return toast(sp.error, { type: 'error' });
            body.speedLimit = sp.bytes;
            const r = await API.createLink(body);
            close();
            const url = location.origin + '/s/' + r.id;
            showLinkResult(url, { hours, maxDownloads: r.maxDownloads, hasPassword: r.hasPassword, link: r, warn: r.warn });
            // 条目超过快照上限时服务端**如实上报**而不是静默截断 —— 让用户当场知道
            // 分享里只有前 N 项，而不是过几天发现少了一半文件。
            if (r.truncated) {
              toast(`内容较多，仅快照了前 ${r.snapshotMax} 项（多出的部分未包含在这条分享里）`, { type: 'warn' });
            }
          } catch (e) {
            toast('创建链接失败：' + e.message, { type: 'error' });
          }
        } },
      ],
    });
    return modal;
  },
};

/**
 * 复制文本到剪贴板，返回是否成功。
 *
 * R50：`navigator.clipboard` 只在**安全上下文**（`https://` 或 `localhost`）存在，
 * 而本服务最常见的部署方式是「局域网 IP + 自签名/无证书」——那里它是
 * `undefined`，且 `http://` 页面下连 `writeText` 都没有。故必须有
 * `execCommand('copy')` 这条回退，否则用户点「复制」只能拿到一句
 * 「请手动选择复制」，而框选一段 URL 在手势上并不轻松。
 */
async function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) { /* 无权限 / 页面失焦 → 走下面的回退 */ }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', 'readonly');
    // 不能 `display:none` —— 隐藏元素无法被 select()，execCommand 会返回 false
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) {
    return false;
  }
}

/**
 * 「链接创建成功」弹窗（R50 改版）。
 *
 * 改动前：一个只读 `<textarea>` 装链接 + 一行文字摘要，右对齐的信息全靠逗号拼接，
 * 没有二维码（用户要扫码只能在手机上手打一长串地址）。
 *
 * 改动后：**左侧二维码、右侧信息**——
 *  - 链接用 `<div>` 展示（可选中、自动折行），旁边一枚「复制」按钮；
 *  - 逐项列出：文件名 / 创建时间 / 过期时间 / 价格 / 允许下载次数；
 *  - 二维码由服务端生成（`GET /api/links/qrcode`，复用零依赖的
 *    `server/qrcode.js`），前端不引任何二维码库。
 *
 * ⚠️ 二维码**可能生成不出来**：`qrcode.js` 目前止于版本 10（纠错级别 M），
 * 约 213 字节封顶。托管链接（`https://<域名>/s/<22 字符>`）远在限额内；
 * 但**预签名直链**带 `q-signature` 等查询串，通常 400+ 字节，编不出来。
 * 这时服务端回 400 且说明原因，弹窗里那个位置改成一行说明 —— 不能把
 * 「生成失败」渲染成一个空白的方块让用户对着扫码。
 *
 * @param {string} url 最终展示（也是被编码进二维码）的链接
 * @param {object} opt {direct, hours, maxDownloads, hasPassword, link, warn, fileName}
 */
function showLinkResult(url, opt = {}) {
  const l = opt.link || null;
  // 直链没有服务端记录：只有「刚才」「N 小时之后」这两个事实可陈述。
  // ⚠️ 兜底必须与 `API.presign(key, hours || 3600)` 一致 —— 直链不支持「永久」，
  // 若这里照 `opt.hours`（可能是 0）显示「永久有效」，页面就是在撒谎。
  const effHours = opt.hours || 3600;
  const createdAt = (l && l.createdAt) || new Date().toISOString();
  const expiresAt = l ? l.expiresAt : new Date(Date.now() + effHours * 3600e3).toISOString();
  const fileName = (l && l.fileName) || opt.fileName || '';
  const maxDownloads = l ? l.maxDownloads : (opt.maxDownloads || 0);
  const paid = l && l.paid && l.paid.required
    ? '¥' + (l.paid.amountFen / 100).toFixed(2)
    : '免费';
  const rows = [
    ['文件名', fileName],
    ['链接创建时间', fmtTime(createdAt)],
    ['过期时间', expiresAt ? fmtTime(expiresAt) : '永久有效'],
    ['价格', paid],
    ['允许下载次数', maxDownloads > 0 ? maxDownloads + ' 次' : '不限制'],
    // R37 的内容如实保留：这里陈述的是「这条记录上写了什么」，不是实际生效值
    // （实际速率由服务端取各层最小值，可能更小）。改版时未删除，只是并入信息区。
    //
    // ⚠️ 这**六**行的自然高度（≈180px）与左侧二维码框的尺寸是一对约束：两者视觉等高。
    // 增删任何一行都会让右侧与左侧差出一截，届时请同步调整 `style.css` 里
    // `.lr-qr` / `.lr-qr svg` 的尺寸，而不是把行注释掉（那样会同时丢掉需求要求展示的信息）。
    ['下载限速', (l && l.speedLimit) ? toMBps(l.speedLimit) + ' MB/s' : '不限速'],
  ];
  const metaHtml = rows.map(([k, v]) => `<div class="lr-row"><span>${k}</span><b>${escapeHtml(v)}</b></div>`).join('');

  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="ok-note">链接创建成功</div>
    <div class="lr-wrap">
      <div class="lr-qr" id="lr-qr"><div class="lr-qr-note">二维码生成中…</div></div>
      <div class="lr-main">
        <div class="lr-url-row">
          <div class="lr-url" id="lr-url">${escapeHtml(url)}</div>
          <button class="btn" id="lr-copy" title="复制链接">复制</button>
        </div>
        <div class="lr-meta">${metaHtml}</div>
      </div>
    </div>
    ${opt.warn ? `<div class="form-msg show bad" style="margin-top:10px">${escapeHtml(opt.warn)}</div>` : ''}
    <div class="hint">${opt.direct
      ? '预签名直链不经过本服务，访问者直接从对象存储下载。'
      : '托管链接由本服务在线时提供下载；可在侧边栏“链接管理”中随时编辑或删除。'}</div>`;

  const qrBox = wrap.querySelector('#lr-qr');
  const copyBtn = wrap.querySelector('#lr-copy');
  copyBtn.onclick = async () => {
    const ok = await copyText(url);
    toast(ok ? '链接已复制到剪贴板' : '复制失败，请手动选择复制', { type: ok ? 'success' : 'warn' });
  };

  // 二维码：异步取、不阻塞弹窗出现（远端不可达时也照样能复制链接）
  (async () => {
    try {
      const r = await API.linkQrcode(url);
      if (r && r.svg) qrBox.innerHTML = r.svg;
      else qrBox.innerHTML = '<div class="lr-qr-note">二维码生成失败</div>';
    } catch (e) {
      qrBox.innerHTML = `<div class="lr-qr-note">${escapeHtml(e.message || '二维码生成失败')}</div>`;
    }
  })();

  openModal({
    title: '分享链接', body: wrap,
    // R51：链接要「一行显示完」——默认 480px 的弹窗减去左侧二维码后只剩 ~290px，
    // 再长的地址必然折行。宽度按内容给（见 style.css 的 .link-result-dialog）。
    cls: 'link-result-dialog',
    foot: [{ text: '关闭', cls: 'primary' }],
  });
}

/* ------------------------- 复制 / 粘贴的剪贴板与冲突询问（R52-03） ------------------------- */

/**
 * 剪贴板的存储键。
 *
 * 用 `sessionStorage`（与分享页的勾选状态同一理由）：它是**当前标签页**的临时状态，
 * 不该跨标签页共享，更不该在关掉浏览器后还留着一份「上次复制的文件」。
 * `localStorage` 在这里还有个具体坏处 —— 同一个浏览器里开着两个标签页时，
 * 后一个标签页的复制会静默改掉前一个的剪贴板内容。
 */
const CLIP_KEY = 'kepler.fs.clipboard';

/** 读写剪贴板都包 try：隐私模式 / 存储被禁用时 sessionStorage 会抛异常 */
function writeClipboard(keys) {
  try {
    sessionStorage.setItem(CLIP_KEY, JSON.stringify({ keys, at: Date.now() }));
  } catch (e) { /* 存不下就只当次有效 —— 不值得为它打断用户的复制动作 */ }
}

function readClipboard() {
  try {
    const raw = sessionStorage.getItem(CLIP_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    const keys = (obj && Array.isArray(obj.keys) ? obj.keys : []).filter((k) => typeof k === 'string' && k);
    return keys.length ? { keys } : null;
  } catch (e) {
    return null; // 内容坏了就当作空 —— 让用户重新复制一次，好过拿半份列表去粘贴
  }
}

/**
 * 逐项询问「目标已存在，覆盖还是跳过」（与 Windows 资源管理器一致的交互）。
 *
 * 用自定义弹窗而不是 `confirmDialog()`：后者是**两按钮**的，而这里需要三个出口
 * （跳过 / 覆盖 / 取消整个复制）外加一个「对后续全部冲突执行相同选择」的勾选框。
 *
 * ⚠️ `finish()` **必须在 `close()` 之前调用**：`openModal` 的 `close()` 会触发
 * `onClose`，而这里用 `onClose` 兜住「ESC / 点 ✕ / 点遮罩」这条路径；
 * 若先 `close()` 再 `finish()`，先被 resolve 的会是「取消」，用户点的按钮就白点了。
 *
 * @returns {Promise<{action:'overwrite'|'skip'|'cancel', all:boolean}>}
 */
function conflictPrompt(conflict, index, total) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const isDir = conflict.kind === 'folder';
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <p style="margin:0 0 6px">目标位置已存在同名${isDir ? '文件夹' : '文件'}：</p>
      <div class="hint" style="word-break:break-all;margin-bottom:10px"><b>${escapeHtml(conflict.target || conflict.path)}</b></div>
      ${isDir ? '<div class="hint" style="margin-bottom:10px">同名文件夹将被<b>合并</b>：里面同名的文件会被本次复制的内容覆盖。</div>' : '<div class="hint" style="margin-bottom:10px">继续将<b>覆盖</b>目标文件（云端覆盖不可撤销）。</div>'}
      <div class="hint" style="margin-bottom:10px">源：<b>${escapeHtml(conflict.path)}</b></div>
      <label class="check-line"><input type="checkbox" id="cp-all">  对后续全部冲突执行相同选择</label>`;
    openModal({
      title: `第 ${index} / ${total} 个冲突`,
      body: wrap,
      foot: [
        { text: '取消整个复制', onClick: (o, close) => { finish({ action: 'cancel', all: false }); close(); } },
        { text: '跳过', onClick: (o, close) => { const all = wrap.querySelector('#cp-all').checked; finish({ action: 'skip', all }); close(); } },
        { text: '覆盖', cls: 'primary', onClick: (o, close) => { const all = wrap.querySelector('#cp-all').checked; finish({ action: 'overwrite', all }); close(); } },
      ],
      // ESC / ✕ / 点遮罩 —— 一律按「取消整个复制」处理，而不是默认往下覆盖
      onClose: () => finish({ action: 'cancel', all: false }),
    });
  });
}

/**
 * 把服务端回的一组冲突问成一纸 `decisions`。
 *
 * 勾了「对后续全部冲突执行相同选择」之后就不再弹窗 —— 这正是那个勾选框存在的意义；
 * 一次都不勾就是一问一答，与资源管理器的默认行为一致。
 *
 * @returns {Promise<Object|null>} 键为源路径、值为 `'overwrite' | 'skip'`；用户取消时返回 `null`
 */
async function resolveCopyConflicts(conflicts) {
  const list = Array.isArray(conflicts) ? conflicts : [];
  if (!list.length) return {};
  const decisions = {};
  let carry = null; // 「全是」：一旦设定，后续冲突不再询问
  for (let i = 0; i < list.length; i++) {
    let action = carry;
    if (!action) {
      const r = await conflictPrompt(list[i], i + 1, list.length);
      if (r.action === 'cancel') return null;
      action = r.action;
      if (r.all) carry = action;
    }
    decisions[list[i].path] = action;
  }
  return decisions;
}

/**
 * 复制的结果汇总（与 `moveKeysTo` 同一口径：**成功 / 跳过 / 失败**分开数）。
 *
 * 「跳过」在这里有两个来源：用户对同名项选了「跳过」，以及「目标与源为同一位置」
 * 这种无意义的项。两者都不是失败，但也**都不是成功** —— 一件都没复制时绝不能
 * 报「复制完成」，那正是 R52-02 那条谎报的同型问题。
 */
function summarizeCopy(r, destLabel) {
  const out = Array.isArray(r && r.results) ? r.results : [];
  const copied = out.filter((x) => x.ok && !x.skipped).length;
  const skipped = out.filter((x) => x.ok && x.skipped).length;
  const failed = out.filter((x) => !x.ok);
  if (failed.length) {
    toast(`复制未全部完成：成功 ${copied} 项、跳过 ${skipped} 项、失败 ${failed.length} 项。首个错误：${failed[0].error}`, { type: 'error', duration: 8000 });
  } else if (!copied) {
    toast(`未复制任何项目：${skipped} 项已跳过`, { type: 'warn', duration: 6000 });
  } else if (skipped) {
    toast(`已复制 ${copied} 项到「${destLabel}」，${skipped} 项已跳过`, { type: 'success', duration: 6000 });
  } else {
    toast(`已复制 ${copied} 项到「${destLabel}」`, { type: 'success' });
  }
}

/* ------------------------- 文件夹选择器（移动目标） ------------------------- */

/**
 * 取某个 key 所在目录的**前缀**（含尾斜杠）：
 * `'a/b.txt'` → `'a/'`、`'a/b/'`（目录自身）→ `'a/'`、`'a.txt'` → `''`（根）。
 *
 * 用途只有一个：判断「这个项目是不是**已经**躺在目标目录里」—— 是的话移动
 * 就是纯粹的空操作，服务端会回 `skipped`，没必要发这次请求（见 R52-02）。
 * 注意目录的父目录要**跳过自己的尾斜杠**再找上一个 `/`，否则
 * `'a/b/'.lastIndexOf('/', 3)` 会把自己那个分隔符认成父级边界。
 */
function parentPrefixOf(key) {
  const k = String(key || '');
  const from = k.endsWith('/') ? k.length - 2 : k.length - 1;
  const i = k.lastIndexOf('/', from);
  return i < 0 ? '' : k.slice(0, i + 1);
}

/**
 * 目标文件夹选择器。
 *
 * R52-02：`fixedTarget` **未传**时不再默认选中当前目录（老行为见
 * {@link ops.moveKeysTo} 的说明），`selected` 停在 `null` —— 一个「什么都没选」
 * 的显式哨兵，与「选了根目录」的空串 `''` 是两回事。确定按钮在 `selected`
 * 为 `null` 时只提示、**不关弹窗**，逼出一次显式选择。
 * `fixedTarget` 传了（拖拽落到文件夹行上）依旧直接选定，那条路径本来就是明示的。
 */
function openFolderPicker({ title, confirmText, onPick, fixedTarget, exclude }) {
  const wrap = document.createElement('div');
  const current = App.state.prefix || '';
  const preselected = fixedTarget !== undefined && fixedTarget !== null;
  wrap.innerHTML = `
    <div class="hint" style="margin-bottom:8px">${
      preselected
        ? `选择目标文件夹：已选定 <b>${escapeHtml(fixedTarget || '（根目录 /）')}</b>`
        : `在下方<b>点选</b>一个目标文件夹${current ? `（当前所在：<b>${escapeHtml(current)}</b>，仅供参考，不会被自动选中）` : '（当前在根目录）'}`
    }</div>
    <div id="fp-tree" style="max-height:320px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:6px"></div>`;
  const treeEl = wrap.querySelector('#fp-tree');
  // 未指定目标 ⇒ 停在「什么都没选」，而不是悄悄替用户选中当前目录
  let selected = preselected ? fixedTarget : null;

  function rowHtml(prefix, name, depth, expandable) {
    // 当前所在目录只标「当前位置」角标，不用 active 高亮 —— active 代表「已选中的目标」
    const isCurrent = !preselected && prefix === current;
    return `<div class="tree-row ${prefix === selected ? 'active' : ''}${isCurrent ? ' cur' : ''}" data-prefix="${escapeHtml(prefix)}" style="padding-left:${6 + depth * 16}px" data-expandable="${expandable ? 1 : 0}">
      <span class="tw" style="width:14px">${expandable ? '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3"><path d="M9 6l6 6-6 6"/></svg>' : ''}</span>
      <svg class="folder" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="color:#e8b339"><path d="M4 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/></svg>
      <span class="nm">${escapeHtml(name)}</span>${isCurrent ? '<span class="fp-cur">当前位置</span>' : ''}</div>`;
  }

  async function loadChildren(container, prefix, depth) {
    const r = await API.tree(prefix);
    const folders = (r.folders || []).filter((f) => f !== prefix && !(exclude || []).some((k) => f === k || f.startsWith(k)));
    if (!folders.length) {
      container.innerHTML = `<div style="color:#aaa;font-size:12px;padding:4px 20px">（无子文件夹）</div>`;
      return;
    }
    for (const f of folders) {
      const div = document.createElement('div');
      div.innerHTML = rowHtml(f, f.slice(prefix.length).replace(/\/$/, ''), depth, true);
      const row = div.firstElementChild;
      const kidBox = document.createElement('div');
      kidBox.className = 'tree-kids';
      kidBox.hidden = true;
      kidBox.style.marginLeft = '16px';
      row.onclick = () => {
        selected = f;
        treeEl.querySelectorAll('.tree-row').forEach((x) => x.classList.remove('active'));
        row.classList.add('active');
      };
      row.querySelector('.tw').onclick = async (e) => {
        e.stopPropagation();
        if (kidBox.hidden && !kidBox.childNodes.length) {
          await loadChildren(kidBox, f, depth + 1);
        }
        kidBox.hidden = !kidBox.hidden;
      };
      container.appendChild(div);
      container.appendChild(kidBox);
    }
  }

  const rootBox = document.createElement('div');
  rootBox.innerHTML = rowHtml('', '（根目录 /）', 0, true);
  const rootRow = rootBox.firstElementChild;
  const rootKids = document.createElement('div');
  rootKids.className = 'tree-kids';
  rootRow.onclick = () => {
    selected = '';
    treeEl.querySelectorAll('.tree-row').forEach((x) => x.classList.remove('active'));
    rootRow.classList.add('active');
  };
  rootRow.querySelector('.tw').onclick = async (e) => {
    e.stopPropagation();
    if (rootKids.hidden && !rootKids.childNodes.length) await loadChildren(rootKids, '', 1);
    rootKids.hidden = !rootKids.hidden;
  };
  treeEl.appendChild(rootRow);
  treeEl.appendChild(rootKids);

  openModal({
    title, body: wrap, foot: [
      { text: '取消' },
      {
        text: confirmText || '确定', cls: 'primary', onClick: (o, close) => {
          if (selected === null) {
            // 不关弹窗：让用户看清是「还没选」，而不是以为确定没生效
            toast('请先在列表中点选一个目标文件夹', { type: 'warn' });
            return;
          }
          close();
          onPick(selected);
        },
      },
    ],
  });
}
ops.openFolderPicker = openFolderPicker;

/* ------------------------- 工具 ------------------------- */

function configured() {
  return Boolean(App.state.config && App.state.config.configured && App.state.bucket);
}
function displayName(key) { return key.endsWith('/') ? key.slice(0, -1).split('/').pop() : key.split('/').pop(); }
function explorerRefresh() {
  import('./explorer.js').then((m) => m.explorer.refresh());
}
/**
 * R27-01：显式刷新工具栏按钮状态。
 *
 * 旧写法是 `explorer.updateOpsButtons && ...` —— `explorer` 并未导入，能跑只是
 * 因为 `index.html` 里有 `<section id="explorer">`，而 HTML Window 的**命名访问**
 * 让它解析成那个 DOM 元素（`element.updateOpsButtons === undefined` → 静默 no-op）。
 * 这依赖浏览器的一个隐式行为，任何一次给该元素改名、或把模块搬进 Worker / 测试
 * 环境，都会立刻变成 `ReferenceError`。且它并非无用：`explorer.render()` 在
 * 「列表为空」与「面板隐藏」两条分支上会提前 return，不会调用 `updateOpsButtons()`，
 * 此时只有这里能把按钮置灰。
 */
function updateOpsButtons() {
  import('./explorer.js').then((m) => m.explorer.updateOpsButtons && m.explorer.updateOpsButtons());
}
