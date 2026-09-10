# 模型切换写入模型可见的历史边界

状态:implemented

## 问题

会话重放到不同 provider/model 时，`message-v2.ts` 会刻意剥离旧回合的 provider metadata，并将 reasoning 降为文本，避免把不可迁移的 provider 续写状态带给目标模型。但这也让新模型看不出上方 assistant 回合是由哪个模型生成的；从 DeepSeek V4 Flash 切到 V4.1 Flash 这类能力变化时，旧图像占位和推理痕迹尤其容易被错误归因。

## 决策

当用户消息记录的 model 与此前可见 assistant 回合的 provider/model 不同时，在该用户消息前投影一条 user-role `[model changed: ...]` 通知。通知随历史重放稳定复建，不修改会话存储，也不改变固定 system prompt。

## 备选与否决理由

- **只在 UI 标记模型变化**:否决——UI 状态不进入模型上下文，不能帮助目标模型解释历史。
- **改写 system prompt**:否决——模型切换本就切换了 `modelKey`，再把切换事实塞进固定 prompt 会混淆职责；历史边界才是它真正所属的位置。
- **保留旧 provider metadata**:否决——签名、response ID 与 reasoning payload 是 provider 私有续写状态，跨模型携带会造成协议错误或错误复用。

## 后果

- 首次使用新模型时多一条很短的 user 消息；通知只在真实切换边界出现，后续投影仍会在同一历史位置复建，缓存前缀不会在同一模型的后续回合漂移。
- 没有记录 model 的历史 user 消息保持原行为；它们不凭当前 UI 状态倒推模型切换。
