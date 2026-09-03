---
name: frontend-design
description: 从零构建高设计质量的前端界面/组件/页面，产出去 AI 味的生产级代码；也含逆向分析（截图 → 设计系统 → 代码）。默认 macOS/Apple 审美，用户另有指定则从之。（**构建**用这个；已有界面要审用 frontend-qa）
---

# Frontend Design

Create distinctive, production-grade frontend interfaces that avoid generic "AI slop" aesthetics. Implement real working code with exceptional attention to aesthetic details and creative choices.

The user provides frontend requirements: a component, page, application, or interface to build. They may include context about the purpose, audience, or technical constraints.

## Default Aesthetic: macOS / Apple Design Language

Unless the user explicitly requests a different style, default to an **Apple/macOS-inspired** aesthetic:

- **Vibrancy & Translucency**: Frosted glass (`backdrop-filter: blur()` + semi-transparent backgrounds), layered depth with subtle shadows
- **Typography**: SF Pro Display / SF Pro Text feel. Clean, weighted hierarchy. If SF Pro unavailable, use system `-apple-system, BlinkMacSystemFont` stack or similar premium sans-serif (e.g., Geist, Satoshi)
- **Color**: Neutral base (whites, light grays, subtle warm tints) with carefully placed accent colors. Support both light and dark modes with smooth transitions
- **Spacing & Rhythm**: Generous padding, consistent 4/8px grid, breathing room between elements
- **Corners & Shapes**: Smooth large border-radius (12-16px for cards, 8-10px for buttons), continuous corners where possible
- **Motion**: Subtle, physics-based spring animations. Smooth hover transitions (200-300ms ease). No jarring or flashy effects
- **Iconography**: SF Symbols style — thin stroke, rounded, minimal. Use Lucide or Phosphor icon sets
- **Depth**: Layered cards with soft box-shadows (`0 2px 8px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.08)`), not flat and not overly skeuomorphic
- **Controls**: Pill-shaped toggles, segmented controls, smooth sliders. Native-feeling interactions

## Design Thinking (Non-macOS Requests)

When the user requests a different aesthetic direction:

- **Purpose**: What problem does this interface solve? Who uses it?
- **Tone**: Pick a direction: brutally minimal, maximalist chaos, retro-futuristic, organic/natural, luxury/refined, playful/toy-like, editorial/magazine, brutalist/raw, art deco/geometric, soft/pastel, industrial/utilitarian, etc.
- **Constraints**: Technical requirements (framework, performance, accessibility)
- **Differentiation**: What makes this UNFORGETTABLE?

Choose a clear conceptual direction and execute it with precision. Bold maximalism and refined minimalism both work — the key is intentionality, not intensity.

## General Aesthetics Guidelines

- **Typography**: Choose fonts that are beautiful, unique, and interesting. Pair a distinctive display font with a refined body font
- **Color & Theme**: Commit to a cohesive aesthetic. Use CSS variables for consistency. Dominant colors with sharp accents outperform timid, evenly-distributed palettes
- **Motion**: Prioritize CSS-only solutions for HTML. Use Motion library for React when available. Focus on high-impact moments: one well-orchestrated page load with staggered reveals creates more delight than scattered micro-interactions
- **Spatial Composition**: Thoughtful layouts. Grid-breaking elements where appropriate. Generous negative space OR controlled density
- **Backgrounds & Visual Details**: Create atmosphere and depth. Gradient meshes, noise textures, geometric patterns, layered transparencies, dramatic shadows — use what fits the vision

## 从截图提取设计规范（逆向分析）

当用户上传网页/应用截图并要求「按这个风格做」「提取设计规范」「参考这个图」时，切换到逆向分析模式：

1. **直接看图**：用当前模型的图片理解能力分析截图，不依赖外部 API 或脚本
2. **提取设计系统**：输出结构化的配色、排版、组件特征
3. **结合正向设计流程**：把提取结果当作 `frontend-design` 的输入，生成代码

### 分析维度

按以下顺序提取，每个维度给出可直接使用的结论：

