# Explore 的跨目录 Git 查询按字面量 argv 与真实路径授权

状态: implemented

## 问题

SA-01 修复了新任务 canonical record 漏掉 `shell`，但 Explore 的 Git 权限表仍不覆盖仓库自证需要的 `git -C <repo> rev-parse HEAD/--show-toplevel`，以及 `rev-list --count HEAD/--all`。

只补通配规则不够：权限 matcher 的 `*` 会跨参数匹配，不能证明 `-C` 后面只有一个目录参数；旧的 `git log *`、`git diff *` 还允许 `--output` 写文件。红测分别抓到合法查询被拒、输出文件未被拦截，以及 `-C` 外部目录没有进入路径授权。

## 决策

- 保留原有权限裁决，在 `shell.ts` 执行前为 `ctx.agent === "explore"` 增加局部安全门；其他 Agent 不走新分支。
- 复用已有 tree-sitter AST，只接受单条、无解析错误的字面量 Git 命令。拒绝 Shell 拼接、重定向、变量/命令替换、转义拼接及未加引号的通配路径；不另造 Shell parser。Explore 不使用解析语义不一致的 cmd，仍支持 Bash、PowerShell 7、Windows PowerShell。
- 新增六条有明确结尾的权限规则。`-C` 只允许一个字面量目录，后续 argv 必须完整匹配 `rev-parse HEAD`、`rev-parse --show-toplevel`、`rev-list --count HEAD`、`rev-list --count --all` 之一；不接受全局 config/alias 参数、二次 `-C` 或额外 flags。无 `-C` 的计数查询同样严格匹配。
- `-C` 目录先解析为真实路径，符号链接指向工作区外也必须经过既有 `external_directory` 授权；路径不存在或不可解析则明确失败。命令权限仍按原始命令判定，不把校验后的命令伪装成另一条已授权命令。
- 原有七类 Git 查询仍保留，但禁止 `--output`（含缩写及分离参数）、`-o`、外部 diff/textconv 等执行选项；`branch` 只接受列举 switches，拒绝裸分支名和写操作。复杂查询由父代理执行，不给只读子代理任意 Shell 能力。

## 备选与否决理由

- **只增加 `git -C *` 或只依赖命令前缀**：无法隔离路径与额外 argv，也不能拦住旧白名单中的写文件 flags。
- **引入一套新 Git 工具或重做权限系统**：这次只有仓库身份与提交计数需求，现有 Shell 执行和权限通道已经足够。
- **将不安全查询改走可批准的 destructive 权限**：Explore 的只读边界不应被一次授权悄悄升级，执行层直接拒绝。

## 后果

带空格、中文的字面量路径可用；带 Shell 表达式的路径、复合命令及复杂分支格式查询会明确拒绝。机器上的 Git 可执行文件、插件与已有 Git 配置仍属于既有信任边界，不声称这是针对恶意宿主或并发替换文件系统的 sandbox。

回归覆盖三种实际 Shell 的正例、负例、外部目录与 junction/symlink 真实路径。另以本地 TestLLMServer 跑完整父代理派发 → Explore 实际执行计数 → 拒绝输出文件 → 子结果回到父代理的冒烟；不访问真实模型或使用真实额度。

验证：shell/task/capability/task-runtime/agent 五份定向文件 207 pass、0 fail；补齐 drive-relative 路径拒绝、cmd 拒绝与旧 Git 查询兼容后，最终跨 Shell 10 pass、181 expects；子代理冒烟与邻近 steer/task 生命周期用例 3 pass；opencode typecheck 和版本一致性检查通过。未重编安装版、未重启现有 GUI/sidecar，也未做真实供应商性能测试。

模型可见四问：

1. Explore Markdown 仅更改 YAML 权限规则，正文、工具 description/schema 均不变；违规工具调用返回固定的拒绝文案。
2. 固定前缀 token 增量为零；正常工具结果按实际查询产生，不宣称缓存收益。
3. 工具表原已包含 Bash，固定前缀布局不变；无历史复制、路由或缓存策略改动。
4. 无新增动态注入项；新增拒绝文案均为固定短句，不回显命令或路径，不引入无界上下文。
