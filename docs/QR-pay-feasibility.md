# 「分享页直接绘制付款二维码」改造可行性分析

**分析对象**：把当前「跳转到支付商页面 → 付款 → 跳回本站」的流程，改为在**文件分享页内直接绘制二维码**，用户扫码即付、不离开分享页。

**分析方式**：先读代码确认现状，再逐渠道核实「是否真有对应接口」。凡属外部 API 能力，均以官方文档为依据，并在文中标注依据；凡属本项目内部约束，均给出文件与行号。

**结论摘要**：**微信支付已经就是这个形态**（`server/payment-gateway.js:495-498`，`kind: 'qrcode'`）。本次要做的实质是**把支付宝与云闪付从跳转型改成扫码型**，而 **PayPal 不具备该能力**。因此这不是一次「重写支付流程」的改造，而是**一次按渠道分叉的能力扩展**，且必须解决四个本项目特有的约束。

---

## 一、现状：微信已经是「分享页画二维码」

代码事实（`server/share-routes.js:2265`）：

```js
if (charge.kind === 'qrcode' && (charge.svg || charge.codeUrl)) return qrPayPage(res, l, order, charge);
```

`createCharge()` 目前**已经**为微信返回二维码：

```js
// server/payment-gateway.js:485-499
const r = await wechatRequest('POST', '/v3/pay/transactions/native', cfg, payload, deadline);
const codeUrl = r.code_url;
return { kind: 'qrcode', url: '', codeUrl, svg: qrcode.toSvg(codeUrl, { scale: 6, margin: 3 }), tradeNo: '' };
```

也就是说：**微信渠道的用户今天已经能扫码支付，不需要改造**。`qrPayPage()`（`share-routes.js:1249-1272`）已经在画二维码并靠 `pay-poll.js` 轮询自动放行。

所以本次需求的真实内容是：**让支付宝、云闪付也走这条路，并把入口从「单独的二维码页」搬回「文件分享页」**。

---

## 二、逐渠道能力矩阵（外部 API 核实）

