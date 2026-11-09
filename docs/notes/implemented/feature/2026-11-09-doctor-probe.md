# doctor --probe：真实连通性探测（RC-04 收口）

状态：implemented

## 问题

Harness 任务书 RC-04 要求 `redcode doctor` 具备真实模型/MCP 连通性探测（`--probe`），验收属性：显式 opt-in、限次、费用提示。落地审计（`docs/2026-11-09-harness-optimization-audit.md`）把「补 `--probe` 与输出形状测试」列为收口第一项。此前的 doctor 全是静态检查：`providers` 只数 auth 凭据，`mcp` 只读状态——「配了 key 的到底通不通」没有任何一条命令能回答。

## 决策

- **opt-in 靠 flag 本身**：不传 `--probe` 就一个真实请求都不发。不做交互式确认——CLI 诊断要能进管道（`doctor --probe` 被脚本消费），多一步按回车是负资产。
- **限次 = 3 家 × 1 次**：`PROBE_MAX_PROVIDERS = 3`，每家恰好 1 次最小请求（prompt 一词 `ping`），无重试，`AbortSignal.timeout(15s)` 真正中断底层 fetch + `Effect.timeout(20s)` 兜底防 SDK 忽略 abortSignal 把进程挂住。候选 = 允许的 provider（`enabled_providers`/`disabled_providers`，与静态 `providers` 检查同口径）且有凭据的（`Info.key` 或 `options.apiKey`）；默认模型所在 provider 置顶（`selectProbeProviders`）。无凭据的不探测——静态检查已报 auth 计数，probe 只验「配了 key 的通不通」。
- **模型选择走 `getSmallModel`**：挑最便宜的模型把单次成本压到最低（呼应费用提示）；没有小模型退该 provider 第一家模型。
- **费用提示两处**：`--help` describe、human 模式开场一行。JSON 模式不打印——stdout 必须保持纯 JSON 可解析。
- **probe 失败 = error = 退出码 1**：显式 opt-in 的诊断，用户问「通不通」，不通就是失败。与 doctor 既有契约（只有 error 才算失败）一致。
- **MCP 探测只观察、不自建连接**：MCP 层在 AppRuntime 初始化时已 `forkScoped(connectAll)` 后台连接（`src/mcp/index.ts`），probe 轮询 `status()` 至无 `connecting`（15s 截止），零额外成本。等待超时仍停在 `connecting` 的报 error——挂起比失败更难查。
- **测试的凭据隔离**：spawn 继承父进程环境，机器上若配了真实 provider key（env 型凭据），probe 全量选候选时会对真实上游发起真实请求。smoke 用 `enabled_providers: ["test"]` 覆盖 config 钉死候选，不靠枚举环境变量名。

## 备选与否决理由

- **列模型接口探测（GET /models）**：否决——各 provider 端点不统一（baseURL 形状、鉴权头各异），且验证不了推理路径；`generateText` 是唯一跨 provider 一致的「真连通」信号（同 `experimental.ts` generate handler 的既有形状）。
- **交互式确认后再发请求**：否决——`--probe` 本身就是显式意图。
- **probe 自建 MCP 连接（`connectTransport`）**：否决——该函数未在 `MCP.Interface` 导出；观察既有连接状态同样能给出连通性结论且零成本。
- **每 provider 并发探测**：否决——串行是限次的另一面，也避免同时压同一个上游。

## 后果

- `doctor --probe` 最坏耗时 ≈ 静态检查 + 3×20s（全部超时的极端情况）；正常几秒。
- 输出新增 `probe` 组（仅 `--probe` 时出现），`--json` 顶层形状不变；`model:<providerID>` / `mcp:<server>` 进组内 checks。
- 已知缺口：MCP 探测复用 `status()` 语义（connected 即握手成功），不做 tools/list 级协议往返；env 型凭据在干净 CI 环境自然缺席，不构成断言风险。
- 验证：doctor 单测 5 pass（排序/限次/两映射全分支）；子进程 smoke 3 条（`--json` 形状契约、happy path、401 → error + exit 1）；opencode typecheck 0。
- 识别签名：`doctor --probe` 报 `model:<id>` error 但静态 `providers` 检查正常时，先用 fake server 复现（测试里 `llm.push(httpError(401, ...))` 那条），分清「网络/上游问题」与「凭据解析 bug」。
