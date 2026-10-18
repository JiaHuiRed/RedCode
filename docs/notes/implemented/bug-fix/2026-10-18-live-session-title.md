# 会话标签跟随当前同步状态

状态:implemented

## 问题

手动改名后看板已更新，当前标签仍显示 `New session`，关闭标签重开后才正确。
标题栏在 `mapArray` 的非跟踪映射里查找 session 并捕获 status；标签列表不变时，
迟到加载的 session、替换后的 session 对象与新的状态不会触发重新映射。
原 session 代理上的 title 原位更新可以响应，不能因此把整条更新链判成正常。

## 决策

映射只负责为每个标签建立一个独立 memo，会话查找与状态读取放在 memo 中；
外层消费这些 memo，不要求关闭重开标签。保留 `peek(..., { bootstrap: false })`，
不新增目录 pin、全量 bootstrap 或后台同步订阅，不重建聊天内容。
抽出的 `titlebar-tabs.ts` 同时用于生产标题栏与回归测试，不在测试里复制实现。

## 验证与边界

- 旧映射下三条回归全部失败；修后全部通过：迟到加载、原位改名与同 ID 对象替换、状态变化。
- 既有标题栏历史测试 3 项通过，app typecheck 通过。
- 隔离浏览器直接加载生产 selector 与请求构造函数：标签从 Loading → New session → 改名结果，
  图片 data URL 成功解码，发送 URL 仍是原 file URL，控制台无 error/warn；不等同于安装版验收。
- 未重启当前 GUI，未宣称已安装版本完成验收。
- 仅界面响应性变化，不改模型提示词、工具表、上下文预算或 KV cache。
