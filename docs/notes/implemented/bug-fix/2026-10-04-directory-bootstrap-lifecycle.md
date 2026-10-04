# 目录初始化的完成信号覆盖真实加载请求

状态：implemented

## 问题

GUI 持续出现「无法重新加载 <目录> / signal timed out」。现场 renderer.log 在 10:33:19 同批记录 18 条 bootstrap 失败；SDK 普通请求有 60s deadline。日志没有指出具体慢接口，较早的 Network Service 崩溃与这批超时不能直接归为同一原因。

已确认的放大因素在前端：`bootstrapDirectory` 把慢请求放进未等待的异步 IIFE，返回的 Promise 在请求完成前就结束。`createRefreshQueue` 虽每批只取两个目录，却据此放行后续批次；`bootstrapInstance` 的 booting 去重和目录 pin 也提前解除。首次加载的 `onBootstrap` 直接调用初始化，完全绕过队列。

## 决策

- 移除脱离调用链的异步块，`bootstrapDirectory` 等待原有 `Promise.allSettled` 请求组完成。缓存播种仍同步执行，绘制让步和各请求的数据更新时机不变。
- 首次加载通过同一个刷新队列入队，沿用既有两目录批次上限。队列任务中的 `ensureChild` 若触发首次加载回调，booting 检查阻止重复入队。
- 保留失败提示、请求重试、SDK 60s deadline 和 SSE 豁免，不通过增大超时或隐藏错误掩盖问题。

## 验证

回归使用真实 SDK 与隔离 transport，控制 `/config` 请求完成时机。旧实现上「返回时 agents 已就绪」「慢请求结束前 Promise 仍 pending」「前两目录阻塞时第三目录不启动」三个断言均失败；修复后 bootstrap 与 queue 定向测试合计 11 条通过，app typecheck 通过。

另在隔离 Vite 页导入真实浏览器模块，排队 A/B/C 三目录：阻塞时仅 A/B 发起请求、完成数为 0；释放后 A/B/C 全部完成、agents 就绪，未捕获 error 或 unhandledrejection。未重启用户的 GUI，未访问真实后端。

## 备选与否决理由

- **只延长请求超时**：无法恢复队列限流，挂起请求占用资源更久。
- **只等待请求组**：首次加载仍绕过队列，多个目录首次打开时仍能集中初始化。
- **吞掉超时提示**：请求失败和数据缺失依然存在，用户失去诊断信号。

## 后果

目录初始化现在占用队列名额和 pin，直到真实请求完成；后续目录可能需要等待前一批慢请求，这是既有批次限流的实际代价。该改动修复了加载并发与生命周期漏洞，不能证明现场最慢接口已消除；后端单接口仍可能达到 deadline。模型输入、固定前缀与 KV cache 均不变。
