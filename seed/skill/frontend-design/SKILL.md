---
name: frontend-design
description: 构建高质量前端界面、组件和页面，或根据参考图实现视觉风格。已有界面质量审查使用 frontend-qa。
---

# Frontend Design

Build production-grade interfaces with a clear visual identity.
Avoid generic AI-template aesthetics, but do not pursue novelty at the expense of usability.
When the user asks to build, implement working code rather than stopping at design analysis.

## Context priority

When visual directions conflict, prefer:

1. explicit user requirements
2. existing project design system
3. supplied reference images
4. stable user taste
5. default taste

When working in an existing product, preserve its visual language unless redesign is explicitly requested.
Improving one component is not permission to redesign the surrounding product.

## Visual priority

Fix visual problems in this order:

1. information hierarchy
2. layout and alignment
3. spacing and density
4. typography
5. color and contrast
6. shape and depth
7. motion and decoration

Do not decorate around a weak layout.

## Choose a coherent direction

Start with the product's purpose, audience, constraints, and content density.
Choose a direction that can be explained in a sentence, then make typography, spacing,
color, shape, and interaction reinforce it. Distinctive does not mean visually loud.

## Default taste

When no style is specified, prefer a restrained premium product aesthetic:

- clear hierarchy and purposeful spacing
- strong typography and deliberate contrast
- restrained color with selective accents
- soft depth and coherent shape language
- smooth, low-noise interaction feedback

For RedCode itself, preserve the project's existing Apple/macOS-inspired direction and source-backed design decisions.

## Visual quality

- Use typography, spacing, alignment, and proportion as primary design tools.
- Prefer a few strong visual decisions over many weak effects.
- Add color, depth, texture, and motion only when they reinforce the chosen direction.
- Repetition should create rhythm, not monotony.
- Density should match the task: tools may be dense; presentation pages may breathe.

## Visual attention budget

Every screen has limited visual attention. Use emphasis selectively:

- if everything has shadow, nothing has depth
- if everything moves, motion loses meaning
- if every section uses an accent, hierarchy collapses
- if every surface is rounded, shape loses meaning

## Real content

Design against realistic content density, not only short demo copy. Where relevant, account for:
long labels, empty states, loading, errors, dense lists or tables, realistic item counts,
overflow, truncation, and narrow target viewports.

## Reference-image mode

If the user asks for analysis or a reusable specification, expose only the design dimensions
that materially affect implementation. Structured output is optional unless requested or
useful for reuse.

If the user asks to build from a reference, extract the visual language internally and
implement directly; do not force an intermediate JSON or coding prompt.

Treat colors inferred from screenshots as approximate visual values. Present exact tokens
only when they come from source code or computed styles.

## Existing products and design systems

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

## Implementation

Follow the repository's existing component and styling conventions.
Use tokens for repeated or semantically meaningful values; one-off optical corrections may remain local.
Complete relevant interaction states: hover, focus, active, disabled, loading.
Prefer performant motion and use the property that best fits the interaction; avoid layout-triggering
animation when it causes jank.
Design for the actual target viewport range instead of adding artificial breakpoints.

## Common failure modes

Avoid defaulting to:

- generic purple or blue “tech” gradients
- glassmorphism without spatial or functional purpose
- identical card grids when hierarchy calls for variation
- excessive nested surfaces
- fashionable fonts without typographic context
- decorative motion that competes with interaction
- generic hero + cards + CTA patterns across unrelated products

The problem is not any individual element; it is using a template without a reason.

## Completion check

Before calling the UI finished:

- visual hierarchy is clear at first glance
- the visual direction is coherent rather than a collection of effects
- relevant interaction states are complete
- layout works at the actual target viewport sizes
- keyboard and contrast behavior are appropriate for interactive UI
- implementation matches project conventions and requested scope

## User's preferred visual family: spacious, atmospheric product UI

When a reference has this family of qualities, treat it as a soft preference rather than a
fixed template:

- Favor a spacious, composed canvas with a clear focal workspace and deliberate variation in
  layout. Do not force every product into a dashboard or card grid.
- Use a calm, atmospheric palette with layered color fields or subtle geometric depth when it
  supports the product. Derive the hue and contrast from the context instead of defaulting to
  one prescribed color.
- Prefer surfaces with restrained depth, coherent shape language, and purposeful translucency.
  Avoid turning every layer into glass or every element into a rounded container.
- Keep hierarchy strong and density calm: clear titles, quiet metadata, generous breathing room,
  and selective color accents for meaningful icons or actions.
- Extract the underlying qualities—spatial composition, controlled contrast, quiet utility, and
  polish—rather than copying a reference's labels, icons, geometry, or exact tokens.

### Cards: gentle lift with a breathing feel

For interactive cards (explicitly stated by the user, 260921): hovering or clicking a card
should make it float up slowly and softly—translateY of a few pixels with a soft shadow,
transitioning over ~0.3s with an ease-out curve, never snapping. The overall feel is "breathing":
generous padding, calm borders, depth expressed through a gradual shadow rather than instant
state flips. Reserve this treatment for cards and primary interactive surfaces, not every element.

## Typography scale is a hard constraint

When a project defines a font scale, that scale is a closed set. Sizes outside it are
design-system defects, not style preferences.

- There is exactly one scale entry point. Scaling the UI means changing that variable —
  never the root font size, never a per-component override.
- Every size comes from the scale. An off-scale value is an undesigned tier: it does not
  participate in the rhythm, and it is the first thing that makes two screens of one
  product look like two products.
- The smallest tier carries a usage ban. Name the single role it may serve. Without a
  ban the smallest tier migrates into everything, which is how a hierarchy collapses.
- Code, diff, and terminal rendering may keep their own numeric sizes; the controls,
  labels, and metadata around them still use the scale.

RedCode's scale is `--font-size-small/base/large/x-large` in
`packages/ui/src/styles/theme.css`, exposed to Tailwind as `--text-sm/base/lg/xl` in
`packages/ui/src/styles/tailwind/index.css`. Use those, not `text-[13px]`. Two things
to know before touching type here: `--font-size-x-small` is referenced in six places
and defined in none, so those six rules silently fall back to inherited size — if you
are near one, either define the tier or drop the reference. And roughly a hundred
`font-size: Npx` literals in `packages/ui/src/components` and `v2/components`
already sit outside the scale; matching the neighbours is not a reason to add another.

## Semantic tokens carry usage bans

A token is not just a value; it is a value plus the roles it is allowed to serve. Two
tokens with the same color but different roles are not interchangeable.

- The elevation chain is ordered: background → inset → raised → float → overlay. Choose
  the tier for the surface's role. Do not mix tiers inside one component to fake
  separation, and do not use a structural surface as a generic card fill.
- Status color is never the only channel. Each status carries a paired foreground token
  so a colorblind user is not required to read hue. A status distinguishable only by its
  background is incomplete.
- Radius follows the nearest actual rounded container, not DOM depth. Outer surfaces and
  what they contain are concentric: outer larger, inner smaller.
- Repeated values do not imply intent. Confirm the token exists in source before using
  it, and write an uncertain observation as a role, not an invented token name.

RedCode's tokens live in `packages/ui/src/styles/theme.css` (surfaces, text, border,
icon, syntax, markdown). The radius scale has a single definition in
`packages/ui/src/styles/tailwind/index.css` — xs/sm/md/lg/xl plus `pane`, which is
named for its role rather than its size.

## Enforcement

A rule nothing checks is documentation, and it erodes. When you add one of these
constraints, either give it a check or write down that it has none — a scale with no
gate behind it is a preference, and the first off-scale value is the one that proves it.
