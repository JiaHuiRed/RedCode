# 回合收尾的定向验证与交付报告

状态: implemented

## 问题

Agent 最常见的失败不是「改不动代码」，而是**结论先于证据**：没跑检查就说完成；换了三个文件却只说了一个；检查失败了被总结成「验证通过」。仓库里已有快照与 diff 基础设施，但没有把「这一轮改了什么 → 该跑什么 → 结果如何」接成一条用户可见的证据链。

任务书 RC-05 要求：编辑批次结束、准备最终回复时，给出 `changed_files`、`checks[]`（name/command/status/exit_code/duration）、`unrelated_change_warning`、`not_run_reason`、`snapshot_or_diff_ref`，状态严格区分 `passed/failed/skipped/not_run`，命令仍走既有权限体系，默认不跑全量测试。

## 决策

- 新增 `session/verification.ts`（`SessionVerification` 服务），由 `runLoopImpl` 在**真正结束一轮**（`exiting loop` 前的 break）调用。排队消息续跑不触发。
- **改动文件来源两条**：本轮 assistant 消息（`parentID === user.id`）里的 `patch` part，以及 `edit`/`write` 工具入参。只靠 patch 的话，`snapshot=false` 或非 git 项目就等于静默关掉验证。路径在挂载点统一归一化为 worktree 相对路径并去重（patch 记的是绝对路径）。`bash` 改文件不在 v1 覆盖范围。
- **检查选择保持窄**：默认只自动选受影响包（向上找最近的 `package.json`）的 `typecheck` 脚本；`lint` 会扫全仓、`test` 需要项目专属过滤参数，自动跑只会制造假失败。其他检查用 `verification.commands` 显式声明（空格分词、不经 shell）。包管理器按锁文件判断（bun/pnpm/yarn/npm）。
- **权限**：每条命令先走 `Permission.ask`，ruleset 取当前 agent 与 session 的并集；`deny`/`reject` 记为 `skipped`，不绕过、不降级为直接执行。
- **执行**：`AppProcess.run`，显式 `timeout`（默认 120s）、输出各 32KB 上限、串行执行；超时记为 `failed` 且原因写明 `timed out after Nms`，不静默。
- **报告与显示分离**：检查结果始终计算并写 `session.prompt` 日志；是否落成可见 `text` part 由 `verification.notice` 决定（261109 Wonyoung 追加）——`failure`（默认，仅 `failed` 或受保护路径被改动时显示）/ `always` / `off`。通过回合不再往正文追加「交付验证：…」，避免把正常收尾读成异常。
- **正文形状**：显示时作为 assistant 的可见 `text` part 落库（与 `appendNotice` 同路径），结构化结果挂在 `metadata.verification`。正文有 4KB 字节硬上限（10 条文件 + 300 字符原因 + 字节截断），因为它会进入下一轮模型上下文。
- **状态**：全通过 `passed`；任一失败 `failed`；全部跳过 `partial`；没有可跑项 `not_run` 并写原因。绝不把跳过汇总成通过。
- 配置：`verification.{enabled,notice,timeout_ms,max_checks,disabled_scripts,commands,protected_paths}`，默认开启（`enabled === false` 才关；`notice` 默认 `failure`）。

## 备选与否决理由

- **新增 `verification` part 类型**：否决——要同步 OpenAPI、SDK 与 TUI/GUI 渲染；v1 用 text part + metadata 即可机器读取，客户端零改动。
- **只在提示词里要求模型自己跑检查**：否决——那正是当前失败模式，靠自觉等于没有约束。
- **自动跑 `package.json` 的 `test` 脚本**：否决——本仓裸 `bun test` 默认 5s 超时会大面积假失败，通用层无法猜对项目专属参数。
- **验证失败时自动续跑让模型修**：暂不做——会把一轮变多轮、成本不可控；先让证据可见，续跑策略后续再评估。

## 后果

- 回合末尾多一次 `typecheck` 级检查（本仓约 12s）；不需要的用户可 `verification.enabled: false`。默认不占会话正文。
- 显示时报告文本会进入下一轮上下文，token 有界（≤ 4KB，实测普通回合 100-300 tokens）；不显示时只进日志。
- 已知缺口：`bash` 内改文件不会进 `changed_files`；`protected_paths` 是前缀匹配、不是 glob；子会话不跑（避免每个子代理收尾都验证）。
- 识别签名：默认 `notice=failure` 时，只有检查失败或受保护路径被改动才在最终 assistant 消息出现 `metadata.verification`；「这轮验了什么」统一查 `session.prompt` 服务的 `verification` 日志（status / changed_files / checks / not_run_reason）。若正常回合连检查都没跑，先查 `verification.enabled`、包目录定位与 `disabled_scripts`。
