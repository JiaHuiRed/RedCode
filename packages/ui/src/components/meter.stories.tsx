// @ts-nocheck
import * as mod from "./meter"
import { create } from "../storybook/scaffold"

const docs = `### Overview
Horizontal usage/progress bar with a single-fill mode and a multi-segment mode.

### API
- \`value\`: percent 0-100 (clamped), single-fill mode; ignored when \`segments\` is set.
- \`segments\`: \`{ value, color }[]\` multi-segment mode.
- \`color\`: fill color (single mode). \`track\`: track background, defaults to \`--surface-weak\`.
- \`size\`: \`thin\` (4px) or \`normal\` (8px). \`label\`: accessible name (single mode).

### Variants and states
- Single fill with tier colors; multi-segment stacked bars.

### Behavior
- Widths are clamped internally; container clips overflow.

### Accessibility
- Single mode renders \`role="progressbar"\` with aria values.
- Segment mode is \`aria-hidden\` — the adjacent legend carries the information.

### Theming/tokens
- Uses \`data-component="meter"\` for styling hooks.

`

const story = create({ title: "UI/Meter", mod })

export default {
  title: "UI/Meter",
  id: "components-meter",
  component: story.meta.component,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component: docs,
      },
    },
  },
}

export const Basic = story.Basic

export const Variants = {
  render: () => (
    <div style={{ display: "flex", "flex-direction": "column", gap: "12px", width: "260px" }}>
      <mod.Meter value={42} color="var(--icon-base)" label="42 percent" />
      <mod.Meter value={88} color="var(--status-warning, orange)" size="thin" label="88 percent thin" />
      <mod.Meter
        segments={[
          { value: 30, color: "var(--icon-base)" },
          { value: 20, color: "var(--status-warning, orange)" },
          { value: 10, color: "var(--status-critical, red)" },
        ]}
      />
    </div>
  ),
}
