本项目主要为服务器端部署服务，客户端为临时性解决方案。

因此客户端版本可能不是最新版，它也不会进入审计护栏以保证其追踪最新版。

────────────────────────────────────────────────────────────────
客户端二进制（Windows 的 Kepler.exe、Android 的 app-debug.apk）**不进仓库**，
改由 GitHub Releases 分发：

    https://github.com/xingsen2005/Kepler/releases

原因：两个文件合计约 160MB，进了仓库就等于让每一次 clone 都拖上这 160MB，
而且二进制与源码版本必然漂移（git 差异里只显示一行 "Bin"，没有任何可审内容）。
本目录因此只保留构建脚本与这份说明，`.gitignore` 已挡掉 `*.exe` / `*.apk` / `*.aab`。

自行构建：
    Windows   node scripts/build-client-windows.js
              产出 client/windows/Kepler.exe（Node SEA 单文件，内置服务端与前端）
    Android   在 Android 工程里构建（Kotlin + 原生网络栈，不是 WebView 壳）
