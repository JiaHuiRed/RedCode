---
name: memory-automation
description: 自动化记忆系统——SessionStart 自动注入上下文、PreCompact 保存状态、Stop 时提取教训。减少手动读写 MEMORY.md 的开销。
---

# Memory Automation

自动化记忆环：**启动注入 → 工作 → 压缩保存 → 结束提取**。

## 启动时（SessionStart）

自动做三件事，不做第四件：

1. **读最近日志**：读 `~/.redcode/memory/` 下最近 3 天的日志（按文件名倒序），摘出关键教训
2. **读长期库**：读 `~/.redcode/MEMORY.md`，关注工作纪律和偏好
3. **注入上下文**：把摘出来的教训放在对话顶部，格式：
   ```
   [MEMORY] YYMMDD: 关键教训摘要
   [MEMORY] YYMMDD: ...
   ```
4. **不做的事**：不把整个日志文件 dump 进去，只摘警告和教训

## 工作中

- **犯错被纠正 → 立刻写一句到当天日志**（`~/.redcode/memory/YYMMDD.md`），不等收工
- 连续失败 2 次 → 停手问用户
- 改了敏感区（version、config、schema）→ 停下等确认

## 压缩前（PreCompact）

Context 被压缩前，保存当前状态到 `~/.redcode/memory/.session-last.json`：

```json
{
  "task": "当前任务",
  "progress": "做了啥",
  "remaining": "还差啥",
  "decisions": ["关键决策1", "关键决策2"],
  "files_modified": ["path1", "path2"],
  "errors": ["待处理的错误"]
}
```

## 收工/结束时（Stop）

1. 从 `~/.redcode/memory/` 当天日志摘**关键且需长期警惕**的教训
2. 去重合入 `~/.redcode/MEMORY.md`
3. 删当日日志里已移到长期库的条目
4. 复审长期库，删过时/已内化条目

## 记忆结构

```
~/.redcode/memory/
├── YYMMDD.md          # 当天日志
├── .session-last.json  # 最后压缩时的状态（自动维护，不手动改）
~/.redcode/MEMORY.md   # 长期库（收工/Stop 时更新）
```

## 边界

- 只在启动/压缩/收工时操作记忆文件，不占用正常工作的工具调用
- 日志文件只追加不重写
- session-last.json 只保留最后一次压缩状态，不做历史版本
