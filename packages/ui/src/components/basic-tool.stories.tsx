// @ts-nocheck
import { createSignal } from "solid-js"
import * as mod from "./basic-tool"
import { create } from "../storybook/scaffold"

const docs = `### Overview
Expandable tool panel with a structured trigger and optional details.

Use structured triggers for consistent layout; custom triggers allowed.

### API
- Required: \`icon\` and \`trigger\` (structured or custom JSX).
- Optional: \`status\`, \`defaultOpen\`, \`forceOpen\`, \`defer\`, \`locked\`.

### Variants and states
- Pending/running status animates the title via TextShimmer.

### Behavior
- Uses Collapsible; can defer content rendering until open.
- Locked state prevents closing.

### Accessibility
- TODO: confirm trigger semantics and aria labeling.

### Theming/tokens
- Uses \`data-component="tool-trigger"\` and related slots.

`

const story = create({
  title: "UI/Basic Tool",
  mod,
  args: {
    icon: "mcp",
    defaultOpen: true,
    trigger: {
      title: "Basic Tool",
      subtitle: "Example subtitle",
      args: ["--flag", "value"],
    },
    children: "Details content",
  },
})

export default {
  title: "UI/Basic Tool",
  id: "components-basic-tool",
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

// 260831 cc subtitlePath：给文件类工具行在文件名前挂文件类型图标（复用文件树那套 sprite）。
// 这里各挑一个走不同命中路径的例子：py 命中扩展名表、README.md 命中文件名表、
// vite.config.ts 命中文件名表（而不是退化成 ts）、无后缀文件退化到默认 Document。
export const WithFileIcon = {
  args: {
    icon: "glasses",
    defaultOpen: false,
    trigger: {
      title: "读取",
      subtitle: "window.py",
      subtitlePath: "player/viewer/window.py",
    },
  },
}

export const FileIconVariants = {
  args: {
    icon: "code-lines",
    defaultOpen: false,
    trigger: {
      title: "编辑",
      subtitle: "vite.config.ts",
      subtitlePath: "packages/app/vite.config.ts",
    },
  },
}

export const Pending = {
  args: {
    status: "pending",
    trigger: {
      title: "Running tool",
      subtitle: "Working...",
    },
    children: "Progress details",
  },
}

export const Locked = {
  args: {
    locked: true,
    trigger: {
      title: "Locked tool",
      subtitle: "Cannot close",
    },
    children: "Locked details",
  },
}

export const Deferred = {
  args: {
    defer: true,
    defaultOpen: false,
    trigger: {
      title: "Deferred tool",
      subtitle: "Content mounts on open",
    },
    children: "Deferred content",
  },
}

export const ForceOpen = {
  args: {
    forceOpen: true,
    trigger: {
      title: "Forced open",
      subtitle: "Cannot close",
    },
    children: "Forced content",
  },
}

export const HideDetails = {
  args: {
    hideDetails: true,
    trigger: {
      title: "Summary only",
      subtitle: "Details hidden",
    },
    children: "Hidden content",
  },
}

export const SubtitleAction = {
  render: () => {
    const [message, setMessage] = createSignal("Subtitle not clicked")
    return (
      <div style={{ display: "grid", gap: "8px" }}>
        <div style={{ "font-size": "12px", color: "var(--text-weak)" }}>{message()}</div>
        <mod.BasicTool
          icon="mcp"
          trigger={{ title: "Clickable subtitle", subtitle: "Click me" }}
          onSubtitleClick={() => setMessage("Subtitle clicked")}
        >
          Subtitle action details
        </mod.BasicTool>
      </div>
    )
  },
}
