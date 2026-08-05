---
name: frontend-design
description: Create distinctive, production-grade frontend interfaces with high design quality. Use this skill when the user asks to build web components, pages, or applications. Generates creative, polished code that avoids generic AI aesthetics. Default aesthetic direction is macOS/Apple-inspired unless the user specifies otherwise.
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

## Anti-Patterns (NEVER Do These)

- Overused font families (Inter, Roboto, Arial as primary display font)
- Purple gradients on white backgrounds
- Predictable card grid layouts with identical spacing everywhere
- Cookie-cutter design that lacks context-specific character
- Converging on the same "safe" choices (Space Grotesk, etc.) across different projects

Match implementation complexity to the aesthetic vision. Maximalist designs need elaborate code. Minimalist designs need restraint, precision, and careful attention to spacing, typography, and subtle details.
