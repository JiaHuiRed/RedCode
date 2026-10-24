---
name: gui-regression
description: 用 webqa 驱动 RedCode GUI（packages/app dev 栈）做回归实测。GUI 批次收尾、改动触及滚动/输入/拖拽/流式渲染/消息流路径时触发；把人工「五件套」——长会话切换、连续流式输出、IME 组合输入、历史分页、面板拖拽——变成 agent 可重复执行的实测，替代肉眼验收。
---

# GUI 回归驱动

前置：webqa MCP 已启用（seed 默认开）。webqa 是 Playwright headless——`eval` 动作可跑任意
page.evaluate，IME 组合事件与 pointer 序列都靠它派发；截图取证用 `screenshot` 动作。

## 起栈（一条命令）

```
cd packages/app && bun run dev        # 引擎 serve :4097（--cors）+ vite :5173
```

- 栈就绪的标志：webqa `goto http://localhost:5173` 后 `observe` 能拿到会话列表。
- 连接：web dev 是 http 直连模式；若 UI 首开要求连接地址，指向 `http://127.0.0.1:4097`。
- 长会话数据：引擎读的是本机 `~/.redcode/data`，现存的实测长会话天然可用，优先挑
  消息数最多、含工具调用与压缩边界的会话。
- **收尾必清栈**：杀掉 dev.ts 起的两个子进程（4097/5173 是本机 dev 栈常驻占用惯例，
  留着会撞下一批）。

## 每步之前的取证钩子

进页面后先装错误收集器，任何一件失败都要带着 console 证据说话：

```js
// eval:
window.__rcErrors = [];
window.addEventListener("error", e => window.__rcErrors.push(String(e.message)));
```

## 五件套（全过才算过）

1. **长会话切换**：`observe` 拿会话列表 refs → `click` 切到长会话 A → 再切 B → 切回 A。
   判定：切回后最后一条消息节点存在（eval 查 DOM）、无 >2s 白屏（前后 `screenshot` 对比）、
   `window.__rcErrors` 为空。

2. **连续流式输出**：在会话里发一条会长输出的问题（如「复述 README.md 全文」），
   eval 轮询最后一条消息 textContent 长度（`observe`/`waitFor` 配合）。
   判定：长度单调增长、无重复渲染块、流结束后 UI 收尾状态正确（无永久 spinner）。

3. **IME 组合输入**：webqa 无原生 IME，用 eval 派发组合事件序列到输入框：
   ```js
   const el = document.querySelector("[data-component='chat-input'] textarea, textarea");
   const fire = (t, data) => el.dispatchEvent(new CompositionEvent(t, { data }));
   fire("compositionstart", "");
   fire("compositionupdate", "zhon");
   fire("compositionupdate", "中");
   fire("compositionend", "中");
   el.value += "文";  // compositionend 后的普通输入
   ```
   判定：组合期间消息**不**被提交（消息列表计数不变）、组合结束后一次入队、
   输入框无残留重复字符。

4. **历史分页**：打开长会话 → eval 把消息容器 `scrollTop = 0` 触发向上分页 →
   `waitFor` 消息计数增长。判定：分页加载无跳变、无重复消息（按消息 id 计数去重）、
   加载后滚动位置不飞。

5. **面板拖拽**：目标是 `[data-component="resize-handle"]`（侧栏/文件树/终端的把手，
   `data-edge` 可区分）。真实浏览器里 pointer capture 保证后续事件回到把手，合成事件
   直接派发到把手元素等效：
   ```js
   const h = document.querySelector("[data-component='resize-handle'][data-edge='start']");
   const fire = (t, x) => h.dispatchEvent(new PointerEvent(t, {
     bubbles: true, button: 0, clientX: x, clientY: 200, pointerId: 1,
   }));
   fire("pointerdown", 600);
   fire("pointermove", 400);   // start 边向内拖 = 收窄
   fire("pointerup", 400);
   ```
   判定：拖拽中布局即时变化（eval 读面板宽度）、松手后刷新页面宽度仍保持（持久化）、
   终端把手拖过折叠阈值（拖到 <50px）触发整面板收起。

## 附加场景（触及对应改动面时加测）

- **把手键盘操作**：eval `h.focus()` 后 `press` ArrowLeft/ArrowRight——start 边把手上
  ArrowRight 应**收窄**（与拖拽同向，`492d6a82` 回归锚）。
- **命令面板**：调出 `/command` 面板，等命令列表渲染——不得出现「无法重新加载」toast
  （`c953631a`）。
- **思考块**：对带推理的回复断言思考折叠块存在、正文无字面 `</think>`、无尾部
  summary 标记（`e549e758`）。

## 边界与纪律

- 本 skill 是人工验收的自动化等价物，**不是** E2E 测试套件；五件套通过 ≠ 全量回归。
- 任何一件失败：先取证（screenshot + `window.__rcErrors` + eval 读到的状态值）再报，
  按仓库规矩走 diagnose 闭环，不带证据不猜根因。
- 结果写进批次报告；同一批多次跑注意 dev 栈可能残留（起栈前先查 4097/5173 是否被占）。
