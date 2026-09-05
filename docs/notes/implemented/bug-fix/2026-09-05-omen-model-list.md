# Omen 模型列表同步

## 问题

Auth 中的 `opencode-go` 已经存在，models.dev 和本机主缓存也已经包含
`omen-alpha`，但 GUI 模型选择器仍只从 `/config/providers` 返回的 connected
模型表读取。服务端或实例在目录更新前创建时，旧 connected 快照会覆盖同一 provider
的完整目录，导致新模型不可见。

## 决策

在 GUI provider 合并时保留 connected provider 的运行时字段，同时合并完整目录的
models；模型选择器继续只展示已连接 provider 的模型，避免把未认证厂商展示为可用。
打开模型选择器时触发已有的 provider catalog 惰性加载。真实目录 ID `opencode-go`
加入热门 provider 排序，保留旧的 `redcode-go` 标识以兼容已有配置。

## 备选与否决理由

- 只重启服务：能刷新实例快照，但不能修复 connected 快照覆盖目录的结构性问题。
- 让模型选择器直接展示全部目录：会把未认证模型误显示为可选模型。
- 只把 `omen-alpha` 写死：无法覆盖后续新增模型，也会让目录数据源继续分裂。
- 删除 `redcode-go`：可能破坏已有本地配置，因此先兼容两个标识。

## 后果

已认证 provider 的目录新增模型会在目录加载完成后进入 GUI 模型列表，且连接
provider 的运行时配置仍然优先。目录请求只在打开模型选择器或连接 provider 时触发，
不会重新压回首屏启动路径。若服务端模型目录本身不可用，界面仍只能显示已返回的
connected 模型。
