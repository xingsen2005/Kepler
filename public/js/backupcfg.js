/**
 * R38：设置页「备份配置」卡片 —— 实时码展示 + 导出（加密）/ 导入。
 *
 * ## 三种码的关系（这是本卡片最容易看错的地方）
 *
 *  - **实时码**：页面里那串码，由服务端按当前配置算出来，改设置就变。
 *    明文，管理员专属。**它不能用来导入** —— 服务端只接受加密导出码
 *    （实时码没有完整性保护，谁都能改一个字节再让服务端吃进去）。
 *    R43：页面上只显示它的**掩码**（见 {@link maskCode}），整串明文不再铺在界面上。
 *  - **导出码**：点「复制备份码 / 导出为 JSON」时，先验证**账户密码**、再设一个
 *    **独立的备份密码**，服务端据此把实时码加密成导出码。**只有它**能跨实例搬运。
 *  - **导入**：粘贴导出码 + 输入备份密码，**仅在全新实例上**由服务端放行。
 *
 * 因此这里的按钮名字都带「…」（表示会先弹一个对话框），而不是直接执行 ——
 * 避免用户以为「复制」就是把上面那串明文拿去别处用。
 *
 * ## 两个必须守住的交互细节
 *
 * ① `refresh()` 会**覆盖** textarea 的内容。因此实现里绝不把用户手输的内容写回它 ——
 *    导入用的是一个**独立对话框里的 textarea**，与实时码那块互不影响。
 * ② 换账号 / 登出必须 `reset()`：实时码含密钥明文，留着就是「上一个账号的配置」
 *    静静躺在新账号的 DOM 里（R36 的用户列表踩过同一个坑）。
 */
import { API } from './api.js';
import { toast, openModal } from './util.js';

let wired = false;
/** 当前实时码（导出时不用它 —— 导出由服务端重新按当前配置生成，避免用到过期副本） */
let liveCode = '';

function el(id) { return document.getElementById(id); }

/**
 * R43：实时码在界面上的**掩码**参数。
 *
 * 抬头（`KEPLER-CONFIG-V1`）与紧随其后的第一个 `.` 原样保留 —— 它不是秘密，
 * 而且是用户肉眼分辨「这是哪种码」的唯一凭据（页面上另有 `KEPLER-CONFIG-SEALED-V1.…`
 * 的**导出码**，两者必须一眼能分开）。
 */
const MASK_CHAR = '•';
const MASK_HEAD_VISIBLE = 6;
const MASK_TAIL_VISIBLE = 6;
const MASK_WIDTH = 24;

/**
 * 把实时码渲染成**部分掩码**的展示串（唯一实现点）。
 *
 * 为什么必须掩码：实时码是当前配置的**明文** —— 里面有访问密钥、WebDAV 口令等。
 * 整串铺在「系统设置」页上，等于把它交给同屏的每一个人、以及任何一张截图；
 * 而这一页恰恰是最常被投屏演示的一块（对比：密钥输入框本来就从不回填明文，
 * 这里却在把一个更大的秘密整串摆出来）。
 *
 * 掩码规则：
 *   · 抬头 + 第一个 `.` 原样；
 *   · 载荷保留首 {@link MASK_HEAD_VISIBLE} 与末 {@link MASK_TAIL_VISIBLE} 位，
 *     中间以**定宽**掩码替代（定宽而非等长：等长会把码长也一并画出来，
 *     而定宽读起来就是一行）；
 *   · 载荷本身比「首 + 末」还短时整体掩掉，避免出现「可见部分比掩码还长」这种
 *     自相矛盾的展示。
 *
 * 完整码只能通过**复制备份码…** / **导出为 JSON…** 两个显式动作取得（见 `deliver()`）——
 * 它们会先验证账户密码、再要求设一个独立的备份密码，得到的才是可搬运的加密导出码。
 *
 * 非字符串与空串一律原样返回：空态应当显示空，而不是一串掩码。
 *
 * @param {string} code 服务端下发的实时码
 * @returns {string} 可直接写进 textarea 的展示串
 */
export function maskCode(code) {
  const s = String(code == null ? '' : code);
  if (!s) return '';
  const dot = s.indexOf('.');
  const head = dot >= 0 ? s.slice(0, dot + 1) : '';
  const payload = dot >= 0 ? s.slice(dot + 1) : s;
  if (payload.length <= MASK_HEAD_VISIBLE + MASK_TAIL_VISIBLE + 4) {
    return head + MASK_CHAR.repeat(payload.length);
  }
  return head + payload.slice(0, MASK_HEAD_VISIBLE) + MASK_CHAR.repeat(MASK_WIDTH)
    + payload.slice(-MASK_TAIL_VISIBLE);
}

