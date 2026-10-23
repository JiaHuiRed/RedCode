---
name: frontend-design
description: 构建或重整前端界面与组件，涵盖视觉层级、UI 文案、布局密度、字体、颜色 token、几何深度、动效与交互手感；做完后的设计质检（扫描 + checklist 报告）也在本 skill。做界面、做动效、或纠结交互细节时都触发。
---

# Frontend Design

Build usable, coherent, production-grade interfaces without generic AI-template aesthetics. When asked to implement, deliver working code rather than stopping at design commentary. Motion is not a separate discipline — the interaction-craft rules in section 7 apply to every surface you build.

## 1. Decision priority

When guidance conflicts, follow:

1. Explicit user requirements.
2. The existing project's design system and constraints.
3. Supplied visual references.
4. The user's demonstrated long-term preferences.
5. Default taste in this skill.

Preserve an established product's visual language unless a redesign is requested. A local improvement does not authorize a global restyle.

Fix issues in this order — do not decorate around a weak layout:

1. Information hierarchy and necessary content.
2. Layout, alignment, and interaction flow.
3. Spacing and density.
4. Typography and readability.
5. Color and contrast.
6. Shape and depth.
7. Motion and decoration.

Every screen has a limited visual attention budget: if everything has shadow, nothing has depth; if everything moves, motion loses meaning; if every section uses an accent, hierarchy collapses.

## 2. Information and UI copy

- Design for the actual audience and task, not a generic showcase.
- Clear, concise, established terminology. No internal jargon, invented labels, or filler.
- Remove copy that repeats headings, explains the obvious, or fills empty space.
- Do not use `·` as a decorative separator in UI copy.
- No decorative eyebrow/overline labels unless they add context the heading lacks.
- Minimize unnecessary decisions, confirmations, and intermediate steps; place choices where users naturally expect them.
- Preserve necessary errors, warnings, status text, recovery guidance, and accessibility text.
- Direct, specific labels beat safe generic ones — name nav items for their contents ("Progress", "Library"), not vague umbrellas ("Home").
- Preserve safeguards for destructive or irreversible actions; confirmation dialogs only for genuinely destructive actions (overusing them trains users to click through).

## 3. Layout and density

- Establish one focal point per screen or section; group by proximity before adding cards, borders, or extra surfaces. Whitespace is the cheapest separator; cards are the most expensive.
- Align to a consistent grid; optically correct icons that mathematically align but look unbalanced. Edges that almost align but don't read as mistakes.
- Use a small spacing scale (4/8-based). Inner padding relates to outer gaps: an element's inset is usually tighter than the space separating it from siblings.
- Match density to the task: developer tools may be dense; presentation surfaces may be spacious.
- Vary rhythm — full-width bands, offset columns, mixed density — instead of uniform card grids. Use identical cards only for genuinely homogeneous collections.
- Design against realistic data: long labels, empty states, loading, errors, dense tables, overflow, truncation, and the actual target viewports. Prefer fluid layouts (clamp(), container-relative sizing) over device-specific breakpoint ladders.

## 4. Typography

- Build hierarchy from size, weight, and color contrast — in that order — before decoration. Aim for three functional text-size levels per view; a fourth needs justification.
- Line height follows role and tracks size inversely: display ~1.05–1.25, UI text ~1.3–1.45, body ~1.5–1.7. Larger sizes need tighter leading, never looser.
- Tracking is size-specific — never one value for all sizes. Slightly negative on large display type, slightly positive on small labels, zero on body.
- Keep measure readable (~45–75ch for prose). Use tabular numerals for aligned or changing numbers.
- Emphasize with weight — presence without taking more space. One well-used family with weight contrast usually beats two paired families.
- Respect the user's text-size setting: scale layout with text (`rem`/`em`, not fixed px).
- When a project defines a type scale, that scale is a closed set. Off-scale sizes are design-system defects, not style choices. 12px is the general floor; smaller needs a clear role and verified readability.

## 5. Color and tokens

