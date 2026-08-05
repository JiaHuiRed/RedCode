---
name: memory-automation
description: 自动化记忆系统——SessionStart 自动注入上下文、PreCompact 保存状态、Stop 时提取教训。减少手动读写 MEMORY.md 的开销。
---

# Memory Automation

自动化记忆环：**启动注入 → 工作 → 压缩保存 → 结束提取**。

## 启动时（SessionStart）

自动做三件事，不做第四件：

1. **先读会话索引**：读 `~/.redcode/memory/INDEX.md`（每 session 一条 50–100 token 摘要），摘出相关教训；只有需要某天细节时，再读对应 `YYMMDD.md` 全量日志
2. **长期库按需召回**：不再整体读 `~/.redcode/MEMORY.md`（已撤出 instructions 注入），改用 `/recall <关键词>` 按需召回历史教训；工作铁律由 `AGENTS.md` 的 CORE 块每轮注入兜底
3. **注入上下文**：把摘出来的教训放在对话顶部，格式：
   ```
   [MEMORY] YYMMDD: 关键教训摘要
   [MEMORY] YYMMDD: ...
   ```
4. **不做的事**：不把整个日志文件或 MEMORY.md dump 进去，只摘警告和教训

## 工作中

### 硬触发器（必须记，不等收工）

以下情况**必须立刻**写一句到 `~/.redcode/memory/YYMMDD.md`，不能跳过：

1. **被批评** → 记下批评内容和原因
2. **被夸奖** → 记下夸奖的原因
3. **犯错被纠正** → 记下错误和正确做法
4. **用户透露个人信息** → 新偏好、项目变化、习惯等
5. **项目决策** → 用户明确说了"用 X 不用 Y"这类

### 软建议（看情况记）

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

**0. 先同步再动手**：`cd ~/.redcode && git pull --rebase` 拿最新记忆（别的会话/另一台机器可能刚推过），基于最新版再编辑，避免覆盖别人刚写的。

1. 从 `~/.redcode/memory/` 当天日志摘**关键且需长期警惕**的教训
2. 去重合入 `~/.redcode/MEMORY.md`
3. 给 `~/.redcode/memory/INDEX.md` 追加本 session 一条 50–100 token 摘要（[Session]/[Lesson]/[Decision]/[Note] 分类）
4. 删当日日志里已移到长期库的条目
5. 复审长期库，删过时/已内化条目
6. **推送私仓**：先 `git status` 核验，**只精确 add 记忆文件**：`cd ~/.redcode && git add MEMORY.md memory/ && git commit -m "..." && git push`，确保今天沉淀的记忆入库。做完这步才算真正收工。**绝不用 `git add -A`/`git add .`——共享工作树里 git 不分谁改的，`-A` 会把别的会话（CC/敏敏/小宋）未提交的改动一起吞进你的 commit。其他文件（souls/skill/redcode.jsonc 等）由改动它们的场景各自精确提交。只在记忆文件确认无误后推送，不中途推送。push 若被远端拒绝（远端有新提交），`git pull --rebase` 合并后重推，绝不 force push。**

## 记忆结构

```
~/.redcode/memory/
├── INDEX.md            # 会话摘要索引（每 session 一条，SessionStart 优先读，省 token）
├── YYMMDD.md          # 当天日志
├── .session-last.json  # 最后压缩时的状态（自动维护，不手动改）
~/.redcode/MEMORY.md   # 长期库（收工/Stop 时更新，按需 /recall 召回，不再整体注入）
```

## How to append (CRITICAL — no append tool exists)

The `write` tool OVERWRITES the entire file. There is NO append mode. To add content to an existing memory file:

1. `read` the file first to get its full content
2. Use `edit` to find the LAST line of existing content and replace it with: that last line + your new content appended below

Example — appending a lesson to `260613.md`:
- `read ~/.redcode/memory/260613.md` → see last line is e.g. `- 教训：xxx`
- `edit` old_string=`- 教训：xxx` new_string=`- 教训：xxx\n\n### 新增内容\n- 新教训`

NEVER use `write` to create content for a file that already exists — you WILL lose existing content.
NEVER use bash `echo >>` — Chinese text WILL be garbled on Windows (GBK encoding).

## 边界

- 只在启动/压缩/收工时操作记忆文件，不占用正常工具调用
- 日志文件只追加不重写（用上面的 read+edit 方法，不用 write 覆盖）
- session-last.json 只保留最后一次压缩状态，不做历史版本
