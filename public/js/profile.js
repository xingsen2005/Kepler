/**
 * 我的资料 —— 主视图 `#profile`（**R98：由账户菜单的弹窗改为独立页面**）。
 *
 * 为什么改成页面：
 *  ① 弹窗只装得下"用户名 / 密码 / 邮箱"三项，而本轮要加的是**昵称、注册时间、
 *     注销账户** —— 注销尤其不能塞进一个小弹窗：它需要解释 15 天冷静期、要发验证码、
 *     要在提交后显示"将于某日删除"，这些内容挤在弹窗里只剩滚动条；
 *  ② 页面有自己的地址（`#profile`），刷新、收藏、从别处跳回来都不会丢上下文；
 *  ③ 弹窗是"改完就走"的心智，而注销是一个**有状态**的流程（已提交 / 可撤销），
 *     需要一个能反复回来查看的地方。
 *
 * 仍然保留的边界：只改**自己的**资料。角色不可改、限速不可改、权限不可改 ——
 * 服务端 `PUT /users/me` 会拒绝这些字段，前端只是提前说清楚。
 *
 * 字段与三条"要密码"的路径（用户名 / 密码 / 邮箱）保持与服务端同口径：
 * 昵称**不需要**密码（它只是显示名），其余三项都需要当前密码。
 */
import { API } from './api.js';
import { toast, escapeHtml, confirmDialog, roleLabel, fmtTime, isRootRole } from './util.js';
import { App } from './main.js';
import { registerWindowsHello, webauthnSupported, isSecureContextOK } from './webauthn.js';

/** 打开「我的资料」页面。真正的渲染由 `switchMainView('profile')` 触发（见 main.js） */
export function openProfilePage() {
  App.switchMainView('profile');
}

/**
 * 渲染页面。
 *
 * 两点刻意：
 *  ① **每次进入都重建 DOM** —— 用户资料可能在别处被改过（管理员改邮箱、另一个标签页
 *     改昵称），把值写死在 HTML 里就会显示上一轮的旧值；
 *  ② 进入时**再拉一次** `/users/me`，但若用户已经开始输入（`dataset.dirty`），
 *     就不覆盖 —— 否则"打开页面 → 正在打字 → 响应回来"会把输入抹掉。
 */