| 维度 | 提取内容 | 输出格式 |
|------|---------|---------|
| **Vibe & Style** | 整体风格关键词（3 个）+ 情绪描述 | `Swiss Style / Bento Grid / Glassmorphism` |
| **Color Palette** | Primary / Secondary / Background / Accent 的 Hex + Tailwind 近似类名 | 色值数组 |
| **Typography** | 字体类型 + 标题/正文字重 + 行高比例 | 字体系统描述 |
| **Component Styling** | 圆角、阴影层级、边框特征 | Tailwind 类名 + 像素值 |
| **Spatial Layout** | 间距规律、网格密度、卡片排列方式 | 布局模式描述 |

### 输出格式

分析完成后，给出两部分输出：

**第一部分：设计系统数据**
```json
{
  "style_name": "从截图推断的风格名称",
  "colors": [
    {"role": "primary", "hex": "#...", "tailwind": "..."},
    {"role": "secondary", "hex": "#...", "tailwind": "..."},
    {"role": "background", "hex": "#...", "tailwind": "..."},
    {"role": "accent", "hex": "#...", "tailwind": "..."}
  ],
  "typography": "字体类型 + 字重/行高描述",
  "components": "圆角/阴影/边框特征描述",
  "layout": "间距规律 + 网格/排列方式"
}
```

**第二部分：可直接使用的 Coding Prompt**
写一段粘贴即用的提示词，包含提取到的所有设计规范，用于指导生成类似风格的组件/页面。

### 与正向设计的衔接

提取结果出来后，直接进入正向设计流程：
1. 用户确认/调整提取的设计系统
2. 按 `frontend-design` 的规范生成代码
3. 保持与截图一致的风格，同时遵守本 skill 的完成标准 checklist

## 从项目提取设计语言（DESIGN.md 模式）

当用户要求沉淀现有项目/页面的设计规范（"写个 DESIGN.md""提取这个项目的设计语言""给后续改动统一风格"），或项目里没有设计文档、后续改动需要一致性时，切换本模式。

### 证据源（按优先级）

| 源 | 前提 | 能证明 | 不能证明 |
|---|---|---|---|
| 仓库源码 | 本地有代码 | token 名、组件归属、明确规范 | — |
| 参考图 | 用户提供喜欢的界面截图 | 跨图重复出现的可观察模式 | 精确 token 值、内部命名 |
| URL 实测 | 只有线上页面 | 渲染结果与 computed 值 | token 名、设计意图 |

源码优先；参考图/URL 只写"可观察模式"，不编造 token 名与精确值。

### 仓库模式证据链

按顺序追踪，只信被渲染链路实际引用的源（import/继承/渲染，名称相似不算连接）：

1. 现有 DESIGN.md / 仓库内设计文档
2. token、theme、CSS 变量、全局样式
3. 共享组件及其变体
4. 代表路由与渲染消费者
5. 局部实现

### 证据纪律（宁缺毋滥）

- 只记录统治设计语言的层（颜色/排版/间距/圆角/阴影的体系与决策），不复制散落值
- 重复 ≠ 意图，局部样式 ≠ 设计决策
- 参考图/URL 的每个结论需三个证明：可见或可度量 + 跨图/跨页重现 + 改变实现选择；缺一即 omit
- 不确定的值写角色描述不写数值；不确定的规则不写

### 参考图 → 审美偏好

用户发多张"我觉得好看"的界面时，提取**交集**：跨大多数图重复出现的特征（配色倾向、排版密度、圆角/阴影风格、动效气质）是稳定偏好，单张出现的一次性灵感。把偏好提炼成一段 taste 描述，写入 skill 的默认审美段或项目 DESIGN.md，让后续构建默认贴近用户口味。

### 当前审美偏好档案（260813 起积累）

以下条目来自用户明确表达的好感，等参考图到位后取交集完善成完整 taste 档案：

> **最强证据是他自己发布的 GUI**（`packages/ui/src/styles/`），不是参考图：参考图证明"觉得好看"，
> 产品证明"真的做了、留下来了、还写了测试防回潮"。以下 #2/#3 采自那里，属证据表里的"仓库源码"档。