export function refresh() {
  wire();
  const card = el('sysset-backup-card');
  if (!card || card.hidden) return; // 非管理员：整卡隐藏，不发注定 403 的请求
  loadStatus();
  loadCode();
}

export function reset() {
  liveCode = '';
  const ta = el('backup-code');
  if (ta) ta.value = '';
  const meta = el('backup-meta-text');
  if (meta) meta.textContent = '';
  const hint = el('backup-import-hint');
  if (hint) hint.textContent = '';
}

function wire() {
  if (wired) return;
  wired = true;
  const copy = el('btn-backup-copy');
  if (copy) copy.onclick = () => openExportDialog('copy');
  const exp = el('btn-backup-export');
  if (exp) exp.onclick = () => openExportDialog('file');
  const imp = el('btn-backup-import');
  if (imp) imp.onclick = openImportDialog;
  const rf = el('btn-backup-refresh');
  if (rf) rf.onclick = () => { loadStatus(); loadCode(); };
}

async function loadStatus() {
  const hint = el('backup-import-hint');
  try {
    const s = await API.backupStatus();
    if (hint) {
      hint.textContent = s.canImport
        ? '本实例尚未配置任何项目，可以导入。'
        : '本实例已有配置，导入已关闭（导入会覆盖并全部丢失）。';
      hint.classList.toggle('backup-import-open', !!s.canImport);
    }
    const imp = el('btn-backup-import');
    if (imp) imp.disabled = !s.canImport;
  } catch (e) {
    if (hint) hint.textContent = '备份状态读取失败：' + e.message;
  }
}

async function loadCode() {
  const ta = el('backup-code');
  const meta = el('backup-meta-text');
  try {
    const r = await API.backupCode();
    liveCode = String(r.code || '');
    // R43：界面上只放掩码 —— 完整实时码保留在 liveCode 里（`currentLiveCode()` 供调试/测试），
    // 绝不再整串写进 DOM。这样「选中并复制这个框」拿到的也只是一串掩码。
    if (ta) ta.value = maskCode(liveCode);
    if (meta) {
      const s = r.summary || {};
      meta.textContent = `指纹 ${r.fingerprint} · 长度 ${liveCode.length} 字符 · `
        + `密钥 ${s.credentials || 0} · 桶 ${s.buckets || 0} · WebDAV 账户 ${s.webdavAccounts || 0} · `
        + `IP 规则 ${s.ipRules || 0} · 发信 ${s.smtpConfigured ? '已配置' : '未配置'} · `
        + `站点名 ${s.siteName || '（默认）'}`;
    }
  } catch (e) {
    if (ta) ta.value = '';
    if (meta) meta.textContent = '实时码读取失败：' + e.message;
  }
}

/* ------------------------------ 导出 ------------------------------ */

/**
 * 导出对话框：先验证**账户密码**，再设**独立备份密码**。
 *
 * 两个密码刻意放在同一个对话框里一次收齐：分成两步会让用户以为「验证通过了就等于
 * 拿到码了」，而真正保护备份的是第二把密码。字段顺序也按这个心智模型排。
 */
