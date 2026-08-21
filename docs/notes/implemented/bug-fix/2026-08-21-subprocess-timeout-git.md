# 给全部 git / 安装类子进程调用加超时上限，并把「超时」作为与退出码正交的独立事实上报

状态：implemented

## 问题

冻结 bug 家族支线 B（子进程/外部调用缺超时 → 无界 async 等待）自 2026-07-24 只修了实际踩到的那一处（`format/index.ts` 的 `formatFile`），其余调用点一直挂账。2026-08-21 逐个核过，`appProcess.run` 共 8 个调用点，**超时上限为零**：

| 位置 | 原本传了什么 |
|---|---|
| `git/index.ts` | 只有 `maxOutputBytes` |
| `snapshot/index.ts` ×2 | 只有 `stdin` |
| `worktree/index.ts` ×2 | 什么都没传 |
| `installation/index.ts` ×3 | 什么都没传 |

危险程度不均等，`snapshot` 最高：它在**每一次编辑**都跑 git，是全仓最热的子进程路径。git 挂起有一堆真实成因——`index.lock` 锁等待、Windows 凭据管理器弹窗、远程 TCP 黑洞、`cat-file --batch` 的 stdin 管道半开。挂起时事件循环并没有被阻塞，evloop drift 探针一声不响（这正是支线 B 的静默签名），日志里一个字都没有，用户只能杀进程重开、丢掉整个会话上下文。

`worktree` 还有一处更野的：`runStartCommand` 用 `cmd /c` / `bash -lc` 跑**用户配置的启动脚本**，同样没有上限。脚本要是个前台常驻进程或在等输入，挂住的是整个 worktree 创建流程；而且它的 catch 把错误信息也一起吞了（`stderr: ""`），失败与挂死在外部看起来完全一样。

实证（本次新增的一次性验证，未入库）：`git ls-remote https://10.255.255.1/x.git` 打黑洞地址，加 2 秒上限后 **2208ms** 被砍断并报 `timedOut=true`；不加上限时它会一直等到 TCP 连接超时。

## 决策

**一、`AppProcessError` 增加 `timedOut` 字段，超时时 `exitCode` 缺席。**

超时是与退出码正交的独立事实，不能塞进退出码分支上报——子进程被 SIGTERM 砍断时仍可能 exit 0，把超时折进退出码会让调用方把"被砍断的运行"读成干净成功。同时导出类型守卫 `AppProcess.isTimeout(err)`，调用方不必去嗅探 cause 的字符串。

这一条是必需的前置条件而非顺手的打磨：本仓三个 git 包装层（`Git.run` / snapshot 的 `git` / worktree 的 `git`）在失败时都会**合成一个 `exitCode: 1` 的假结果**返回给调用方。`snapshot` 的 `ignore()` 里 `check.code === 1` 是 `git check-ignore` 的合法答案（"没有文件被忽略"），一旦超时也合成 1，超时就会被当成一条干净结论读掉。所以上限和正交上报必须同批落地。

**二、8 个调用点全部加上限**，按性质分档：

- 本地 git 管道命令 120 秒（`git/index.ts`、`snapshot`、`worktree`）——够大不会误伤大仓首次快照的合法慢操作，够小能把"永久冻结"变成"报错并留下日志"。
- 网络类 git（`worktree` 的 `fetch`）5 分钟，单独放宽而不是不设限。
- 用户启动脚本 5 分钟。
- 安装类（`installation` 的 brew/npm/choco 与下载来的安装脚本）10 分钟；查询类（`brew list`/`brew info`/`--version`）2 分钟。

`Git.Options` 与 worktree 的 `git` 都新增可选 `timeout`，调用方能按需放宽。

**三、超时单独留日志。**三个 git 包装层与 installation 的两个包装层在 catch 里判 `isTimeout` 并写 `log.error`。这是今天完全没有的诊断面——挂起时日志里一个字都没有，下次复发靠这条日志就能一眼定位。顺带把 `runStartCommand` 吞掉的错误信息还了回去。

**四、`Result` / `GitResult` 三处都新增 `timedOut` 字段**，成功路径恒为 `false`，合成失败路径从错误里取。合成的 `exitCode: 1` 保留（改它会动到既有错误路径的行为），但加注释写明它是合成标记、真正的事实在 `timedOut` 上。

**五、补上超时的回归测试。**`packages/core/test/process/process.test.ts` 此前**完全没有测过 `timeout` 选项**——这个选项一直是"存在但没人验过"的状态，现在全仓都要靠它。新增四例：超时报 `timedOut` 且 `exitCode` 缺席、超时**真的把子进程杀掉**（挂起进程 2 秒后写标记文件，300ms 砍断后等到 2.5 秒确认标记不存在）、按时完成的命令不受影响、普通 spawn 失败不被误判为超时。

## 备选与否决理由

- **把超时值收得更紧（如 30 秒）**：否决——大仓首次快照的 `git add --all` 有合法的慢，误伤的代价是快照失效。这一批的目标是把"无界"变成"有界"，不是调优；有实测证据再逐个收紧。
- **在 `AppProcess.run` 里给所有调用一个全局默认超时**：否决——默认值会静默套到未来所有新调用点上，包括那些合法长跑的（`repo_clone` 已在工具层声明 5 分钟）。让每个调用点显式声明，才能在 review 时看见它选了什么。
- **超时时把 `exitCode` 合成成 124（timeout(1) 的惯例）**：否决——那正是"把一个事实嵌进另一个的分支"的做法。我们不知道退出码，它就该缺席。
- **改掉三处合成的 `exitCode: 1`**：暂缓——会动到既有错误路径的行为，超出本批范围。现在 `timedOut` 已经把事实摆出来了，调用方需要时可以逐个改判。

## 后果

- 超时值是拍的，不是量的。误伤的识别签名：日志出现 `git timed out` / `snapshot git timed out` 但命令本身其实正常，只是仓库特别大——这时放宽对应档位，别把上限撤掉。
- `Result` / `GitResult` 新增了必填字段，任何新构造点都得给 `timedOut`（typecheck 会拦）。
- 闸门已补：`script/check-subprocess-timeout.ts`（挂在 pre-push，也可 `bun run check:subprocess-timeout` 单跑）。它先找出绑定到 `AppProcess.Service` 的变量名再抓这些名字上的 `.run(` 调用，所以调用方改名不会让检查失效；豁免必须写成 `// subprocess-timeout: none — <理由>`，例外可见而不是静默。

  写这个脚本时自己先踩了一次它要防的坑：第一版用 `indexOf("appProcess.run(")` 找调用，漏掉了 `format/index.ts` 里被 prettier 折成两行的那处（`appProcess` 换行再 `.run(`），报出的是「9 处里只看到 8 处、全部合规」这种看着很干净的假通过。修法有两层——接收者改成从 `.run` 往前跳空白再取标识符；更重要的是加了**盲区断言**：一个文件绑定了服务、文本里也有 `.run(`、却一处都没归因上，直接判失败并要求先修检测。这是 help 快照那次（测试从没比对过基线却报 1 pass）的同形状教训。

  三条路径都实测过有牙：拿掉 snapshot 一处 timeout → 报违规并 exit 1；补上豁免注释 → 放行；把 format 的接收者改名模拟归因失败 → 盲区断言开火。
- 借自 deepseek-harness `docs/defensive-patterns.md` 的第一条 "Report orthogonal outcomes independently"；那份文档整体进仓的提议见 DSH 采纳路线图。
