---
name: frontend-design
description: 构建或重整前端界面与组件，按截图/设计稿实现视觉风格；做完后的设计质检（扫描 + checklist 报告）也在本 skill。动效细节用 apple-design。
---

# Frontend Design

Build production-grade interfaces with a clear visual identity.
Avoid generic AI-template aesthetics, but do not pursue novelty at the expense of usability.
When the user asks to build, implement working code rather than stopping at design analysis.

## 1. Grounding: what wins when directions conflict

1. explicit user requirements
2. existing project design system
3. supplied reference images
4. the user's demonstrated long-term preferences
5. default taste (section 4)

When working in an existing product, preserve its visual language unless redesign is explicitly
requested. Improving one component is not permission to redesign the surrounding product.

## 2. Direction before decoration

Start with the product's purpose, audience, constraints, and content density.
Choose a direction that can be explained in one sentence, then make typography, spacing,
color, shape, and interaction reinforce it. Distinctive does not mean visually loud.

Fix visual problems in this order, and do not decorate around a weak layout:

1. information hierarchy
2. layout and alignment
3. spacing and density
4. typography
5. color and contrast
6. shape and depth
7. motion and decoration

Sections 5–10 below follow this same order.

## 3. Visual attention budget

Every screen has limited visual attention. Use emphasis selectively:

- if everything has shadow, nothing has depth
- if everything moves, motion loses meaning
- if every section uses an accent, hierarchy collapses
- if every surface is rounded, shape loses meaning

## 4. Default taste

When no style is specified, prefer a restrained premium product aesthetic:

- clear hierarchy and purposeful spacing
- strong typography and deliberate contrast
- restrained color with selective accents
- soft depth and coherent shape language
- smooth, low-noise interaction feedback

## 5. Hierarchy, layout, and composition

- Establish one focal point per screen or section; support it, don't compete with it.
- Align to a grid. Every edge that almost aligns but doesn't reads as a mistake, not as freedom.
- Vary the rhythm: full-width bands, offset columns, and mixed-density regions beat
  uniform card grids. Use identical cards only for genuinely homogeneous collections.
- Compose asymmetrically when the content allows it — balance by visual weight
  (size × contrast × isolation), not by mirroring.
- Group by proximity before adding boxes. Whitespace is the cheapest separator;
  borders and cards are the most expensive.

## 6. Spacing and density

- Build spacing from a small scale (e.g. 4/8-based: 4, 8, 12, 16, 24, 32, 48, 64).
  Compose larger gaps from scale steps rather than inventing one-off values.
- Inner padding relates to outer gaps: an element's inset is usually tighter than the
  space separating it from siblings.
- Density should match the task: tools may be dense; presentation pages may breathe.
- Repetition should create rhythm, not monotony — vary scale and whitespace across sections.

## 7. Typography

- Type is the primary design tool. Get hierarchy from size, weight, and color contrast —
  in that order — before reaching for decoration.
- Line height follows role: display/headings ~1.05–1.25, UI text ~1.3–1.45, body text
  ~1.5–1.7. Larger sizes need tighter leading, never looser.
- Keep measure readable: roughly 45–75 characters per line for prose.
- Use few sizes with clear roles. Letter-spacing: slightly negative on large display type,
  slightly positive on small uppercase labels; leave body text at zero.
- Use tabular numerals for data, prices, and anything that animates or aligns in columns.
- One well-used family with weight contrast usually beats two paired families.
- When a project defines a font scale, that scale is a closed set. Sizes outside it are
  design-system defects, not style preferences. See section 15 for RedCode's scale.

## 8. Color and contrast

- Restraint first: a neutral field plus one accent color, used only where attention
  should go. Derive the hue from the product's context, not from a default palette.
- Neutrals work better with a slight hue (warm or cool) than as pure grays.
- Large color fields carry atmosphere; small saturated accents carry meaning.
  Don't invert the two.
- Text contrast must hold up: body text ≥ 4.5:1, large text ≥ 3:1 against its surface.
- Status color is never the only channel. Pair each status with a foreground token,
  icon, or label so a colorblind user is not required to read hue.
- Dark mode is a re-tuning, not an inversion: avoid pure black backgrounds and pure
  white text, desaturate accents slightly, and express elevation with lightness
  rather than heavier shadows.

## 9. Shape and depth

- Radius follows the nearest actual rounded container, not DOM depth. Outer surfaces
  and what they contain are concentric: outer larger, inner smaller.
