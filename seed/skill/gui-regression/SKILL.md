---
name: gui-regression
description: 用 webqa 驱动 RedCode GUI（packages/app dev 栈）做回归实测。GUI 批次收尾、改动触及滚动/输入/拖拽/流式渲染/消息流路径时触发；把人工「五件套」——长会话切换、连续流式输出、IME 组合输入、历史分页、面板拖拽——变成 agent 可重复执行的实测，替代肉眼验收。
---

# GUI 回归驱动

前置：webqa MCP 已启用（seed 默认开）。webqa 是 Playwright headless——`drag` 动作走
真实鼠标管道（move→down→move(steps)→up，指针捕获语义全真）；IME 组合事件无原生模拟，
用 `eval` 派发但**提交必须走真实键盘**；截图取证用 `screenshot` 动作。

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

3. **IME 组合输入**：webqa 无原生 IME，组合事件用 eval 派发，但**文本落地与提交必须走
   真实链路**——直接 `el.value +=` 不触发 input 事件，SolidJS 受控输入根本看不见，测的是
   假链路。正确序列：
   ```js
   // eval: 组合阶段（此期间消息计数必须不变）
   const el = document.querySelector("[data-component='chat-input'] textarea, textarea");
   el.focus();
   const fire = (t, data) => el.dispatchEvent(new CompositionEvent(t, { data }));
   fire("compositionstart", "");
   fire("compositionupdate", "zhon");
   fire("compositionupdate", "中");
   // eval: 组合文本落地——原生 setter + input 事件，受控状态才会更新
   const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
   set.call(el, "中文");
   el.dispatchEvent(new Event("input", { bubbles: true }));
   fire("compositionend", "中文");
   ```
   然后用 webqa `press`（真实键盘）发 **Enter** 提交。
   判定：组合期间消息计数不变；Enter 后消息**恰好 +1**（不多不少）；新消息文本
   === "中文"；输入框复位为空、无残留重复字符。

4. **历史分页**：打开长会话 → eval 把消息容器 `scrollTop = 0` 触发向上分页 →
   `waitFor` 消息计数增长。判定：分页加载无跳变、无重复消息（按消息 id 计数去重）、
   加载后滚动位置不飞。

5. **面板拖拽**：目标是 `[data-component="resize-handle"]`（侧栏/文件树/终端的把手，
   `data-edge` 可区分）。**必须用 webqa `drag` 动作**（真实鼠标管道）——合成
   PointerEvent 不建立活动指针，把手组件的 `setPointerCapture` 会抛 NotFoundError，
   即使没抛也证明不了真实拖拽。坐标从 `screenshot` 上量（1 截图像素 = 1 CSS 像素）：
   ```
   drag: x=600, y=200, x2=400, y2=200   # start 边向内拖 = 收窄
   ```
   判定：拖拽中布局即时变化（eval 读面板宽度）、松手后刷新页面宽度仍保持（持久化）、
   终端把手拖过折叠阈值（拖到 <50px）触发整面板收起、`window.__rcErrors` 无
   pointer capture 报错。

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