export function refreshProfilePage() {
  const shell = document.getElementById('profile');
  const form = document.getElementById('profile-form');
  const danger = document.getElementById('profile-danger');
  const status = document.getElementById('profile-status');
  if (!shell || !form || !danger) return;
  const me0 = App.state.user;
  if (!me0) {
    form.textContent = '请先登录';
    danger.textContent = '';
    return;
  }

  shell.dataset.dirty = '';
  // 只绑一次：每次进入都 addEventListener 会让监听器越积越多
  if (shell.dataset.bound !== '1') {
    shell.dataset.bound = '1';
    shell.addEventListener('input', () => { shell.dataset.dirty = '1'; });
  }

  render();

  API.myProfile().then((r) => {
    if (!r || !r.user) return;
    App.state.user = Object.assign({}, App.state.user, r.user);
    if (shell.dataset.dirty !== '1') render();
  }).catch(() => { /* 拉不到就用本地缓存渲染：页面不该因为一次失败变成空白 */ });

  /* ------------------------------------------------------------------ */

  function render() {
    const me = App.state.user || {};
    if (status) status.textContent = roleLabel(me.role);
    form.innerHTML = formHtml(me);
    danger.innerHTML = dangerHtml(me);
    bindForm(me);
    bindDanger(me);
  }

  function formHtml(me) {
    const helloEnabled = !!me.webauthnEnabled;
    const helloUsable = webauthnSupported() && isSecureContextOK();
    const created = me.createdAt ? fmtTime(me.createdAt) : '未知（历史账户未记录创建时间）';
    return `
    <!-- R98：昵称在用户名**之上** —— 它是给人看的名字，用户名是给系统看的 -->
    <div class="form-item">
      <label>昵称 <span class="hint" style="margin-left:6px">显示在右上角账户名处</span></label>
      <input type="text" id="p-f-nickname" maxlength="32" placeholder="例如：小王（留空则显示用户名）"
        value="${escapeHtml(me.nickname || '')}" autocomplete="off" spellcheck="false">
      <div class="hint">只影响显示，不参与登录；允许与他人重复，随时可改，不需要密码。</div>
    </div>
    <div class="form-item">
      <label>用户名 <span class="req">*</span></label>
      <input type="text" id="p-f-username" maxlength="32" placeholder="2-32 位，支持中英文/数字/@.-_"
        value="${escapeHtml(me.username || '')}" autocomplete="off" spellcheck="false">
      <div class="hint">用户名用于登录，2-32 个字符，支持中文、英文字母、数字及 @ . - _ 符号。修改后需要重新登录。</div>
    </div>
    <div class="form-item">
      <label>当前角色</label>
      <input type="text" value="${escapeHtml(roleLabel(me.role))}" disabled>
      <div class="hint">角色由管理员分配，不能自行修改。</div>
    </div>
    <div class="form-item">
      <label>注册时间</label>
      <input type="text" value="${escapeHtml(created)}" disabled>
      <div class="hint">账户创建时间由系统记录，不可修改。</div>
    </div>
    <!-- R54②：邮箱（需求 2.3 补填 / 2.4 修改）。改它必须过两道证明，见下方 hint -->
    <div class="form-item">
      <label>邮箱 <span class="hint" style="margin-left:6px">用于找回密码 / 注销验证</span></label>
      <input type="email" id="p-f-email" maxlength="254" placeholder="留空 = 不绑定邮箱"
        value="${escapeHtml(me.email || '')}" autocomplete="email" spellcheck="false">
      <div class="hint">
        邮箱是<b>「忘记密码」的收件地址</b>，也是<b>注销账户</b>的验证渠道。修改它需要两步证明：
        先点「发送验证码」把验证码发到新邮箱，再在「当前密码」栏输入当前密码 ——
        只验邮箱挡不住会话被盗用（那时收件箱在别人手上），只验密码又挡不住手滑填成别人的地址。
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
      <label>当前密码 <span class="hint" style="margin-left:6px">修改用户名 / 密码 / 邮箱 / 调整 Windows Hello 时必填</span></label>
      <input type="password" id="p-f-current" maxlength="128" placeholder="用于确认身份" autocomplete="current-password">
      <div class="hint">改动用户名、密码或邮箱前需重新输入一次当前密码 —— 会话被盗用时光有会话不足以改掉你的凭据。</div>
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
    <div class="profile-actions">
      <button type="button" id="p-f-save" class="mini-btn primary">保存修改</button>
    </div>
  `;
  }

  /**
   * 注销卡片。
   *
   * 四种形态**互斥**，按"最需要说清楚的事实"排序：已申请 → 根用户 → 没邮箱 → 可申请。
   * 顺序不能换：一个已申请注销的根用户（历史数据才可能）应当先看到"已申请"，
   * 而不是一句"根用户不可注销"把他吓一跳。
   */
  function dangerHtml(me) {
    if (me.deletion) {
      return `
        <div class="enc-warn">
          <b>注销申请已提交</b>：账户将于 <b>${escapeHtml(fmtTime(me.deletion.deleteAt))}</b> 自动删除。
          在此之前，<b>登录本账户即会立即撤销</b>这次申请。
        </div>
        <div class="card-note">
          冷静期内你仍然可以正常使用系统。撤销之后账户完全恢复，不会留下任何"曾申请注销"的痕迹。
        </div>
        <div class="profile-actions">
          <button type="button" id="p-d-cancel" class="mini-btn">撤销注销申请</button>
        </div>
        <div id="p-d-msg" class="form-msg"></div>`;
    }
    if (isRootRole(me.role)) {
      return `
        <div class="card-note">
          <b>根用户账户不可注销。</b>根用户是系统的第一个账户、也是最高权限的唯一载体 ——
          把它删掉之后没有任何界面路径能再建回来（只能直接改数据文件）。
          如果你确实不再使用本系统，请先在其他账户上完成交接，再停用部署。
        </div>`;
    }
    if (!me.email) {
      return `
        <div class="card-note">
          注销需要<b>验证邮箱</b>，而当前账户还没有绑定邮箱。请先在上方「邮箱」一栏填写并保存，
          通过验证码验证之后，再回到这里提交注销申请。
        </div>
        <div class="profile-actions">
          <button type="button" id="p-d-gobind" class="mini-btn">去绑定邮箱</button>
        </div>`;
    }
    return `
      <div class="card-note">
        提交后账户会进入 <b>15 天冷静期</b>，到期后<b>自动删除</b>（包括该账户的登录凭据与
        WebDAV 凭据；其创建过的分享链接会保留，但不再归属任何人）。<br>
        <b>冷静期内再次登录本账户，即视为撤销注销</b> —— 这是给"账户被盗后被人恶意注销"留的救济通道，
        所以提交后请勿立即退出登录再尝试登录，否则申请会被撤销。<br>
        验证码将发送到当前绑定的邮箱：<b>${escapeHtml(me.email)}</b>。
      </div>
      <div class="form-item">
        <label>邮箱验证码 <span class="hint" style="margin-left:6px">6 位数字，10 分钟内有效</span></label>
        <div class="code-line">
          <input type="text" id="p-d-code" inputmode="numeric" maxlength="6"
            autocomplete="one-time-code" spellcheck="false" placeholder="邮件里的 6 位验证码">
          <button type="button" id="p-d-send" class="mini-btn">发送验证码</button>
        </div>
      </div>
      <div class="profile-actions">
        <button type="button" id="p-d-submit" class="mini-btn danger">提交注销申请</button>
      </div>
      <div id="p-d-msg" class="form-msg"></div>`;
  }

  /* ------------------------------ 表单交互 ------------------------------ */

  function bindForm(me) {
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
    /** 当前账户的邮箱（"改没改"的判据；保存成功后页面会整体重绘，故这里不需要重新赋值） */
    const currentEmail = String(me.email || '').trim().toLowerCase();

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
          startCountdown(sendBtn, (r && r.resendAfter) || 60);
        } catch (e) {
          showMsg(e.message || '发送失败', 'bad');
          // 429：服务端给了剩余秒数，照着它倒计时（否则用户会在倒计时结束后立刻再点一次、再被拒）
          if (e && e.retryAfter) startCountdown(sendBtn, e.retryAfter);
          else { sendBtn.disabled = false; sendBtn.textContent = '发送验证码'; }
        }
      });
    }

    form.querySelectorAll('input[type="text"], input[type="password"], input[type="email"]').forEach((inp) => {
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
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
            App.state.user.webauthnEnabled = true;
            if (helloMsg) { helloMsg.textContent = '已启用：登录时将要求 Windows Hello 验证'; helloMsg.className = 'form-msg show ok'; }
            toast('Windows Hello 已启用', { type: 'success' });
          }
        } catch (e) {
          helloBox.checked = false;
          if (helloMsg) { helloMsg.textContent = e.message || '启用失败'; helloMsg.className = 'form-msg show bad'; }
        }
      });
    }

    const saveBtn = q('#p-f-save');
    if (saveBtn) saveBtn.addEventListener('click', () => save());

    async function save() {
      const nickname = (q('#p-f-nickname') || {}).value || '';
      const username = (q('#p-f-username') || {}).value || '';
      const currentPw = (q('#p-f-current') || {}).value || '';
      const password = (q('#p-f-password') || {}).value || '';
      const confirm = (q('#p-f-confirm') || {}).value || '';
      const email = ((q('#p-f-email') || {}).value || '').trim().toLowerCase();
      const emailCode = ((q('#p-f-email-code') || {}).value || '').trim();

      if (!username.trim()) { showMsg('用户名不能为空', 'bad'); return; }
      if (password && password.length < 8) { showMsg('密码长度不能少于 8 位', 'bad'); return; }
      if (password !== confirm) { showMsg('两次输入的密码不一致', 'bad'); return; }

      const body = { username: username.trim() };
      /**
       * R98：昵称**只在真的改了**时才提交 —— 服务端对该字段是"给了就写"，
       * 每次都带上去会让审计日志里每次都多一句「修改昵称」，真改了反而看不出来。
       * 昵称不需要当前密码：它不影响登录，也不构成接管。
       */
      if (nickname.trim() !== String(me.nickname || '')) body.nickname = nickname.trim();
      /**
       * R90：**改用户名也要当前密码**（服务端同一口径）。
       *
       * 用户名是登录凭据的另一半：会话被劫持时，攻击者改掉用户名就能让真实所有者
       * 连登录页都过不去（"用户名或密码错误"）。它与改密、改邮箱同级，因此同样
       * 先在前端拦一次，省掉一次必然失败的往返。
       */
      if (username.trim() !== String(me.username || '')) {
        if (!currentPw) { showMsg('修改用户名前请先输入当前密码', 'bad'); return; }
        body.currentPassword = currentPw;
      }
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

      if (saveBtn) saveBtn.disabled = true;
      try {
        const r = await API.updateMyProfile(body);
        if (r && r.reauthRequired) {
          toast('用户名已修改，请使用新用户名重新登录', { type: 'warn', duration: 6000 });
          if (App.forceLogout) App.forceLogout('用户名已修改，请重新登录');
          return;
        }
        if (wantDisable) {
          await API.webauthnDisable(currentPw);
          me.webauthnEnabled = false;
        }
        // 同步本地显示（App.state.user 是唯一事实源，右上角菜单由 main.js 重绘）
        App.state.user = Object.assign({}, App.state.user, r && r.user ? r.user : {});
        if (App.renderUserMenu) App.renderUserMenu();
        shell.dataset.dirty = '';
        render();
        toast(emailChanged ? '资料已更新，邮箱已生效' : '资料已更新', { type: 'success' });
      } catch (e) {
        showMsg(e.message || '保存失败', 'bad');
        if (saveBtn) saveBtn.disabled = false;
      }
    }
  }

  /* ------------------------------ 注销交互 ------------------------------ */

  function bindDanger(me) {
    const q = (sel) => danger.querySelector(sel);
    const msgEl = q('#p-d-msg');
    const showMsg = (text, cls) => {
      if (!msgEl) return;
      msgEl.textContent = text;
      msgEl.className = 'form-msg show ' + cls;
    };

    const goBind = q('#p-d-gobind');
    if (goBind) {
      goBind.addEventListener('click', () => {
        const emailInput = document.getElementById('p-f-email');
        if (emailInput) { emailInput.focus(); emailInput.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      });
    }

    const cancelBtn = q('#p-d-cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', async () => {
        cancelBtn.disabled = true;
        try {
          const r = await API.cancelAccountDeletion();
          if (r && r.user) App.state.user = Object.assign({}, App.state.user, r.user);
          shell.dataset.dirty = '';
          render();
          toast('注销申请已撤销', { type: 'success' });
        } catch (e) {
          showMsg(e.message || '撤销失败', 'bad');
          cancelBtn.disabled = false;
        }
      });
    }

    const sendBtn = q('#p-d-send');
    if (sendBtn) {
      sendBtn.addEventListener('click', async () => {
        sendBtn.disabled = true;
        sendBtn.textContent = '发送中…';
        try {
          const r = await API.deleteAccountCode();
          showMsg(`验证码已发送到 ${((r && r.to) || me.email)}，请查收`, 'ok');
          startCountdown(sendBtn, (r && r.resendAfter) || 60);
        } catch (e) {
          showMsg(e.message || '发送失败', 'bad');
          if (e && e.retryAfter) startCountdown(sendBtn, e.retryAfter);
          else { sendBtn.disabled = false; sendBtn.textContent = '发送验证码'; }
        }
      });
    }

    const submitBtn = q('#p-d-submit');
    if (submitBtn) {
      submitBtn.addEventListener('click', async () => {
        const code = ((q('#p-d-code') || {}).value || '').trim();
        if (!code) { showMsg('请填写邮箱收到的验证码', 'bad'); return; }
        /**
         * 二次确认**不可省**：注销一旦到期就不可逆，而"点错一个按钮"是真实存在的。
         * 文案里要同时说清"15 天后删除"和"登录即撤销"，两条都是决策依据。
         */
        const ok = await confirmDialog({
          title: '确认提交注销申请？',
          message: '提交后账户进入 15 天冷静期，到期将自动删除，且删除后无法恢复。'
            + '冷静期内再次登录本账户会自动撤销申请。',
          okText: '提交申请',
          danger: true,
        });
        if (!ok) return;
        submitBtn.disabled = true;
        try {
          const r = await API.requestAccountDeletion(code);
          if (r && r.user) App.state.user = Object.assign({}, App.state.user, r.user);
          shell.dataset.dirty = '';
          render();
          toast('注销申请已提交，15 天后自动删除', { type: 'warn', duration: 6000 });
        } catch (e) {
          showMsg(e.message || '提交失败', 'bad');
          submitBtn.disabled = false;
        }
      });
    }
  }
}

/**
 * 按钮上的倒计时：服务端给了 `retryAfter` / `resendAfter` 就用它，否则按 60 秒。
 *
 * 抽成"传按钮"而不是闭包在某个按钮上：改邮箱与注销两条路径都要用，
 * 各写一份就会出现"一个按 60 秒、一个按 30 秒"的不一致。
 */
function startCountdown(btn, seconds) {
  if (!btn) return;
  if (btn._cdTimer) clearInterval(btn._cdTimer);
  let left = Number(seconds) > 0 ? Number(seconds) : 60;
  const origin = btn.dataset.label || btn.textContent || '发送验证码';
  btn.dataset.label = origin;
  const tick = () => {
    if (left > 0) {
      btn.disabled = true;
      btn.textContent = `${left} 秒后可重发`;
      left -= 1;
      return;
    }
    clearInterval(btn._cdTimer);
    btn._cdTimer = 0;
    btn.disabled = false;
    btn.textContent = origin;
  };
  btn._cdTimer = setInterval(tick, 1000);
  tick();
}