- Depth has an order. When a project defines an elevation chain (e.g. background →
  inset → raised → float → overlay), choose the tier for the surface's role; do not
  mix tiers inside one component to fake separation.
- Shadows should be soft, low-opacity, and layered (a tight contact shadow plus a wide
  ambient one). A hard, dark, uniform shadow is the mark of a default.
- Prefer borders or tonal separation for structure; reserve shadows for actual elevation
  (floating, overlay, hover lift).
- Translucency and blur need a spatial or functional reason (layering over content,
  keeping context visible). Decorative glass is noise.

## 10. Motion and interaction

- Motion communicates cause and effect: it should answer "what changed and where did it
  come from," not decorate.
- Animate transform and opacity; avoid layout-triggering properties when they cause jank.
- Durations: micro-feedback 100–200ms, transitions 200–400ms. Nothing in UI chrome should
  feel slow; nothing stateful should snap.
- Ease-out for things entering, ease-in for things leaving, ease-in-out for things moving.
- Complete every relevant interaction state: hover, focus-visible, active, disabled,
  loading, and empty. Respect prefers-reduced-motion.
- Interactive targets need adequate size (~40px+ on touch) and visible focus indication
  that survives the design, not just the browser default.

## 11. Real content and real viewports

Design against realistic content density, not only short demo copy. Where relevant, account for:
long labels, empty states, loading, errors, dense lists or tables, realistic item counts,
overflow, truncation, and narrow target viewports.

Design for the actual target viewport range instead of adding artificial breakpoints.
Prefer fluid techniques (clamp(), container-relative sizing, wrapping grids) over a
ladder of device guesses.

## 12. Working in existing products

When extracting a project's design language, trust evidence in this order:

1. existing design documentation
2. theme, tokens, CSS variables, and global styles
3. shared components and variants
4. representative rendered consumers
5. local implementations

Only trust sources connected to the actual render path. Repeated values do not automatically
imply design intent, and local styling does not automatically define the design system.
Write uncertain observations as roles or patterns, not invented token names or values.

When several liked references are available, extract recurring choices rather than copying
one-off details. Repeated choices and shipped, retained decisions are stronger evidence than
a single reference.

A token is not just a value; it is a value plus the roles it is allowed to serve. Two tokens
with the same color but different roles are not interchangeable.

## 13. Reference-image mode

If the user asks for analysis or a reusable specification, expose only the design dimensions
that materially affect implementation. Structured output is optional unless requested or
useful for reuse.

If the user asks to build from a reference, extract the visual language internally and
implement directly; do not force an intermediate JSON or coding prompt.

Treat colors inferred from screenshots as approximate visual values. Present exact tokens
only when they come from source code or computed styles.

## 14. Common failure modes

Avoid defaulting to:

- generic purple or blue "tech" gradients
- glassmorphism without spatial or functional purpose
- identical card grids when hierarchy calls for variation
- hero + three cards + CTA patterns across unrelated products
- everything centered, everything the same width, everything the same weight
- excessive nested surfaces
- fashionable fonts without typographic context
- emoji or mismatched icon styles standing in for a coherent icon set
- decorative motion that competes with interaction
- off-scale font sizes and one-off spacing values

The problem is not any individual element; it is using a template without a reason.

## 15. RedCode specifics

Preserve RedCode's existing Apple/macOS-inspired direction and source-backed design decisions.

**Type scale.** The scale is `--font-size-small/base/large/x-large` in
`packages/ui/src/styles/theme.css`, exposed to Tailwind as `--text-sm/base/lg/xl` in
`packages/ui/src/styles/tailwind/index.css`. Use those, not `text-[13px]`.

- There is exactly one scale entry point. Scaling the UI means changing that variable —
  never the root font size, never a per-component override.
- Every size comes from the scale. An off-scale value is an undesigned tier: it does not
  participate in the rhythm, and it is the first thing that makes two screens of one
  product look like two products.
- The smallest tier carries a usage ban. Name the single role it may serve. Without a
  ban the smallest tier migrates into everything, which is how a hierarchy collapses.
- Code, diff, and terminal rendering may keep their own numeric sizes; the controls,
  labels, and metadata around them still use the scale.

Two things to know before touching type here: `--font-size-x-small` is referenced in six
places and defined in none, so those six rules silently fall back to inherited size — if
you are near one, either define the tier or drop the reference. And roughly a hundred
`font-size: Npx` literals in `packages/ui/src/components` and `v2/components` already sit
outside the scale; matching the neighbours is not a reason to add another.

