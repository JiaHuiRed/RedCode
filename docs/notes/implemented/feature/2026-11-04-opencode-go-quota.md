# OpenCode Go 额度复用订阅快照

状态: implemented

## 问题

OpenCode Go 订阅有 5 小时、每周和每月三个用量窗口，原有侧栏只采集 ChatGPT 与 GLM Coding Plan。2026-11-04 用现有 Go API key 实测 `GET /zen/go/v1/usage` 返回 HTTP 200，`usage.rolling`、`weekly`、`monthly` 各含状态、已用百分比和 ISO 重置时间。

## 决策

使用模型请求相同的 Go API key 查询官方接口，复用额度快照、刷新去重、凭据切换保护和全局事件。前两个窗口映射 primary、secondary；新增 monthly，与 Plus 的独立 reserve 区分。月窗口长度用 0 表示按订阅周期计算而非固定分钟数，界面显示月额度标签和实际重置时间，不显示 0 分钟。

## 备选与否决理由

- 网页内部 RPC：需要浏览器 Cookie 和 workspace，接口细节也更易变化；已有 API key 接口不需要这些凭据。
- 把 monthly 放进 reserve：备用额度池与月用量语义不同，会误导已有消费者。
- 按 30 天显示：实际月周期并非固定时长。

## 后果

每次额度刷新会额外请求 Go 接口；失败沿用已有的旧快照保留策略。用量来自上游百分比而不是本地 token 估算。额度接口不提供截图中的余额，不在侧栏虚构余额。
