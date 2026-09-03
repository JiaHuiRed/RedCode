# 圆角改超椭圆、浮层描边画进 box-shadow：形态采纳、数值不跟

状态:implemented

采自 deepseek-harness 2026-09-01 的两篇 note（`web-superellipse-corner-smoothing`、
`web-elevation-stroke-shadows`），第五轮反哺的 A、B 两项。

## 问题

两件都是「界面看着比同类桌面客户端硬」的具体成因：

1. **圆角是纯圆弧**。现代桌面客户端的角是超椭圆（squircle 一族），圆弧角在同样半径下视觉上更"硬"。
2. **浮层描边两种写法并存**。`context-menu` / `dialog` / `select` / `dock-surface` 早就是
   「描边画进 box-shadow」（`--shadow-xs-border` 那族 token 就是干这个的），而
   `dropdown-menu` / `popover` / `hover-card` 还是 `border: 1px solid` + 另一条 `box-shadow`。
   真 border 吃 1px 布局、在 `<button>` 上会顶掉 UA 默认值、描边与柔光层分属两个属性各改各的。

## 决策

**圆角**：`styles/corner-shape.css` 在 `@supports (corner-shape: superellipse(1.5))` 里用
`*, *::before, *::after` 铺满全树，走 base 层。用通配是因为 `corner-shape` **不继承**，
没法在 `:root` 设一次铺开；本仓半径同时来自 Tailwind 工具类、组件 CSS 与 v2 那套，
不存在一份能穷举的类名单。**半径值一个都没动**，只改角的曲率。

全圆形必须退回 `round`：超椭圆会把正圆压成 squircle（用 border 画的 spinner 转起来会晃），
把胶囊两头削方。13 处全圆半径逐条成对写，Tailwind 的 `.rounded-full` 在 utilities 层一条盖掉
（utilities 在 base 之后，无条件赢通配规则）。

**描边**：新增 `--shadow-md-border`（描边层 + 原 `--shadow-md` 的三层柔光），
`dropdown-menu` / `popover` / `hover-card` 改 `border: none` + 这一条。描边色沿用各浮层
原本那条 border 的值——只改承载方式，不改观感。hover-card 的 `background-clip: padding-box`
一并删掉：它存在的理由是别让背景从半透明 border 底下透出来，没有 border 之后是死声明。

**反色面保留真 border**：`toast` / `tooltip` / markdown 的代码复制提示用
`--surface-float-base`（浅色深色两档都是 `#161616`，是固定深色面），跟随主题的描边色画在
上面没有意义。上游同样把 Toast / HoverCard 留在外面，理由一致。

两条扫描防回潮：`styles/corner-shape.test.ts`（全圆半径缺配对即失败）、
`styles/elevation.test.ts`（真 border 与抬升阴影并排即失败，反色面按 `--surface-float-base` 豁免）。
两条都**故意插违例验过会报错**，不是橡皮图章。

## 备选与否决理由

- **跟上游把描边收到 0.5px**：否决——见下方实测，本机 DPR=1 下是变淡不是变锐，
  flat 控件那半更会让边框直接消失。
- **跟上游把半径同批放大 1.25×**：否决——那是给「半径全是 px 字面量、本来就没标度」的仓
  准备的；本仓 260831 刚把圆角标度收归一处，放大等于推翻它。
- **用可继承的自定义属性做 opt-out**（`--corner-shape: round`）：否决——自定义属性会继承，
  胶囊的圆角子元素会跟着一起丢掉超椭圆。逐条 `corner-shape: round` 的作用域正好等于那个形状。
- **只软化阴影、保留 1px 真 border**：否决——留着布局开销与两种写法并存，没解决问题。

## 后果

- 引擎不支持 `corner-shape` 时整条规则读不到，零回退代码。本仓 Electron 42 = **Chromium 148**
  （`ELECTRON_RUN_AS_NODE=1 electron.exe -e 'process.versions.chrome'` 实测），该属性从 139 起可用。
- 新写全圆形必须成对写 `corner-shape: round`，新写浮层必须选 `--shadow-*-border*` 那族 token，
  否则两条扫描失败。
- 转过去的三个浮层各自少了 2px 盒子尺寸（每边 1px），浮层上不可感知。

### 防复发签名：0.5px 在 Chromium 148 上的真实渲染

上游 note 原话是「Chromium 把亚设备像素的 border 画成一个设备像素，1x 屏渲染结果与原来完全一致」。
**这句在 Chromium 148 上是错的。** 用 offscreen `BrowserWindow` 截图逐像素量（白底黑线，读 R 通道，
越小越黑）：

| 写法 | DPR=1 |
|---|---|
| `box-shadow: 0 0 0 1px` | **0**（纯黑实线） |
| `box-shadow: 0 0 0 0.5px` | **127**（半透明，淡一半） |
| `border: 1px solid` | **0** |
| `border: 0.5px solid` | **255（根本没画出来）** |

维护者两块显示器都是 100% 缩放（2560×1440 + 1920×1080，`LogPixels` 未设置）。**再有人提
「上游是 0.5px 我们要不要跟」，先量 DPR。** 高 DPI 环境下结论可能不同，但别凭 note 里那句话直接改。