- Reuse existing semantic tokens before introducing new colors. Do not invent token names — confirm definitions in source. A token is a value plus the roles it may serve; same color, different role = not interchangeable.
- Distinguish background, surface, text, border, status, and interactive states by role. Restrained accents: color indicates meaning or priority, never decoration.
- Large color fields carry atmosphere; small saturated accents carry meaning — don't invert them.
- Body text ≥ 4.5:1 contrast, large text ≥ 3:1. Never communicate a critical state through color alone — pair each status color with a foreground token, icon, or label.
- Dark mode is a re-tuning, not an inversion: no pure black/white, slightly desaturated accents, elevation through lightness rather than heavier shadows.
- Maintain adequate contrast in both themes. Specialized palettes (syntax, diff, terminal, charts) may keep their own rules.

## 6. Geometry and depth

- Prefer whitespace and tonal separation before borders; use borders for meaningful structure or states, not decoration.
- Radius is consistent and concentric: nested rounded containers keep visually concentric corners (outer larger, inner smaller). Radius follows the nearest actual container, not DOM depth.
- Depth has an order. When a project defines an elevation chain, pick the tier by role; don't mix tiers inside one component to fake separation.
- Shadows are soft, low-opacity, layered (tight contact + wide ambient). No zero-offset colored glow shadows. Reserve shadows for real elevation (floating, overlay, hover lift).
- Translucency/blur needs a spatial or functional reason. Translucent chrome (nav/toolbars/sheets) lets content scroll underneath via `backdrop-filter`; never stack a light translucent surface on another — legibility collapses. Over blurred surfaces, use higher-contrast slightly-heavier text ("vibrancy"), not flat gray.
- No gradient text, colored edge strips on cards, or glassmorphism without function.

## 7. Motion and interaction

### 7.1 Should this animate at all?

Frequency decides before taste:

| Frequency | Decision |
| --- | --- |
| 100+ times/day (keyboard shortcuts, palette toggles) | No animation. Ever. |
| Tens of times/day (hover, list navigation) | Remove or drastically reduce |
| Occasional (modals, drawers, toasts) | Standard animation |
| Rare / first-time (onboarding, celebrations) | Can add delight |

Every animation answers "why": spatial consistency, state indication, explanation, feedback, or preventing jarring changes. "Looks cool" on a frequently-seen surface is a no.

### 7.2 Response — kill latency

- Feedback on pointer-down, not release. Buttons get `transform: scale(0.97)` on `:active` (0.95–0.98, ~160ms ease-out).
- Feedback is continuous *during* the interaction: drags track 1:1 with the pointer the whole way, respecting the grab offset. Never animate only at gesture end.
- Audit the input path for artificial delays: debounces, timers, transition waits.

### 7.3 Interruptibility — the single most important rule

Every animation must be grabbable and reversible mid-flight.

- Always animate from the current on-screen value, never the target value.
- Never lock out input during a transition.
- For gesture-driven or rapidly-retriggered UI, use CSS transitions (they retarget smoothly), not `@keyframes` (restart from zero on interrupt).
- On reversal, carry velocity through the re-target — a hard cut reads as a brick wall.

### 7.4 Timing and easing

| Element | Duration |
| --- | --- |
| Press feedback | 100–160ms |
| Tooltips / small popovers | 125–200ms |
| Dropdowns, selects | 150–250ms |
| Modals, drawers | 200–500ms |

UI animations stay under 300ms. Ease-out for entering (responsive), ease-in-out for on-screen movement, linear only for constant motion, `ease` for hover/color. Never `ease-in` for UI entrances — it delays the moment the user watches most. Prefer strong custom curves (`cubic-bezier(0.23, 1, 0.32, 1)`-family) over weak built-ins; keep control points within [0,1] (no bounce/elastic). Mirror the easing on reversible transitions. Asymmetric timing: slow where the user is deciding, fast where the system responds — exits are snappier than entrances.

### 7.5 Springs

Think in two designer-friendly parameters, not mass/stiffness/damping:

