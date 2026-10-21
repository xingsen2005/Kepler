/**
 * 我的资料 —— 账户菜单「编辑资料」弹窗（**所有角色可用**，含管理员）。
 *
 * 从这里**独立出来**是本次重构的关键：
 *   - 此前「编辑自己资料」与「管理全部用户」共用系统设置里的同一张卡片，
 *     卡片需要在「我的资料 / 用户管理」两种形态间来回切换。只要有一条分支漏改，
 *     换账号时就会残留上一个角色的 DOM（普通用户看到全部用户、看到添加按钮）。
 *   - 现在两种用途物理分离：用户管理卡片对普通用户**整体隐藏**（只有管理员看得到），
 *     自助资料编辑走本弹窗。角色切换只剩"显示 / 隐藏一个整块"，不存在需要还原的中间态。
 *
 * 支持的字段：用户名、密码、自己的 Windows Hello 开关。
 * 明确不支持改角色 / 权限（服务端 /users/me 同样拒绝，避免自行提权）。
 */
import { API } from './api.js';
import { toast, escapeHtml, openModal, roleLabel } from './util.js';
import { App } from './main.js';
import { registerWindowsHello, webauthnSupported, isSecureContextOK } from './webauthn.js';

/** 打开「编辑资料」弹窗 */
export function openProfileDialog() {
  const me = App.state.user;
  if (!me) { toast('请先登录', { type: 'warn' }); return; }

  const helloEnabled = !!me.webauthnEnabled;
  const helloUsable = webauthnSupported() && isSecureContextOK();

  const form = document.createElement('div');
  form.innerHTML = `
    <div class="form-item">
      <label>用户名 <span class="req">*</span></label>
      <input type="text" id="p-f-username" maxlength="32" placeholder="2-32 位，支持中英文/数字/@.-_"
        value="${escapeHtml(me.username || '')}" autocomplete="off" spellcheck="false">
      <div class="hint">用户名用于登录，2-32 个字符，支持中文、英文字母、数字及 @ . - _ 符号。修改后需要重新登录。</div>
    </div>
    <div class="form-item">
      <label>当前角色</label>
      <input type="text" value="${roleLabel(me.role)}" disabled>
      <div class="hint">角色由管理员分配，不能自行修改。</div>
    </div>
    <!-- R54②：邮箱（需求 2.3 补填 / 2.4 修改）。改它必须过两道证明，见下方 hint -->
    <div class="form-item">
      <label>邮箱 <span class="hint" style="margin-left:6px">用于找回密码</span></label>
      <input type="email" id="p-f-email" maxlength="254" placeholder="留空 = 不绑定邮箱"
        value="${escapeHtml(me.email || '')}" autocomplete="email" spellcheck="false">
      <div class="hint">
        邮箱是<b>「忘记密码」的收件地址</b>。修改它需要两步证明：先点「发送验证码」把验证码发到新邮箱，
        再在「当前密码」栏输入当前密码 —— 只验邮箱挡不住会话被盗用（那时收件箱在别人手上），
        只验密码又挡不住手滑填成别人的地址。
      </div>
    </div>
    <div class="form-item" id="p-f-email-code-item" hidden>
      <label>邮箱验证码 <span class="hint" style="margin-left:6px">6 位数字，10 分钟内有效</span></label>
      <div class="code-line">
        <input type="text" id="p-f-email-code" inputmode="numeric" maxlength="6"
          autocomplete="one-time-code" spellcheck="false" placeholder="邮件里的 6 位验证码">
        <button type="button" id="p-f-email-send" class="mini-btn">发送验证码</button>
      </div>
    </div>
    <div class="form-item">
      <label>当前密码 <span class="hint" style="margin-left:6px">修改密码 / 邮箱 / 调整 Windows Hello 时必填</span></label>
      <input type="password" id="p-f-current" maxlength="128" placeholder="用于确认身份" autocomplete="current-password">
      <div class="hint">改动密码或邮箱前需重新输入一次当前密码 —— 会话被盗用时光有会话不足以改掉你的凭据。</div>
    </div>
    <div class="form-item">
      <label>新密码 <span class="hint" style="margin-left:6px">留空则不修改密码</span></label>
      <input type="password" id="p-f-password" maxlength="128" placeholder="留空保持原密码不变" autocomplete="new-password">
    </div>
    <div class="form-item">
      <label>确认新密码 <span class="hint" style="margin-left:6px">留空则不修改</span></label>
      <input type="password" id="p-f-confirm" maxlength="128" placeholder="留空保持原密码不变" autocomplete="new-password">
    </div>
    <div class="form-item">
      <label class="u-hello-label">
        <input type="checkbox" id="p-f-hello" ${helloEnabled ? 'checked' : ''} ${helloUsable ? '' : 'disabled'}>
        <span>启用 Windows Hello 验证</span>
      </label>
      <div class="hint">
        ${helloUsable
          ? '启用后，登录时在输入密码之后<b>还需通过本机 Windows Hello</b>验证才能真正进入系统。需在「当前密码」栏输入当前密码才能绑定 Windows Hello。'
          : '当前环境不可用：需使用支持 WebAuthn 的浏览器，并通过 HTTPS 或 127.0.0.1 / localhost 访问。'}
      </div>
      <div id="p-f-hello-msg" class="form-msg"></div>
    </div>
    <div id="p-f-msg" class="form-msg"></div>
  `;

  const m = openModal({
    title: '编辑资料',
    body: form,
    foot: [
      { text: '取消', onClick: (o, close) => close() },
      { text: '保存修改', cls: 'primary', onClick: (o, close) => save(o, close) },
    ],
  });

  const q = (sel) => form.querySelector(sel);
  const msgEl = q('#p-f-msg');
  const showMsg = (text, cls) => {
    if (!msgEl) return;
    msgEl.textContent = text;
    msgEl.className = 'form-msg show ' + cls;
  };

  /* ---------- R54②：邮箱与验证码 ---------- */
  const emailInput = q('#p-f-email');
  const codeItem = q('#p-f-email-code-item');
  const codeInput = q('#p-f-email-code');
  const sendBtn = q('#p-f-email-send');
  /** 当前账户的邮箱（"改没改"的判据；保存成功后同步更新，免得第二次保存又当成改动） */
  let currentEmail = String(me.email || '').trim().toLowerCase();
  let sendTimer = null;

  /**
   * 只有邮箱**真的改了**才显示验证码行。
   *
   * 界面上常驻一个「发送验证码」按钮的话，用户会以为每次保存都得点它；
   * 而服务端对"与现状相同"的提交本来就是放行的（视为没改）。
   */
  function syncEmailRow() {
    if (!emailInput || !codeItem) return;
    const changed = emailInput.value.trim().toLowerCase() !== currentEmail;
    codeItem.hidden = !changed;
    if (!changed && codeInput) codeInput.value = '';
  }
  if (emailInput) {
    emailInput.addEventListener('input', syncEmailRow);
    syncEmailRow();
  }

  /** 发送按钮上的倒计时：服务端给了 `retryAfter` 就用它，否则按 60 秒 */
  function startCountdown(seconds) {
    if (!sendBtn) return;
    let left = Number(seconds) > 0 ? Number(seconds) : 60;
    if (sendTimer) { clearInterval(sendTimer); sendTimer = null; }
    const tick = () => {
      if (left > 0) {
        sendBtn.disabled = true;
        sendBtn.textContent = `${left} 秒后可重发`;
        left -= 1;
        return;
      }
      clearInterval(sendTimer); sendTimer = null;
      sendBtn.disabled = false;
      sendBtn.textContent = '发送验证码';
    };
    tick();
    sendTimer = setInterval(tick, 1000);
  }

  if (sendBtn) {
    sendBtn.addEventListener('click', async () => {
      const email = ((emailInput || {}).value || '').trim();
      if (!email) { showMsg('请先填写要绑定的邮箱', 'bad'); return; }
      sendBtn.disabled = true;
      sendBtn.textContent = '发送中…';
      try {
        const r = await API.emailCode(email);
        if (r && r.alreadyBound) {
          // 服务端说"这已经是你的邮箱了" —— 那就没得改，把界面也拉回原样
          showMsg('该邮箱已是当前账户的邮箱，无需重复验证', 'ok');
          sendBtn.disabled = false;
          sendBtn.textContent = '发送验证码';
          if (emailInput) emailInput.value = currentEmail;
          syncEmailRow();
          return;
        }
        showMsg('验证码已发送，请查收邮件（含垃圾邮件箱）', 'ok');
        startCountdown((r && r.resendAfter) || 60);
      } catch (e) {
        showMsg(e.message || '发送失败', 'bad');
        // 429：服务端给了剩余秒数，照着它倒计时（否则用户会在倒计时结束后立刻再点一次、再被拒）
        if (e && e.retryAfter) startCountdown(e.retryAfter);
        else { sendBtn.disabled = false; sendBtn.textContent = '发送验证码'; }
      }
    });
  }

  form.querySelectorAll('input[type="text"], input[type="password"], input[type="email"]').forEach((inp) => {
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(m.overlay, m.close); } });
  });

  // 勾选启用 → 立即要求输入当前密码并唤起 Windows Hello 完成注册（服务端会校验密码）
  const helloBox = q('#p-f-hello');
  const helloMsg = q('#p-f-hello-msg');
  if (helloBox) {
    helloBox.addEventListener('change', async () => {
      if (!helloBox.checked) return; // 取消勾选只改 UI，真正关闭在保存时处理
      const pwd = (q('#p-f-current') || {}).value || '';
      if (!pwd) {
        helloBox.checked = false;
        if (helloMsg) { helloMsg.textContent = '请先在「当前密码」栏输入当前密码，用于确认是本人在操作'; helloMsg.className = 'form-msg show bad'; }
        return;
      }
      if (helloMsg) { helloMsg.textContent = '正在唤起 Windows Hello，请按系统提示完成验证…'; helloMsg.className = 'form-msg show'; }
      try {
        const r = await registerWindowsHello(API, pwd);
        if (r && r.user) {
          me.webauthnEnabled = true; // 同步本地会话状态，避免界面与实际不一致
          if (helloMsg) { helloMsg.textContent = '已启用：登录时将要求 Windows Hello 验证'; helloMsg.className = 'form-msg show ok'; }
          toast('Windows Hello 已启用', { type: 'success' });
        }
      } catch (e) {
        helloBox.checked = false;
        if (helloMsg) { helloMsg.textContent = e.message || '启用失败'; helloMsg.className = 'form-msg show bad'; }
      }
    });
  }

  async function save(overlay, close) {
    const username = (overlay.querySelector('#p-f-username') || {}).value || '';
    const currentPw = (overlay.querySelector('#p-f-current') || {}).value || '';
    const password = (overlay.querySelector('#p-f-password') || {}).value || '';
    const confirm = (overlay.querySelector('#p-f-confirm') || {}).value || '';
    const email = ((overlay.querySelector('#p-f-email') || {}).value || '').trim().toLowerCase();
    const emailCode = ((overlay.querySelector('#p-f-email-code') || {}).value || '').trim();

    if (!username.trim()) { showMsg('用户名不能为空', 'bad'); return; }
    if (password && password.length < 8) { showMsg('密码长度不能少于 8 位', 'bad'); return; }
    if (password !== confirm) { showMsg('两次输入的密码不一致', 'bad'); return; }

    const body = { username: username.trim() };
    if (password) {
      // R21-09：服务端要求二次确认当前密码；前端先拦一次，省掉一次必然失败的往返
      if (!currentPw) { showMsg('修改密码前请先输入当前密码', 'bad'); return; }
      body.password = password;
      body.confirmPassword = confirm;
      body.currentPassword = currentPw;
    }

    /**
     * R54②：邮箱（需求 2.3 / 2.4）。
     *
     * 两种**都要当前密码**，理由见表单上的 hint：验证码只证明"这个地址归我"，
     * 证明不了"是我"—— 会话被盗用时，收件箱本来就在攻击者手上。
     * 解绑（清空）不需要验证码（它是收紧而不是放松），但同样要当前密码：
     * 否则劫持者能先把 owner 的邮箱摘掉，让他连"忘记密码"都走不了。
     * 客户端先拦一次，省掉必然失败的往返；真正的边界在服务端（`PUT /users/me`）。
     */
    const emailChanged = email !== currentEmail;
    if (emailChanged) {
      if (!currentPw) {
        showMsg(email ? '修改邮箱前请先输入当前密码' : '解绑邮箱前请先输入当前密码', 'bad');
        return;
      }
      body.email = email; // 空串 = 解绑（服务端判据是 `!== undefined`）
      body.currentPassword = currentPw;
      if (email) {
        if (!emailCode) { showMsg('请先点「发送验证码」，并填写新邮箱收到的验证码', 'bad'); return; }
        body.emailCode = emailCode;
      }
    }

    // 关闭 Windows Hello：勾选被取消时必须提供当前密码（服务端同样要求）
    const wantDisable = !!me.webauthnEnabled && helloBox && helloBox.checked === false;
    if (wantDisable && !currentPw) {
      showMsg('关闭 Windows Hello 需要输入当前密码以确认身份', 'bad');
      return;
    }

    try {
      const r = await API.updateMyProfile(body);
      if (r && r.reauthRequired) {
        close();
        toast('用户名已修改，请使用新用户名重新登录', { type: 'warn', duration: 6000 });
        if (App.forceLogout) App.forceLogout('用户名已修改，请重新登录');
        return;
      }
      if (wantDisable) {
        await API.webauthnDisable(currentPw);
        me.webauthnEnabled = false;
      }
      // 同步本地显示（用户名 / 账户菜单抬头 / 邮箱的"已改"基准）
      me.username = body.username;
      if (emailChanged) {
        me.email = email;
        currentEmail = email;
        if (codeInput) codeInput.value = '';
        syncEmailRow();
      }
      const nameEl = document.getElementById('user-name');
      if (nameEl) nameEl.textContent = body.username;
      const headEl = document.getElementById('um-head');
      if (headEl) headEl.textContent = `${body.username}（${roleLabel(me.role)}）`;
      close();
      toast(emailChanged ? '资料已更新，邮箱已生效' : '资料已更新', { type: 'success' });
    } catch (e) {
      showMsg(e.message || '保存失败', 'bad');
    }
  }
}
