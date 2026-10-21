# WSL 路径转换改异步 + 批量合并（RC21-07）

状态:implemented

审计原文：`docs/2026-10-21-third-party-audit.md` 的 RC21-07。

## 问题

`apps.ts` 的 `wslPath` 用 `execFileSync("wsl", ...)`，由主进程 IPC（`wsl-path`）直接调用，
外层 `async` 不会让同步子进程等待异步化。WSL 冷启动或挂起期间，Electron 主进程的事件循环
被整个阻塞 —— 所有窗口操作、IPC、定时器一起排队。触发面还不小：打开目录选择器前要先转换
`WSL home`（`renderer/index.tsx` 的 `wslHome`），选文件与在外部程序打开路径也会走转换。

多选文件那条例外更浪费：`handleWslPicker` 对每个路径各发一次 `wslPath` IPC，
`Promise.all` 让 N 个 WSL 进程同时冷启动。

## 决策

- **异步执行**：`execFile` + `timeout: 5s` + `windowsHide: true`。超时不是「失败就算了」：
  WSL 挂起时子进程可能永远不返回，超时是唯一的出口。
- **可注入的执行器**：`createWslPath({ exec, platform, timeoutMs })`，生产用默认 `execFile`，
  测试用假执行器。否则测试只能靠「本机装没装 WSL」来决定能不能跑。
- **错误信息可操作**：`WSL path conversion failed after 5000ms: … Check that WSL is installed
and running (wsl -l -v), then try again.` —— 只说 failed 等于让用户去猜 WSL 有没有起来。
- **批量合并**：新增 `wslPathMany`，用一段 shell 循环
  `for p in "$@"; do wslpath -u "$p"; done` 一次性转换所有路径，进程只起一次
  （`sh -lc script redcode a b` 里 `redcode` 占 `$0`，其余进 `$@`）。
  `~` 开头的仍走单条路径 —— 它必须由远端 shell 展开，不能当字面量塞进 `$@`。
- **错位保护**：批量输出行数必须等于输入条数，否则整体失败。宁可让用户重试，也不能把
  转换结果配给另一条路径。
- **调用面**：IPC 新增 `wsl-paths`，preload 暴露 `wslPaths`，渲染层的多选分支改用它；
  转换失败保留原路径并 `console.warn`（选择器本身已经成功，只是路径没转成 Linux 形式）。

## 备选与否决理由

- **只加 timeout、保留同步调用**：否决 —— 超时同样是阻塞等待，只是上限从「无限」变成 5 秒；
  审计要的是主进程事件循环持续响应。
- **丢进 worker thread**：否决 —— 为了一个短命子进程引入线程池与消息协议，代价远大于收益；
  `execFile` 本来就是异步的。
- **限制并发（例如一次 2 个）**：否决 —— 串行或小并发仍要 N 次 WSL 冷启动，合并成一次才是
  数量级的差别。
- **批量失败时逐条回退**：否决 —— 会重新引入 N 次冷启动，而且失败原因（WSL 不可用）通常
  对所有路径一样；一次性失败、由调用方回退原路径更诚实。

## 后果

- 主进程在等待转换期间照常处理定时器与其他 IPC（测试用「pending 转换期间 timer 仍触发」钉住）。
- 多选 N 个文件从 N 次 WSL 冷启动变成 1 次。
- 超时/失败的错误信息直接指向 `wsl -l -v`。
- 验证：`apps.test.ts` 8 条（非 win32 短路、单条转换、`~` 展开、事件循环不阻塞、超时可操作、
  批量单次调用、行数不匹配拒绝、混合 `~` 与普通路径的位置不丢）；`packages/desktop`
  typecheck 通过。真实 WSL 手工核对过两条命令：批量脚本输出 `/mnt/c/Windows`、`/mnt/c/Users`，
  `~` 分支输出 `\\wsl.localhost\Ubuntu\home\red314`。
- **未做**：WSL 挂起状态下的实机延迟测量（审计同样标注为待测）。这次改的是「不再阻塞」与
  「只起一次进程」，具体在挂起机器上省下多少毫秒，需要一次带日志的实机观察。
