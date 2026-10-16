# ============================================================
# 对象存储管理系统 —— 生产镜像（多阶段构建）
#
# 特性：
#  - 多阶段：仅把运行时依赖与源码带进最终镜像
#  - 非 root 用户运行（node 用户），降低容器逃逸后的影响面
#  - /app/data 声明为 VOLUME：配置加密密钥、用户、日志必须持久化，
#    否则容器重建即丢失全部配置（含 AES 主密钥，丢钥不可逆）
#  - 内置 HEALTHCHECK，配合 CI / 编排系统做就绪探测
# ============================================================

# ---------- 阶段 1：安装依赖 ----------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# 只装生产依赖，且忽略生命周期脚本（本项目依赖无需编译）
RUN npm ci --omit=dev --ignore-scripts

# ---------- 阶段 2：运行 ----------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

# ---------------------------------------------------------------------------
# TLS（R49）：**镜像里不再内置自签名证书**。
# 自签名证书会被浏览器判为不安全，也换不来「安全上下文」才开放的那些功能
# （WebAuthn / Service Worker / 剪贴板 / 通知…），因此它没有意义。现在只加载
# 运维自备的真实证书，路径按下面的顺序解析：
#     TLS_CERT_FILE / TLS_KEY_FILE  →  未设时用 /app/data/tls/fullchain.pem
#                                      与 /app/data/tls/privkey.pem
# 把证书放进已挂载的 data 卷即可，例如：
#     docker run -v kepler-data:/app/data -v /etc/letsencrypt/live/example.com:/app/data/tls:ro …
# 注意 /app/data/tls 下的文件名必须是 fullchain.pem 与 privkey.pem（或用上面两个
# 环境变量显式指路）。**没有任何证书时容器只监听 PORT（HTTP）**，内置 HTTPS
# 与 WebDAV 都不会启动，日志里会说明缺哪个文件。
# 若容器前还有一层反向代理终结 TLS，请把 `PUBLIC_HTTPS_PORT` 设为反代对外的
# HTTPS 端口（明文请求的 301 跳转目标；反代常用 443）。
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# 「本站对外域名」`SITE_DOMAIN` —— 刻意**不**在这里烘进镜像，必须由运行期提供：
#     docker run -e SITE_DOMAIN=cos.example.com …
#     或 docker compose 的 env_file（deploy.sh 生成的 compose 已含 .env）
# 它是 Windows Hello 的 rpId 白名单（security.isOwnSiteHost）与 HTTPS 跳转目标的
# 权威来源。容器里只设 HOST 是不够的：HOST 是**监听地址**，必须是 0.0.0.0 才能被
# 外部访问，而 0.0.0.0 永远不会出现在请求的 Host 头里 —— 于是白名单为空，用真实
# 域名访问本站反而被判成「外站」，启用 Windows Hello 会 403（R38-01 / R39-01）。
# 本机 localhost 调试无需设置。
# ---------------------------------------------------------------------------

# 容器内需监听 0.0.0.0 才能被外部访问；此时务必配合反向代理或仅内网暴露
RUN apk add --no-cache tini

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public

# data 目录预创建并交给 node 用户（之后由卷挂载覆盖）
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]

USER node

# 3000 = HTTP（始终监听）；3443 = 内置 HTTPS（**仅在挂载了自备证书时才监听**）
EXPOSE 3000 3443

# 健康检查：未登录也应返回 200（/api/health 在鉴权中间件里属于受保护路径，
# 因此改为探测 TCP 端口可用性 + 静态首页，避免误判为不健康）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini 作为 PID 1：正确转发 SIGTERM/SIGINT，使 gracefulShutdown 生效（释放端口与单实例锁）
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/index.js"]