| 渠道 | 当前实现 | 是否有「商户展示二维码、用户扫码」接口 | 依据 |
|---|---|---|---|
| 微信支付 | `kind: 'qrcode'`，native 下单，本地生成 SVG | **有，且已接入** | 代码即事实 |
| 支付宝 | `alipay.trade.page.pay`，跳转收银台 | **有，但不是同一个产品** | `alipay.trade.precreate` 返回 `qr_code`（[官方文档](https://opendocs.alipay.com/open/02ekfg)） |
| 云闪付 | 银联 `frontTransReq.do`，`txnType=01/txnSubType=01` | **有，但不是同一个产品** | 「申请二维码(主扫)」`txnSubType=07`，走 `backTransReq.do`（[官方文档](https://open.unionpay.com/tjweb/acproduct/APIList?acpAPIId=793)） |
| PayPal | redirect 到 approve 链接 | **无** | 线上收单只有 redirect 到 PayPal-hosted checkout；`/v2/invoicing/.../generate-qr-code` 是**账单**二维码，非收单 |

### 三个必须说清的前提

1. **支付宝的扫码是「当面付」产品，不是「电脑网站支付」**。`precreate` 属于线下产品线，`product_code` 取 `FACE_TO_FACE_PAYMENT` 或 `QR_CODE_OFFLINE`。商户号若只签了网站支付，调 `precreate` 会被拒。这与本项目「本地永远合法、只在真实付款时炸」的失败模式一致 —— 单测全绿、线上不可用。
2. **云闪付的扫码是「二维码支付」产品，不是「B2C 网关支付」**。现在是 `frontTransReq.do` + `txnSubType=01`（收银台跳转），扫码要换成 `backTransReq.do` + `txnType=01/txnSubType=07/bizType=000000`。二者入网时是**分开签约**的。
3. **PayPal 做不到**。这不是工作量问题，是接口不存在。PayPal 线上收单没有「商户展示二维码、买家扫」这个形态（其账单二维码仅用于 in-person 账单）。**若要求「全部渠道都不跳转」，该需求在 PayPal 上无解**，必须保留跳转。

---

## 三、四个本项目特有的约束（真正的工作量所在）

即便只改支付宝与云闪付，下面四点也是硬骨头，且**全部能在本地测试中发现**：

### 3.1 GET 页面不能建单 —— 二维码必须「落了单才存在」

现在是 `POST /s/:id/pay` 建单后才画码。用户要求「在分享页绘制」，若理解为「进分享页就看到二维码」，则 **GET 请求不能建单**（幂等性：浏览器预取、刷新、后退都会重复触发，会造出大量在途订单）。

因此只能做成：**GET 显示「立即支付」→ POST 建单 → 回到分享页并渲染二维码**。也就是说，二维码依然只可能出现在 POST 之后，这是无法绕过的架构事实。

### 3.2 二维码不落库 ⇒ 只有 POST 那一次能看到它

`payment-orders.js` 的 `create()` 不接收 `codeUrl`/`svg`，全库只有 `setTradeNo` 落 `tradeNo`。`charge.codeUrl` 只活在一次 POST 的响应里。

由此产生一个**具体且今天就在发生**的缺陷（不只是未来风险）：

- 用户在二维码页按 F5 —— 浏览器重新提交 `POST /s/:id/pay`，命中 `sameChannel` 复用在途订单，再走一次 `createCharge`，即**用同一个 `out_trade_no` 第二次调微信 Native 下单**。微信 v3 文档明确列有 `OUT_TRADE_NO_USED 商户订单号重复`（[Native 下单](https://pay.weixin.qq.com/wiki/doc/apiv3_partner/apis/chapter4_4_1.shtml)），v2 文档则说「订单重入时要求参数值与原请求一致」—— 即**是否放行取决于微信侧的重入判定，本项目无法在本地证实**。一旦被拒，`createCharge` 返回 `ok:false`，用户看到「创建支付订单失败：商户订单号重复」。
- 而用户只要**不重新 POST** —— 点地址栏回 `/s/:id`、按后退、或把链接发给另一个人 —— `GET /s/:id` 命中 `payer.state === 'pending'` 分支，渲染的是 `payingPage()`（`share-routes.js:1568`），而 `payingPage` 里**没有二维码**（0 处 `qr-box`/`svg`），只有「请在微信完成支付」和「我已完成支付」按钮。

两条路都拿不到可扫的二维码。也就是说：**二维码事实上是一次性的**，而这正是「把二维码画在分享页」这个需求必须先解决的问题。

修法必须是**把二维码落库**（订单表加 `qrPayload` + `qrAt`），让 GET 能重绘同一张码。绝不能「每次 GET 重新下单」—— 那既可能撞上 `OUT_TRADE_NO_USED`，更会与 R90/R92 拼命堵的「双份付款」正面冲突。

### 3.3 本地 QR 编码器有静默失败边界

`server/qrcode.js` 实测（`capacityBytes(10)` 报 216，但）：

```
lastOk = 213, firstBad = 214（返回空字符串，不抛错）
```

**超过 213 字节时 `toSvg()` 返回 `''`，页面画出空白框，不报任何错**。当前微信 `code_url` 约 60 字节、支付宝 `qr_code` 约 48~75 字节，都在安全区。但这是一个真实存在的坑：若未来把更长的内容（如带参数的 H5 链接）塞进码里，会静默失败。建议无论是否做本次改造，都补一条长度护栏。

### 3.4 分享页是服务端渲染 + CSP，前端只能补画

分享页 CSP 是 `script-src 'self'`（`server/index.js:115`），且二维码页今天靠外链 `/js/pay-poll.js` 轮询。若要在分享页内嵌二维码并保持轮询，**不需要新增任何前端依赖** —— `pay-poll.js` 已经在跑，`#pay-state` 已经在用。

---

## 四、影响面与工作量估算

| 改动点 | 文件 | 性质 |
|---|---|---|
| 支付宝扫码下单 | `server/payment-gateway.js` 新增 `alipayPrecreate()`，返回 `kind:'qrcode'` | 新接口，与现有 `page.pay` 并存，**双模式** |
| 云闪付扫码下单 | 同上，`unionpayQr()`：`backTransReq.do` + `txnSubType=07` | 新接口，与现有 `frontTransReq` 并存 |
| 渠道能力声明 | `server/payment-providers.js` 每渠道加 `supports: ['redirect','qrcode']` | 小 |
| 二维码持久化 | `server/payment-orders.js` `create()` 加 `qrPayload`/`qrAt` | 中，涉及 `payments.json` 结构（需兼容老数据） |
| 分享页渲染 | `server/share-routes.js`：`payPage`/`infoPage` 按渠道能力分叉 | 中 |
| 自检覆盖 | `probeCharge` 加 precreate/qr 分支 | 小 |
| 测试 | 需新增审计轮文件（估 10~14 条护栏 + 8~10 条反向对照） | 大 |
| 文档 | `Develop_Document.md` / `CHANGELOG.md` / 版本号四处 | 中 |

**风险点集中在两处**：① 渠道能力声明若做成全局布尔，会把 PayPal 也拖进扫码逻辑（**必须按渠道分叉**）；② 二维码持久化会改 `payments.json` 结构，需按 R89 的既有纪律处理老数据兼容。

---

## 五、给用户的决策建议

### 推荐方案：**按渠道分叉，不追求「全渠道免跳转」**

理由：PayPal 物理上做不到，硬做只会得到「PayPal 假扫码」（把跳转链接编码成二维码，用户扫码后仍在浏览器里被跳转）—— 那比现在更差：多一步扫码，还多一次「扫码后无反应」的困惑。

具体分三档：

| 档 | 渠道 | 做法 |
|---|---|---|
| 一 | 微信 | **零改动**，已是扫码 |
| 二 | 支付宝 | 新增 `precreate` 模式，**由管理员选择**（保留 `page.pay` 作为降级） |
| 三 | 云闪付 | 新增主扫模式，同样可切换；**未开通二维码产品时保持现状** |
| 四 | PayPal | **保持跳转**，不做二维码 |

### 需要用户确认的三件事

1. **支付宝是否已签「当面付」？** 若只签了「电脑网站支付」，`precreate` 调不通。没有的话，本次改造对支付宝只是「多一个保存得下但用不了的模式」—— 与 R91 的教训相同。
2. **云闪付是否已开通「二维码支付」产品？** 同理，未开通则保持 `frontTransReq`。
3. **二维码是否要跨刷新常驻？** 若要，需改 `payments.json` 结构（加 `qrPayload`/`qrAt`）；若不要（刷新即重新发起），可省掉这一大块，但「扫码页按 F5 码没了」这个问题会继续存在。
4. **微信的 `out_trade_no` 重入是否放行，需联调确认。** 微信 v3 列有 `OUT_TRADE_NO_USED`，但本项目无法本地证实。**在未确认前，不应把「F5 二维码页」当成可用路径** —— 这也正是「二维码必须落库」的另一个理由。

---

## 六、结论

- **技术上可行**，且微信部分已经完成，主要工作是**扩展**而非重写。
- **可行范围受签约限制**：支付宝与云闪付各自需要开通对应的扫码产品线，否则只能「配置能保存、付款时才失败」。
- **PayPal 不支持**，任何「全渠道免跳转」的设想都不成立；必须保留跳转作为其中一档。
- 本项目内部有**三个必须先解决的约束**（GET 不建单、二维码不落库、QR 编码器 213 字节静默失败），它们都不涉及外部 API，可在本地全部验证。
- 若只求「最小可用」，建议**只做支付宝扫码**（改动最集中、用户价值最高、有微信的成功先例），云闪付与 PayPal 维持现状，把决策成本压到最低。

---

*本报告基于对 `server/payment-gateway.js`、`server/share-routes.js`、`server/payment-orders.js`、`server/qrcode.js`、`server/payment-providers.js`、`public/js/pay-poll.js` 的实际阅读，以及支付宝开放平台、中国银联开放平台、PayPal 官方文档的能力核实。*
