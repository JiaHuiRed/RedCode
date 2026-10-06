# 桌宠 V0.2：本地台词与单 tick 闲时调度

状态：implemented

## 问题

GUI 中的赤已有真实事件归一化和静态姿态，权限、提问、成功、失败各只有一句固定气泡。闲置期间没有小动作，已有的 `02-idle-coffee.png` 尚未接入。

初稿用 `on(() => display().kind, ...)` 选词，实际依赖仍是整个 display memo：两个时钟更新、姿态保持 permission 的探针得到三次 effect 执行。因此仅包 `on()` 不能保证台词在同姿态心跳期间稳定。

## 决策

- `pet-lines.ts` 提供本地台词池和纯表现层 reducer；`pet-state.ts`、真实事件订阅与优先级保持不动。权限、提问和终态必说，工作台词在姿态边沿按概率与冷却选取，不在心跳上反复抽词。
- `PetPresentation` 保存上次姿态、开关、气泡及动作期限。沿用 PetLayer 已有的一个 1s tick；期限在 reducer 内推进，不增加动作 interval 或 timeout。动作中出现工作/交互状态时立即取消，旧期限不会清除新提醒。
- 连续进入 idle 后计时，达到间隔时概率选择咖啡帧或纯文字碎碎念。关闭清理 Pet 的 tick 和展示，重开重新计算 idle 期限；权限仍存在时恢复常驻提醒。
- 可调参数归 `settings.v3` 的 `general.petBehavior`，由设置拥有方显式调用 `resolvePetBehavior()` 补齐旧配置缺项；读取与 setter 写入前均校验。没有新增设置页参数控件，也不属于 `redcode.jsonc`。

| 字段 | 默认值 |
| --- | --- |
| `activityChatterChance` | 0.3 |
| `chatterCooldownMs` | 45000 |
| `chatterMs` | 6000 |
| `idleIntervalMs` | 25000 |
| `idleActionChance` | 0.4 |
| `idleActionMs` | 5000 |
| `coffeeChance` | 0.5 |

概率限制在 [0,1]，时长须为有限数且在 [1000,86400000] 毫秒内；非对象、未知字段和非法数值显式报错。红测证实原先对象 spread 会把 `null` 等非法输入掩盖成默认值，新增形状与字段名校验后通过。

## 备选与否决理由

- **额外 interval + 动作 timeout**：否决。期限可以由现有 tick 处理，增加定时器会扩大关闭、打断和迟到回调的清理面。
- **每个心跳重新选词**：否决。高频更新只续命展示状态，不能成为每秒换台词或重试概率的机会。
- **复制 crosspet 的文件轮询/外部 hook**：否决。RedCode 已有真实事件流，只复用本地展示思路。
- **非法参数静默回退**：否决。拼错字段不能看似保存成功却不生效；读取非法持久配置会抛出设置异常，需要修正配置。

## 后果与范围

- 赤仍挂在 GUI 的 PetLayer 内；未实现独立透明窗口、桌面拖拽或全局置顶。
- 复用现有图片，本批无需新增素材；planning/reviewing 未接线，也没有连续帧动画。
- 时钟使用 `Date.now()`，气泡和动作在下一个 tick 收回；正常前台约有 1s 颗粒度，后台节流会延后，不宣称硬实时截止。
- 本批没有模型可见改动：不发送引擎事件、不生成会话消息，固定前缀与 KV cache 均不变，无新增模型注入项。

## 验证

- `bun test --conditions=browser --preload ./happydom.ts ./src/pet/pet-lines.test.ts ./src/pet/pet-state.test.ts ./src/context/settings-media.test.ts --timeout 30000`：48 pass，0 fail。
- `bun run typecheck`（packages/app）：通过。
- 实际 PetLayer + SettingsProvider 的隔离 Vite 浏览器预览：咖啡素材加载；权限和工具立即打断；权限台词跨 6.5s 保持稳定；关闭/重开与卸载清理 Pet interval；设置持久化；375px 窄屏无溢出；未捕获运行时错误。未连接真实会话后端或验证 Electron 独立窗口。
- 前置状态契约：`docs/notes/implemented/bug-fix/2026-10-01-pet-stream-heartbeat-winner.md`。
