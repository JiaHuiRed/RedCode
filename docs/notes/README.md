# 决策记录(Agent Notes)

> 制度引自 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 `.agents/notes/`(1369 篇实践),2026-08-14 起在 RedCode 落地。

记录**技术决策的 why**:为什么这么设计、放弃了什么备选、代价是什么。与其他记忆载体分工:

- **本目录(notes)** —— 技术决策。进 git、跟代码同 commit 演进、任何会话/agent/机器可检索,不漂移。
- **agent 私有 memory** —— 协作层:维护者偏好、工作方式反馈、跨会话状态。不进仓。
- **CHANGELOG** —— 按版本的用户可见变更(what)。根因分析写结论即可,why 链接到 note。

## 规则

1. **非平凡改动同 commit 附 note**(新增或更新既有 note)。机械性/局部小改豁免。判据:这个改动一个月后会有人问"当时为什么这么做"吗?会,就写。
2. **一事一文**,文件名 `YYYY-MM-DD-短横线主题.md`,放进对应状态目录。
3. **四态目录**:
   - `implemented/` —— 已落地的现行决策,用现在时描述已成事实;代码变了就同 commit 更新。
   - `proposed/` —— 已想清楚未动手的方案。
   - `rejected/` —— 明确否掉的方案,**保留**——防止后来者(尤其是不同会话的 agent)重新提起已否决的路线。
   - `archived/` —— 被后续决策替代的历史。**冻结:永不编辑、永不引用为现行权威**。
4. 按主题再分子目录:`architecture/` `feature/` `bug-fix/` `process/` `simplification/`。

## 模板

```markdown
# <决策标题:一句话说清做了什么>

状态:implemented | proposed | rejected | archived

## 问题

驱动这个决策的具体问题。带实证:日志、复现、数据。

## 决策

做了什么。写现状,不写"将会/应该"。

## 备选与否决理由

- **<备选 A>**:否决——<一句话理由>。
- **<备选 B>**:否决——<一句话理由>。

## 后果

代价、限制、后续牵连;需要防复发的,写清识别签名。
```

正文体例沿用 CHANGELOG 详注文风(根因/取舍/实证),不必翻译成英文。
