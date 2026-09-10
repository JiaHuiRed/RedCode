# /recall 换数据源：从 MEMORY.md 正文块改到 supermemory.db

状态:implemented

## 问题

260910 实测 `/recall MCP` 输出「(没搜到与「MCP」相关的教训)」，而库里（`~/.redcode/supermemory.db`）有几十条 MCP 条目。

根因是**脚本与记忆格式脱节**：`recall-memory.mjs` 的 `parse()` 只认 `### ` 开头的教训块（260609 设计，当时 MEMORY.md 存的就是全文），而 MEMORY.md 自 260812 索引化后只剩 `## 分区 + 索引行`，全文件 0 个 `### `——解析结果恒为空数组，任何关键词都召不回。命令挂在 `~/.redcode/command/recall.md`，AGENTS.md 却仍把它当「自动召回没命中时的手动兜底」，文档与实物脱节约一个月。因为空解析退的是「没搜到」这句正常提示，不报错，所以一直没人发现。

## 决策

数据源换成 `~/.redcode/supermemory.db`（FTS5 trigram），检索口径与自动召回插件 `memory-recall.js` 对齐：分句 → 中英文查询词（中文走 3/4 字滑窗、英文取整词）→ FTS5 命中 + 子串校验（挡 trigram 假阳性）→ 按票数排序。默认搜 global + 当前项目（项目名由 cwd 沿 `.git` 指针推断，linked worktree 回主 worktree），`--all` 搜全库。

trigram 索引最小 3 字符：实测 `MATCH '"代理"'` 恒 0 行、`MATCH '"代理三件套"'` 命中——所以 2 字查询改走 LIKE。库只有数百条，全表扫毫秒级，实测可用。

## 备选与否决理由

- **改回「### 教训块」格式**：否决——索引行是对的方向（索引行进注入面、全文按需取），落伍的是脚本；为保脚本而回退数据模型是本末倒置。
- **保留 Ollama embedding 语义路**：否决——它的缓存键基于 MEMORY.md 的块（`blockKey = header + body 前 200 字`），与新数据源不兼容；且 Ollama 常年不在线，实测每次都降级。真要语义检索应在 db 上加 vector 列，而不是维持这套。
- **只读 `lessons-backup.<机器名>.md` 快照**：否决——快照由 pre-commit 时机导出，可能滞后于库；同一份数据挂两个查询源迟早不一致。

## 后果

- `/recall` 恢复为可用通道（260910 实测五种路径：FTS、2 字 LIKE、`--all`、未命中、无参数用法）。`--index` 只剩废弃提示。
- 归档文件 `MEMORY-archive.md` 不在召回范围内；`REDCODE_MEMORY` 环境变量随之失效（旧用法是把它指向归档 md）。
- 部署链有两个方向，踩错会被静默回滚：`seed/scripts` 由 `script/sync-home-scripts.bat` **真镜像**到 `~/.redcode/scripts`（先 `rd /s /q` 再 xcopy），改 home 侧那份会被下次构建物理删除，**必须改 seed**；`seed/command` 相反是 **seed-only**（不覆盖已有文件），所以 `~/.redcode/command/recall.md` 要单独改，只改 seed 则本机永不生效。
- 识别签名：`/recall` 输出恒为「没搜到」而库里明明有命中 → 先查脚本数据源是否又跟 MEMORY.md 的格式脱节（旧脚本失效就是这样潜伏了一个月）。
