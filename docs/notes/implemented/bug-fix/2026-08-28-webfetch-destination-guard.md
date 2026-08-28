# webfetch 目的地守卫：拒非公网地址、逐跳校验重定向

日期：2026-08-28 · 状态：implemented · 来源：deepseek-harness `packages/web/web-fetch-http/src/network.ts`（上游 08-22..08-28 那批里的 `b2219bba` / `709e5eda`）

## 问题

`tool/webfetch.ts` 此前对目的地只有一条检查：URL 必须以 `http://` 或 `https://` 开头。模型给出 `http://169.254.169.254/latest/meta-data/`（云元数据端点）、`http://192.168.1.1/`（路由器管理页）或 `http://127.0.0.1:port/`（本机服务）都会照常发出去。

权限层不构成防线：`ctx.ask` 的 `always: ["*"]` 意味着用户对 webfetch 选过一次「始终允许」之后，**任何 URL 都不再出现审批**。而模型给出的 URL 常常来自它读到的网页内容——那是不可信输入。

本仓刚放开局域网访问（GUI 挪到根路径、局域网暴露强制密码），内网可达面比之前大。

## 决策

### 1. 一个地址分类器，两档拒绝

新增 `util/net-address.ts`。`classifyAddress()` 判断 IP 字面量是不是公网单播，非公网时给出命中的段名。分两档：

- **`overridable`（配置可放行）**：环回 `127/8`、`::1`、RFC1918、CGNAT `100.64/10`、ULA `fc00::/7`。**人真的会在这些地址上跑服务。**
- **不可放行**：link-local `169.254/16` 与 `fe80::/10`（云元数据端点就在这里）、组播、保留、未指定 `0/8`、文档段、基准测试段、`100::/64`。**没有任何正当的 webfetch 用途。**

这一分档比上游更细：上游是一刀切拒绝，而 RedCode 是本地编码代理，「让代理看一眼自己起的 dev server」是正当工作流。但「我要访问本地 dev server」不应该顺带把云元数据端点一起打开。

IPv4 映射（`::ffff:a.b.c.d`）与 **NAT64（`64:ff9b::/96`）都要拆包按内嵌 v4 判**，否则 `64:ff9b::169.254.169.254` 就是一条免费绕过——这条是照抄上游的，它在 `network.ts` 里专门有一行处理。

### 2. 配置逃生门 `webfetch.allow_private_hosts`（默认 false）

放行 `overridable` 那几类。不开也不影响能力：真要访问本地地址走 shell 命令，那条路有它自己的审批。

### 3. 审批在 DNS 解析之前

`ctx.ask` 保持在最前，目的地校验放在它之后。否则一次会被拒绝的调用也已经替模型做过一次名字解析，**审批本身就成了探测原语**。

### 4. 重定向改手动跟随，逐跳校验

`FetchHttpClient` 基于 `fetch`，默认 `redirect: "follow"` —— 只有第一跳会被看到，公网 URL `302` 到 `http://169.254.169.254/` 是这类守卫最经典的绕过。改为 `Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" })` + 自己的跟随循环，每一跳都过一次校验，并且**不受 `allow_private_hosts` 短路**（该配置只放宽 `overridable` 那几类）。顺带补上：跳数上限 5、拒绝重定向到非 HTTP(S) scheme。

原来的 `HttpClient.filterStatusOk` 与它配套的 Cloudflare 403 重试改写在循环里按 `res.status` 直接判——手动重定向下 3xx 不再是"失败"，`filterStatusOk` 会把正常的重定向变成错误。

## 备选与否决理由

- **像上游一样一刀切拒绝所有非公网地址**：否决。本仓既有的 webfetch 测试全部是 `Bun.serve` 起本地服务再 fetch `localhost:PORT` —— 那不是测试的偷懒写法，它就是这个工具在编码场景下的正当用法。
- **给非公网目的地单独开一个 permission key（例如 `webfetch_private`）**，让 `webfetch:*` 的既有授权覆盖不到它：否决。要动 config schema、GUI 权限面板与文档，爆炸半径远大于收益；而配置逃生门已经把"默认安全"和"能用"都拿到了。
- **靠 `response.url` 事后检查最终落点**：否决。那时请求已经打到内网主机上了，副作用与数据外泄都已发生。
- **同时堵 DNS rebinding**：没做。真正堵死要按解析结果直连 IP 并自带 Host 头，`fetch` 做不到；上游同样只做到解析期校验。已在 `net-address.ts` 顶部写明这个边界，不假装覆盖。

## 验证

`test/util/net-address.test.ts`（15 例）：各段边界与**紧邻边界的公网地址**（`172.15.255.255` / `172.32.0.0` / `100.63.255.255` / `223.255.255.255` 等，防止范围判据写宽）、IPv6 各段、zone id、IPv4 映射拆包、NAT64 拆包、`localhost` 走解析分支、`allowPrivate` 开关的放行面与不可放行面。

`test/tool/webfetch.test.ts` 新增 6 例：默认拒绝本地目的地、错误信息点名地址与段名、手动跟随三跳重定向拿到最终 body、**首跳被 `allow_private_hosts` 放行但重定向到 `169.254.169.254` 仍被拦**（逐跳校验的核心用例）、拒绝重定向到 `file://`、跳数上限。既有 4 例改为显式带 `{ config: { webfetch: { allow_private_hosts: true } } }` —— 它们同时充当"本地地址要显式开"这条契约的用例。

`bun test test/util/net-address.test.ts test/tool/webfetch.test.ts` 25 pass / 0 fail；`bun run typecheck` exit 0（tsgo 崩溃回退 TS 5.9.3，与既有一致）。

回归面 `test/config/ test/tool/`：带改动 581 pass / 33 fail，基线（备份 + checkout 还原后）575 pass / 33 fail，快照均为 15 passed / 1 failed。**33 条失败与那条快照失败都是既有的**，差值 6 正是本次新增的用例数。

## 记账

- `websearch` 工具没有走这条守卫。它把查询发给固定的搜索服务端点，URL 不由模型指定，暂不涉及；但它返回的 URL 会被模型拿去喂 `webfetch`，而那一侧已经有守卫了。
- 工具返回的 `title` 仍用请求发起时的 `params.url`，重定向之后不反映最终落点。信息性问题，本次未动。