function openExportDialog(mode) {
  const wrap = document.createElement('div');
  wrap.className = 'backup-form';
  wrap.innerHTML = `
    <div class="form-item"><label>账户密码（权限验证）</label>
      <input id="bk-account-pass" class="sl-input bk-input" type="password" autocomplete="current-password"
        placeholder="当前登录账户的密码">
      <div class="hint">用于确认「是你本人在导出配置」。</div></div>
    <div class="form-item"><label>备份密码（独立设置）</label>
      <input id="bk-backup-pass" class="sl-input bk-input" type="password" autocomplete="new-password"
        placeholder="至少 8 位">
      <div class="hint">这份备份的独立密码，<b>与账户密码无关</b>，也<b>不会被保存</b>在任何地方 ——
        忘了它，这份导出码就再也解不开。导入时需要输入同一个。</div></div>
    <div class="form-item"><label>再输一次备份密码</label>
      <input id="bk-backup-pass2" class="sl-input bk-input" type="password" autocomplete="new-password"
        placeholder="重复输入"></div>
    <div class="form-item"><label>文件名（可选）</label>
      <input id="bk-file-name" class="sl-input bk-input" type="text" autocomplete="off" spellcheck="false"
        placeholder="留空则用默认名 kepler-config-backup-<指纹>.json">
      <div class="hint">保存为 <b>.json</b>：留空用默认名；填了就以它为准（自动补 <code>.json</code> 后缀）。
        支持「另存为」对话框的浏览器会弹出<b>让你选保存位置</b>，不支持的直接按下载设置落到默认目录。</div></div>
    <div class="sl-err" id="bk-err" hidden></div>
    <div class="sl-note">导出码只含<b>备份范围内</b>的 10 项配置；用户列表、分享链接、订单、
      <b>邀请码</b>（条数可能过多，故不备份）与各类密钥文件
      （<code>secret.key</code> / <code>enc.key</code> 等）一律不含，也无法备份。</div>`;

  const fail = (msg) => {
    const box = wrap.querySelector('#bk-err');
    if (box) { box.textContent = msg; box.hidden = false; }
  };

  openModal({
    title: mode === 'copy' ? '复制备份码' : '导出配置为 JSON',
    body: wrap,
    cls: 'backup-dialog',
    foot: [
      { text: '取消', value: null },
      {
        text: '生成导出码',
        primary: true,
        onClick: async (overlay, close) => {
          const account = wrap.querySelector('#bk-account-pass').value;
          const bp = wrap.querySelector('#bk-backup-pass').value;
          const bp2 = wrap.querySelector('#bk-backup-pass2').value;
          const nameField = wrap.querySelector('#bk-file-name');
          if (!account) return fail('请输入账户密码');
          if (!bp) return fail('请设置备份密码');
          if (bp !== bp2) return fail('两次输入的备份密码不一致');
          const btn = overlay.querySelector('.dialog-foot .primary');
          if (btn) btn.disabled = true;
          try {
            const r = await API.backupExport(account, bp);
            close(null);
            // R73：把用户填的文件名一起带过去（留空则由 deliver 用默认名）
            deliver(r.code, r.fingerprint, mode, nameField ? nameField.value : '');
          } catch (e) {
            fail(e.message);
          } finally {
            if (btn) btn.disabled = false;
          }
        },
      },
    ],
  });
}

/** 拿到导出码之后的落地：复制到剪贴板，或存成 .json */
async function deliver(code, fingerprint, mode, customName) {
  if (mode === 'copy') {
    const ok = await copyText(code);
    toast(ok ? '导出码已复制（请连同备份密码一起妥善保存）' : '复制失败，请改为「导出为 JSON」',
      { type: ok ? 'success' : 'error' });
    return;
  }
  const payload = JSON.stringify({
    app: 'kepler',
    kind: 'config-backup',
    exportedAt: new Date().toISOString(),
    fingerprint,
    // 备份密码**不写进文件** —— 那是唯一挡在密钥明文前面的东西
    passwordHint: '导入时需要输入导出时设置的备份密码',
    code,
  }, null, 2);
  // R73：文件名可由用户指定；保存位置在支持的浏览器上由「另存为」对话框决定
  const filename = backupFileName(fingerprint, customName);
  try {
    const saved = await saveJsonFile(filename, payload);
    toast(saved.picked
      ? `已保存到 ${saved.name}（备份密码未写入文件，请自行保存）`
      : `已导出 ${saved.name}（备份密码未写入文件，请自行保存）`, { type: 'success' });
  } catch (e) {
    // AbortError = 用户在「另存为」里点了取消：不是失败，不该报错吓人
    if (!e || e.name !== 'AbortError') {
      toast('保存失败：' + (e && e.message ? e.message : '未知错误'), { type: 'error', duration: 6000 });
    }
  }
}

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* 回落到 execCommand */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}

function downloadJson(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ------------------------------ R73：本地 JSON 文件 ------------------------------ */

/**
 * 是否 .json 文件（只看扩展名，大小写不敏感）。
 *
 * ⚠️ 为什么**只**看扩展名就敢拒：`file.type` 在 Windows 上经常是空串（系统没登记
 * 该扩展名的 MIME 时），拿它当判据会把正常的 .json 挡在门外；而反过来，一个改了
 * 后缀的文件即使 MIME 是对的，内容也未必是我们能认的备份。所以策略是
 * **扩展名做门禁、内容做校验**：不是 .json 直接不读（备份里含密钥明文，
 * 不该去「猜」用户塞进来的东西），是 .json 再解析并按字段确认。
 */
export function isBackupJsonFile(name) {
  return /\.json$/i.test(String(name == null ? '' : name).trim());
}

/**
 * 解析备份文件正文，取出导出码。
 *
 * 三级失败各自给**不同的**提示 —— 都归成一句「文件不对」的话，用户无从判断是该
 * 换文件、还是该先把它转成 JSON、还是这份备份本来就是坏的。
 *
 * @returns {{ok: true, code: string, fingerprint: string} | {ok: false, reason: string}}
 */
export function parseBackupFile(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return { ok: false, reason: '这个文件是空的' };
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: '不是有效的 JSON —— 文件无法解析，请确认它没有被编辑器改坏' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: '文件内容不是配置备份（顶层应当是一个对象）' };
  }
  const code = String(data.code == null ? '' : data.code).trim();
  if (!code) {
    return {
      ok: false,
      reason: '这是一份 JSON，但里面没有导出码（缺少 code 字段）—— 请确认选的是 Kepler「导出为 JSON」得到的那个文件',
    };
  }
  return { ok: true, code, fingerprint: String(data.fingerprint || '') };
}

