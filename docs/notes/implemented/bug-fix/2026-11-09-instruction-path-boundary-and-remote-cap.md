# 指令注入路径边界与远程读取上限

状态: implemented

## 问题

两处都在 `session/instruction.ts`：

1. **路径包含判定是字符串前缀。** `Instruction.resolve()` 用 `current.startsWith(root)` 判断「在项目目录之下」。项目根是 `C:\work\RedCode` 时，兄弟目录 `C:\work\RedCode-backup` 前缀相同，会被判成项目内。读到项目外文件（外部目录授权后）时，向上遍历会找到兄弟项目自己的 `AGENTS.md` 并作为**本项目指令**注入。同一判定也看不见目录联接：项目内的 junction 指向根外时，`find()` 走逻辑路径、读的却是链接目标的内容。

   实证（修复前）：临时目录下 `proj/` 与 `proj-backup/`，读 `proj-backup/nested/file.ts`，`resolve()` 返回 `Instructions from: …\proj-backup\AGENTS.md`。项目内 junction → `outside/` 同样注入 `outside/AGENTS.md`。

2. **远程指令的字节上限在「读完之后」才生效。** `fetch` 先 `res.arrayBuffer` 整份载入内存，`evaluate()` 再按 `max_source_bytes` 丢弃。chunked 响应没有 `Content-Length` 兜底，内存随响应体大小线性增长，恶意/异常来源可以把这一点当放大器。整体超时是有的，但它只约束时间，不约束峰值内存。

   实证（修复前）：50 块 × 64KiB 的慢流（每块 50ms），旧实现耗时约 3.6s 才丢弃；修复后约 100ms 停止读取。

## 决策

- 新增 `isWithinRoot(root, candidate)`：
  - 主判据用 `AppFileSystem.contains`（`path.relative` 语义，已处理跨盘符、UNC 共享、Windows 大小写），并严格排除根目录自身；
  - 再按 `AppFileSystem.resolve`（realpath）判一次。**符号链接按「逻辑路径 + 真实路径双重判定」**：任一越界即停止向上遍历；
  - realpath 失败（权限、并发删除、路径不存在）时退回逻辑路径结果。链接逃逸是加固项，不能因为解析不出真实路径就把项目内的正常指令全部丢掉。
- `resolve()` 的向上遍历改用 `isWithinRoot`。**读取权限与自动注入资格仍是两个独立判断**：用户主动读项目外文件不受影响，只是不再自动附带那边的指令。
- 远程指令改为流式读取：`res.stream` 逐块累计原始字节，超过 `max_source_bytes` 立即停止并取消响应流，整份丢弃；`Content-Length` 仅用于提前拒绝（服务器可撒谎或缺失，不能代替实际计数）；`fetch_timeout_ms` 仍罩住连接 + 整段响应体读取。
- 日志只输出 `protocol//host/path`，查询串（可能含访问令牌）不进日志。

## 备选与否决理由

- **只用逻辑路径判定**：否决——项目内目录联接可以指向根外，`find()` 读的是链接目标。
- **只用真实路径判定**：否决——realpath 对不存在的祖先/受限目录会失败，会把正常注入一起误伤；逻辑路径是主判据，真实路径是加固。
- **信任 `Content-Length` 代替字节计数**：否决——chunked 无该头，且可声明很小实际超发。
- **超限时给 Inventory 增加 `too_large` 状态**：本次不做——`SourceInfo.status` 是对外 Schema（`/instructions` 面），加枚举要同步 OpenAPI 与客户端；超限/失败仍落 `empty`，原因只写 warning。清单显式解释「超限丢弃」留作后续。

## 后果

- 读项目外文件（含同前缀兄弟目录、链接目标）不再附带该目录的 `AGENTS.md` / `CLAUDE.md`；这是修复目标，不是回归。
- Windows 上 near-by 遍历每层多一次 realpath，深度通常 < 8；本次测试套件整体耗时无明显变化。
- 远程指令超限时 `describe()` 报 `empty`，真正原因（声明长度/实际累计字节/超时）只在日志，且日志里的 URL 已脱敏。
- 识别签名：`isWithinRoot` 被改回 `startsWith` 时，`test/session/instruction.test.ts` 的 sibling / link 两条用例会红；远程读取退回 `arrayBuffer` 时，chunked 用例耗时从 ~100ms 涨到 ~3.5s 并失败，Content-Length 用例从 <1s 涨到 5s+ 并失败。