- **Damping ratio** — 1.0 = critically damped, no overshoot (the default for most UI). ~0.8 = slight bounce, only when the gesture itself carried momentum (flick, throw, drag release).
- **Response** — seconds to reach target (not a duration; springs have none). 0.3–0.4 for most UI.

Apple's shipped values: move 1.0/0.4, rotation 0.8/0.4, drawer 0.8/0.3. On the web, Motion/Framer's `bounce`+`duration` API maps closely.

- **Velocity handoff:** at gesture end, pass the pointer's release velocity into the spring — no visible seam between drag and animation. For APIs wanting relative velocity: `velocity / (target − current)`.
- **Momentum projection:** don't snap from the release point; project the resting point like scroll deceleration, then snap to the nearest target: `current + (v/1000)·d/(1−d)`, `d ≈ 0.998`. Flick dismissal uses velocity, not distance (`velocity > 0.11` dismisses).
- **Boundaries:** rubber-band with progressive resistance, never a hard stop.

### 7.6 Gesture and spatial details

- Track with Pointer Events + `setPointerCapture`; keep a short velocity history; ignore extra touch points after a drag begins; ~10px hysteresis before committing a direction.
- Enter and exit along the same path. Popovers/sheets anchor to their trigger (`transform-origin` from the trigger — the default `center` is wrong for almost every popover; modals are the exception).
- Animate from `scale(0.9)+opacity`, never `scale(0)` — nothing appears from nothing. Use percentage translates (`translateY(100%)`) over hardcoded pixels.
- Tooltips: delay the first, open adjacent ones instantly. Stagger group entrances 30–80ms; never block interaction while stagger plays. A subtle `filter: blur(≤2px)` can rescue an awkward crossfade.

### 7.7 Performance

- Animate only `transform` and `opacity` — they skip layout and paint. `transition: all` and width/height/padding/margin animations are defects.
- CSS variables are inheritable: updating one on a container recalculates every child. Update `transform` on the element instead.
- Framer Motion's `x`/`y`/`scale` shorthand is main-thread, not hardware-accelerated — under load use the full `transform` string. CSS animations run off-main-thread; prefer them for predetermined motion, springs/JS only where interruptibility is needed. WAAPI (`element.animate`) gives CSS performance with JS control.
- For enter animations in plain CSS, use `@starting-style`; fall back to a mounted-attribute pattern.

### 7.8 Accessibility

Reduced motion means gentler feedback, not zero feedback: cross-fades replace slides/springs/parallax; drop overshoot; keep opacity/color changes that aid comprehension. Also respect `prefers-reduced-transparency` (frostier surfaces, no blur) and `prefers-contrast: more` (solid backgrounds, defined borders). Gate hover animations on real pointers — touch devices trigger hover on tap:

```css
@media (prefers-reduced-motion: reduce) { .sheet { transition: opacity 200ms ease; transform: none !important; } }
@media (hover: hover) and (pointer: fine) { .card:hover { transform: translateY(-4px); } }
```

Complete every relevant state: hover, active, focus-visible, disabled, loading, error, empty. Keep interactive targets usable (~40px+ touch) with visible focus indication. Loading states carry text, not just a pulsing dot; empty states carry guidance + CTA.

## 8. RedCode specifics

Preserve RedCode's Apple/macOS-inspired direction and source-backed decisions. Do not refactor the theme while modifying an unrelated component.

**Type scale.** `--font-size-small/base/large/x-large` in `packages/ui/src/styles/theme.css`, exposed as `--text-sm/base/lg/xl` in `packages/ui/src/styles/tailwind/index.css`. Use those, never `text-[13px]`-style one-offs. Exactly one scale entry point — global scaling changes that variable, never the root font size or per-component overrides. The smallest tier carries a usage ban: name the single role it may serve, or it migrates into everything. Code/diff/terminal rendering may keep their own numeric sizes; controls, labels, and metadata around them still use the scale. Known traps: `--font-size-x-small` is referenced in six places and defined in none (define the tier or drop the reference), and ~100 `font-size: Npx` literals already sit outside the scale in `packages/ui/src/components` and `v2/components` — matching neighbours is not a reason to add another.