/** 导入时接受的最大文件（备份 JSON 通常几十 KB；超了基本是选错文件） */
const MAX_BACKUP_FILE = 5 * 1024 * 1024;

/**
 * 打开系统文件选择器，取回一个备份文件里的导出码。
 *
 * @returns {Promise<null | {name: string, code: string} | {name: string, error: string}>}
 *   `null` = 用户取消了选择（不是错误，不提示）
 */
export function pickBackupFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.style.display = 'none';
    document.body.appendChild(input);
    let settled = false;
    const cleanup = () => { try { document.body.removeChild(input); } catch (e) { /* 已移除 */ } };
    const done = (v) => { if (settled) return; settled = true; cleanup(); resolve(v); };
    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      if (!f) return done(null);
      const name = String(f.name || '');
      // ① 扩展名门禁：不是 .json 连内容都不读
      if (!isBackupJsonFile(name)) {
        return done({ name, error: `只接受 .json 文件：这个文件是「${name}」，已拒绝、未读取其内容` });
      }
      if (f.size > MAX_BACKUP_FILE) {
        return done({ name, error: '文件过大（超过 5 MB），不像一份配置备份' });
      }
      const reader = new FileReader();
      reader.onerror = () => done({ name, error: '读取文件失败，请重试' });
      reader.onload = () => {
        const parsed = parseBackupFile(reader.result);
        done(parsed.ok ? { name, code: parsed.code } : { name, error: parsed.reason });
      };
      reader.readAsText(f);
    });
    input.click();
  });
}

/**
 * 导出文件名（允许自定义；一定以 .json 收尾）。
 *
 * 非法文件名字符一律换成 `_` —— Windows 的 `:` `*` `?` 这类字符会让下载直接失败，
 * 而失败发生在浏览器层，界面上什么也不会提示，用户只看到「点了没反应」。
 */
export function backupFileName(fingerprint, custom) {
  const fp = String(fingerprint || '').replace(/[^A-Za-z0-9_-]/g, '') || 'config';
  const base = String(custom == null ? '' : custom).trim()
    .replace(/\\/g, '_').replace(/\//g, '_').replace(/\.json$/i, '')
    .replace(/[:*?"<>|]/g, '_').trim();
  return base ? `${base}.json` : `kepler-config-backup-${fp}.json`;
}

/**
 * 把导出码落到用户指定的本地文件。
 *
 * 优先 `showSaveFilePicker`（File System Access API）—— 它能真的让用户**选目录与文件名**，
 * 这才是「自行选择本地文件」；不支持时（Safari / Firefox / 非安全上下文）回落到
 * `a[download]`，由浏览器的下载设置决定落点，行为与改动前一致。
 */
async function saveJsonFile(filename, text) {
  if (typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'Kepler 配置备份', accept: { 'application/json': ['.json'] } }],
      });
      const w = await handle.createWritable();
      await w.write(text);
      await w.close();
      return { name: handle.name || filename, picked: true };
    } catch (e) {
      // 用户在保存对话框里点了取消：交给下面的回落去处理会变成「又下一次」，
      // 因此这里直接向上抛，由调用方决定是否提示。
      if (e && e.name === 'AbortError') throw e;
      // 其它原因（权限 / 不支持的目录）→ 回落到普通下载，不让用户卡住
    }
  }
  downloadJson(filename, text);
  return { name: filename, picked: false };
}

/* ------------------------------ 导入 ------------------------------ */

/**
 * 导入对话框。
 *
 * ⚠️ 用的是**对话框里自己的** textarea，绝不复用页面上那块实时码 —— 后者在配置变化时
 * 会被 `refresh()` 覆盖掉，用户粘进去的内容会在他输密码的过程中被悄悄冲掉。
 */
