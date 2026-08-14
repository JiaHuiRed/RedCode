# stall nudge 退役:空转劝阻收敛为软硬两层

状态:implemented

## 问题

260803 加的 stall nudge(本轮连续相同工具调用 ≥8 次 → 每轮一次 role:user 注入"换思路")与 260814 落地的 repeat-tool-reminder 软层指纹口径完全同源(`tool + JSON.stringify(input)`),空转劝阻变成三层并存:软层 3/5/8 递进贴 result 尾部、stall nudge 8 注入 user role、doom_loop 硬层弹窗。8 次那档软层详版与 nudge 在同一 step 双响,文案重复、来源分裂,还多占一条 user role 注入位(260731 撤除每步注入的教训:user role 注入要克制)。

## 决策

stall nudge 整块删除([[2026-08-14-repeat-tool-reminder-soft-layer]] 的软层接管):软层比它早介入(3 次起劝)、粒度细(todo 透明、错误也计数、跨轮取样、resume 安全),真空转仍有 doom_loop 硬层(3 连 + 报错/同输出 → 权限弹窗)兜底。两层分工:软层劝、硬层拦。

## 备选与否决理由

- **保留 nudge 作 8+ 兜底、软层只管 3/5**:否决——软层 8 档详版文案已覆盖同一场景,保留即双响。
- **nudge 阈值抬到 12 作"最后通牒"**:否决——超过 8 仍在重复的,要么是合法轮询(不该骚扰),要么硬层早已弹窗(用户在裁决),第三层没有生态位。

## 后果

- prompt.ts 少一个 user role 注入源与一个 per-turn flag;runLoop 顶部留退役注释指向本 note。
- 与 Reasonix "todo stall 8 轮对齐"的出处随之失效——软层阈值 [3,5,8] 尾档延续了 8 这个数,语义等价。
- 空转提醒的触达时机从"下一 step 的请求"变为"触发那次调用的 result 尾部",更早一拍。