**Tokens.** Semantic tokens (surface, text, border, icon, syntax, markdown) live in `packages/ui/src/styles/theme.css`. Elevation chain: background → inset → raised → float → overlay — pick by role; a structural surface is not generic card fill. Radius scale is defined once in `tailwind/index.css` (xs/sm/md/lg/xl + `pane`, named by role). Each status background has a paired foreground token — using the background alone is incomplete.

**Card interaction (standing user preference).** Interactive cards lift gently: a few px translateY with a soft, gradually deepening shadow over ~300ms ease-out, never snapping. "Breathing" feel: generous padding, calm borders, gradual depth. Reserve it for cards and primary surfaces — not dense lists, not every clickable element.

## 9. Implementation and review

Before implementing: identify user, task, and existing visual language; inspect actual tokens and shared components; establish layout before visual effects.

Extracting a project's design language, trust evidence in this order: design documentation → theme/tokens/CSS variables → shared components → representative rendered consumers → local implementations. Only sources connected to the actual render path count. Repeated values don't imply intent; uncertain observations are written as roles/patterns, never invented token names.

From reference images: if asked to analyze, expose only the dimensions that materially affect implementation; if asked to build, extract the language internally and implement directly — no intermediate JSON prompt. Screenshot colors are approximate values; exact tokens only from source or computed styles.

Before calling it done, verify: clear hierarchy at first glance; coherent direction rather than a collection of effects; all interaction states complete; works at real viewport sizes with realistic content; contrast/keyboard/focus appropriate; every font size and spacing value from the project scale (or a justified optical correction); matches conventions and requested scope; motion purposeful, responsive, and reducible.

When you introduce an enforceable constraint (a scale, an elevation order, a usage ban), attach a check to it — lint rule, CI gate, or review item — or state explicitly that it has none.

## 10. Common AI failures and post-build QA

Avoid defaulting to: hero + three identical cards + CTA; generic purple/blue gradients; uppercase eyebrow labels; uniformly rounded and shadowed surfaces; decorative card-edge accent lines; arbitrary type sizes and one-off spacing; glassmorphism without function; over-animated tool interfaces; unnecessary confirmation dialogs; emoji as an icon system. The problem is never one element — it is a template without a reason.

When the user asks for 质检/audit/polish (or before release), run this pass and output a findings report. Review only — check explicit rules, not subjective taste; do not fix unless asked.

Fast static scan on changed frontend files:

```bash
grep -nE "Inter|Roboto|Geist|Space Grotesk" <files>   # AI-signature fonts
grep -nE "purple|violet" <files>                       # AI-signature palette
grep -nE "font-size:\s*1?[01]px" <files>               # below 12px
grep -nE "bounce|elastic" <files>                      # bounce easing
grep -nE "transition:[^;]*(width|height|padding|margin)" <files>  # layout-property animation
grep -n "background-clip:\s*text" <files>              # gradient text
grep -nE "transition:\s*all" <files>                   # transition: all
grep -nE "transform:\s*scale\(0\)" <files>             # scale(0) entry
grep -n "transform-origin:\s*center" <files>           # popover anchored to center (modals exempt)
```

Hard numeric floors beyond the section rules: body ≥ 14px; functional text ≥ 11px; adjacent font-size steps ≥ 1.25×; body line-height ≥ 1.3; container padding ≥ 8px; prose ≤ 75ch; UI animation ≤ 300ms; no gray text on colored backgrounds (darken the background instead); headings don't skip levels; interactive elements are real `<button>`/`<a>`; tables have `<thead>`/`<tbody>`; popups don't overflow or occlude.

Report format: header with file / date / scope, a passed-count summary, then per-issue `[P1]` entries with location (`file:line`), symptom, and suggested fix. Distinguish confirmed violations (code/render evidence) from potential risks and subjective suggestions — do not invent issues to fill the report.