function openImportDialog() {
  const wrap = document.createElement('div');
  wrap.className = 'backup-form';
  wrap.innerHTML = `
    <div class="enc-warn backup-import-warn">
      <b>导入会直接覆盖本实例的配置，原有设置项全部丢失、不可撤销。</b>
      因此只有在<b>全新部署、尚未配置任何项目</b>的实例上才允许导入。
    </div>
    <div class="form-item"><label>导出码</label>
      <textarea id="bk-import-code" class="backup-code" spellcheck="false"
        placeholder="粘贴「导出」得到的那串 KEPLER-CONFIG-SEALED-V1.… 代码，或点下面从本地选一个备份文件"></textarea>
      <div class="bk-file-row">
        <button id="bk-import-pick" class="mini-btn" type="button">选择 JSON 文件…</button>
        <span id="bk-import-file" class="bk-file-name"></span>
      </div>
      <div class="hint">也可以直接<b>从本地选文件</b>（就是「导出为 JSON…」存下来的那一份），
        选中后导出码会自动填进上面的框。<br>
        <b>非 .json 文件一律拒绝，连内容都不读</b> —— 后缀是 <code>.txt</code> /
        <code>.zip</code> / 其它，或被改过后缀的，会直接提示「只接受 .json 文件」；
        文件本身不会上传到服务器，读取全在浏览器本地完成。<br>
        后缀对但内容不是备份（不是合法 JSON，或缺少 <code>code</code> 字段）会分别提示
        「不是有效的 JSON」/「里面没有导出码」 —— 三种情况分开说，便于判断该换文件还是这份已损坏。</div></div>
    <div class="form-item"><label>备份密码</label>
      <input id="bk-import-pass" class="sl-input bk-input" type="password" autocomplete="off"
        placeholder="导出时设置的备份密码"></div>
    <div class="sl-err" id="bk-import-err" hidden></div>`;

  const fail = (msg) => {
    const box = wrap.querySelector('#bk-import-err');
    if (box) { box.textContent = msg; box.hidden = false; }
  };

  // R73：本地文件入口。取消选择（null）不提示；被拒/解析失败才提示。
  const pick = wrap.querySelector('#bk-import-pick');
  if (pick) {
    pick.onclick = async () => {
      const label = wrap.querySelector('#bk-import-file');
      const r = await pickBackupFile();
      if (!r) return; // 用户取消
      if (r.error) {
        if (label) { label.textContent = ''; label.classList.remove('ok'); }
        return fail(r.error);
      }
      wrap.querySelector('#bk-import-code').value = r.code;
      if (label) { label.textContent = `已读取：${r.name}`; label.classList.add('ok'); }
      const box = wrap.querySelector('#bk-import-err');
      if (box) { box.hidden = true; box.textContent = ''; }
    };
  }

  openModal({
    title: '导入配置',
    body: wrap,
    cls: 'backup-dialog',
    foot: [
      { text: '取消', value: null },
      {
        text: '开始导入',
        danger: true,
        onClick: async (overlay, close) => {
          const code = wrap.querySelector('#bk-import-code').value.trim();
          const pass = wrap.querySelector('#bk-import-pass').value;
          if (!code) return fail('请粘贴导出码');
          if (!pass) return fail('请输入备份密码');
          const btn = overlay.querySelector('.dialog-foot .danger');
          if (btn) btn.disabled = true;
          try {
            const r = await API.backupImport(code, pass);
            close(null);
            const s = (r && r.summary) || {};
            toast(`导入完成：密钥 ${s.credentials || 0} · 桶 ${s.buckets || 0} · `
              + `WebDAV 账户 ${s.webdavAccounts || 0} · IP 规则 ${s.ipRules || 0}`, { type: 'success' });
            loadStatus();
            loadCode();
          } catch (e) {
            fail(e.message);
          } finally {
            if (btn) btn.disabled = false;
          }
        },
      },
    ],
  });
}

/**
 * 供调试 / 测试读取当前实时码（不参与渲染逻辑）。
 *
 * ⚠️ 这里刻意**不**再导出一份「备份范围 10 项」的常量：清单由服务端 `GET /backup/status`
 * 下发（`server/backup.js` 的 `SCOPES` 是唯一实现点）。前端再抄一份，下次加一项必然只改
 * 服务端，界面上却还少一项 —— 而两边都「看起来写了」。
 *（界面上出现的「共 10 项」是**文案**，不是判据 —— 它由 `audit38` 的护栏盯着与服务端对齐。）
 */
export function currentLiveCode() { return liveCode; }
