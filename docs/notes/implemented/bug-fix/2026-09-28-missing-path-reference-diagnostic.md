# 普通缺失 @path 显式报告

状态:implemented

## 问题

`resolvePromptParts()` 遇到配置化 reference 缺失时会附加 `problem` 诊断，但普通
`@path` 若既不是有效文件也不是 Agent，会直接返回。原始提及因此没有解析结果或提示，
用户无法区分“文件不存在”和“引用未被识别”。

## 决策

普通 `@path` 不存在时追加固定 synthetic 文本：
`Path does not exist; the reference was not attached.`

不把 filepath 再拼进诊断。原路径已经出现在用户输入中；重复复制任意长路径会无谓扩大
模型输入，固定文本本身有确定大小。

## 备选与否决理由

- **继续静默跳过**：否决——用户无法知道该引用没有被附加。
- **在诊断中回显完整路径**：否决——路径来自用户输入，没有局部长度上限，且原输入已经包含它。

## 模型可见改动的四问

1. **模型看到什么变了**：普通缺失 `@path` 现在多一个固定诊断 part；有效路径、Agent 与配置
   reference 的行为不变。
2. **token 影响**：诊断是固定短串，`Token.estimate` 约 13 tokens；不重复注入用户提供的路径。
3. **KV cache 影响**：只影响包含缺失普通 `@path` 的用户消息；变化从该消息 part 起生效。
4. **硬上限**：诊断固定为 52 个 ASCII 字符、52 bytes，`Token.estimate` 为 13 tokens；
   没有用户可控字段。

## 验证

`bun test test/session/prompt.test.ts --test-name-pattern="reports missing local path mentions" --timeout 30000`
通过：1 pass，0 fail。

## 回链

- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/test/session/prompt.test.ts`