- **#1 物理质感的深度交互**：卡片 hover 浮起——`translateY(-4~-8px)` + `scale(1.02~1.05)` + 阴影升档（Material elevation / lift on hover），过渡 150-250ms ease-out，hover 移出时阴影回落略快制造回弹感

- **#2 圆角画超椭圆，但正圆必须成对退回**（源码：`styles/corner-shape.css` + `corner-shape.test.ts`）：
  `corner-shape: superellipse(1.5)`（介于 `round` 与 `squircle` 之间），圆弧角比超椭圆角"硬"。
  **半径值一个不改，只改角的曲率**——纯观感升级、零重排风险。
  用通配选择器 `*, *::before, *::after` 是因为 `corner-shape` **不继承**，`:root` 设一次铺不满；
  整条包在 `@supports` 里，不支持的引擎读不到声明，不需要回退代码。
  ⚠️ **全圆形与胶囊必须显式写回 `corner-shape: round`**：超椭圆会把正圆压成 squircle
  （用 border 画的 spinner 转起来会晃），也会把胶囊两头削方。

- **#3 浮层的描边画进 box-shadow，不与真 border 并排**（源码：`elevation.test.ts`）：
  浮层不许同时写"真 border + 抬升阴影"，描边并进 `--shadow-*-border*` 那族 token 一次画完。
  **例外：反色固定深色面**（toast / tooltip / 代码复制提示，用 `--surface-float-base`）保留真
  border——跟随主题的描边色画在固定深色填充上没有意义。

**方法论（比上面三条更通用）**：这类"同一屏上两种做法并存"的设计债，收敛之后要用**源码扫描测试**
防回潮，而不是靠文档和自觉。本仓两条约定各配一个扫描（`corner-shape.test.ts` /
`elevation.test.ts`），新组件写错当场红。定约定时一并想"怎么防回潮"，否则半年后又是两种做法。

### 输出：项目根 DESIGN.md

frontmatter 放精确 token 值，正文放设计决策与 Do's/Don'ts：

```yaml
---
name: <项目名>
description: <一句话定位>
colors: { ... }
typography: { ... }
rounded: { ... }
spacing: { ... }
---
```

正文按需取节：Overview → Colors → Themes → Typography → Layout → Elevation & Depth → Shapes → Components → Do's and Don'ts。只写有证据支撑的节。

- 不改产品源码，只写 DESIGN.md
- 更新旧文档时先对比历史版，被接受的历史决策保留，除非新证据推翻

## Anti-Patterns (NEVER Do These)

- Overused font families (Inter, Roboto, Arial as primary display font)
- Purple gradients on white backgrounds
- Predictable card grid layouts with identical spacing everywhere
- Cookie-cutter design that lacks context-specific character
- Converging on the same "safe" choices (Space Grotesk, etc.) across different projects

## 完成标准

设计交付前确认以下 checklist 全过，缺一不可。

**设计意图达成**：
- [ ] 选定的 aesthetic direction 在最终实现中可辨认（不是"好看"就完事，要能说清为什么选这个方向）
- [ ] 用户指定的风格要求（如有）已满足，不是默认 macOS 风格

**代码层面**：
- [ ] 所有 interactive 元素可键盘访问（focus 样式可见）
- [ ] 响应式断点有实际内容，不是空壳
- [ ] 没有 anti-patterns 列表里的任何一项（紫色渐变、Inter/Roboto 主字体、嵌套卡片等）
- [ ] 动画只用 `transform/opacity`，不动画布局属性

**可维护性**：
- [ ] CSS 变量命名与设计意图一致（颜色/间距/字号有体系）
- [ ] 没有魔法数字散落各处（重复的 `8px`、`rgba(0,0,0,0.04)` 等应收进变量）
- [ ] 文件结构清晰，一个组件 = 一个文件（不跨文件找样式）

**边界遵守**：
- [ ] 没有顺手加用户没要的功能
- [ ] 没有改触发范围外的文件

---

Match implementation complexity to the aesthetic vision. Maximalist designs need elaborate code. Minimalist designs need restraint, precision, and careful attention to spacing, typography, and subtle details.