**Tokens.** Semantic tokens live in `packages/ui/src/styles/theme.css` (surfaces, text,
border, icon, syntax, markdown). The elevation chain is ordered: background → inset →
raised → float → overlay — pick the tier by role, and don't use a structural surface as a
generic card fill. The radius scale has a single definition in
`packages/ui/src/styles/tailwind/index.css` — xs/sm/md/lg/xl plus `pane`, which is named
for its role rather than its size. Each status color carries a paired foreground token;
using the background alone is incomplete. Confirm a token exists in source before using it.

## 16. User's preferred visual family: spacious, atmospheric product UI

When a reference has this family of qualities, treat it as a soft preference rather than a
fixed template:

- Favor a spacious, composed canvas with a clear focal workspace and deliberate variation in
  layout. Do not force every product into a dashboard or card grid.
- Use a calm, atmospheric palette with layered color fields or subtle geometric depth when it
  supports the product. Derive the hue and contrast from the context instead of defaulting to
  one prescribed color.
- Prefer surfaces with restrained depth, coherent shape language, and purposeful translucency.
- Keep hierarchy strong and density calm: clear titles, quiet metadata, generous breathing room,
  and selective color accents for meaningful icons or actions.
- Extract the underlying qualities—spatial composition, controlled contrast, quiet utility, and
  polish—rather than copying a reference's labels, icons, geometry, or exact tokens.

### Cards: gentle lift with a breathing feel

Standing user preference: hovering or clicking an interactive card should make it float up
slowly and softly — translateY of a few pixels with a soft, gradually deepening shadow,
transitioning over ~0.3s with an ease-out curve, never snapping. The overall feel is
"breathing": generous padding, calm borders, depth expressed through gradual shadow rather
than instant state flips. Reserve this treatment for cards and primary interactive surfaces,
not every element.

## 17. Completion check

Before calling the UI finished, verify:

- visual hierarchy is clear at first glance — one focal point, no competing emphasis
- the visual direction is coherent rather than a collection of effects
- all relevant interaction states are complete (hover, focus-visible, active, disabled,
  loading, empty)
- layout works at the actual target viewport sizes, with realistic content
- contrast, keyboard, and focus behavior are appropriate for interactive UI
- every font size and spacing value comes from the project's scale, or is justified as a
  one-off optical correction
- implementation matches project conventions and requested scope

## 18. Enforcement

When you introduce a design constraint into a codebase (a type scale, an elevation order,
a token usage ban), attach a check to it — a lint rule, a CI gate, a code-review item — or
explicitly document that it has none. A rule nothing checks is documentation, and it erodes:
a scale with no gate behind it is a preference, and the first off-scale value is the one
that proves it.

## 19. Post-build QA review

When reviewing a finished frontend change — the user asks for 质检/audit/polish, or before a release — run this pass and output a findings report. Review only: check for violations of explicit rules, not subjective taste; do not fix code unless asked.

**Fast static scan** (grep the changed frontend files):

```bash
# AI-signature fonts and palettes
grep -nE "Inter|Roboto|Geist|Space Grotesk" <files>
grep -nE "purple|violet" <files>
# font sizes below 12px
grep -nE "font-size:\s*1?[01]px" <files>
# bounce / layout-property animations
grep -nE "bounce|elastic" <files>
grep -nE "transition:[^;]*(width|height|padding|margin)" <files>
# gradient text
grep -n "background-clip:\s*text" <files>
```

**Hard numeric floors** (beyond the section 5–10 rules above):

- body text ≥ 14px; functional text (buttons, labels, table cells) ≥ 11px
- adjacent font-size steps ≥ 1.25×; body line-height ≥ 1.3×
- container padding ≥ 8px (ideally 12–16px); prose measure ≤ 75ch
- no gray text on colored backgrounds — use a darkened version of the background color
- no zero-offset colored glow shadows (`box-shadow`/`text-shadow`)
- no bounce/elastic easing — cubic-bezier control points stay within [0,1]
- loading states carry text, not just a pulsing dot; empty states carry guidance + CTA
- headings don't skip levels (h1→h2→h3); interactive elements are real `<button>`/`<a>`, not styled `<div>`s
- tables have `<thead>`/`<tbody>`; focus styles are clearly visible; popups don't overflow or occlude content

**Report format**: header with file / date / scope, a passed-count summary, then per-issue `[P1]` entries with location (`file:line`), symptom, and suggested fix.