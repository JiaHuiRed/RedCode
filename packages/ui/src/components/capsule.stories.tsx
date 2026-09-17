// @ts-nocheck
import { IconButton } from "./icon-button"
import { Switch } from "./switch"
import * as mod from "./capsule"

const docs = `### Overview
分组卡：一个分组一张卡。浮层里是独立卡片（\`attach="floating"\`），侧栏/面板里是浅表面分组（\`attach="inline"\`）。

### API
- \`Capsule\`: \`attach\` | \`title\` | \`icon\` | \`action\`
- \`CapsuleRow\`: \`icon\` | \`status\` | \`label\` | \`description\` | \`trailing\` | \`chevron\` | \`selected\` | \`disabled\`

### Variants and states
- \`attach\`: floating / inline
- row: default / interactive (hover, focus-visible, active) / selected / disabled
- \`status\` tone: success / warning / critical / idle

### Behavior
- \`title\`/\`icon\`/\`action\` 都没有时不渲染标题行。

### Accessibility
- \`CapsuleRow\` 只在有 \`onClick\` 且未 \`disabled\` 时渲染为 \`<button type="button">\`，其余为 \`div\`。

### Theming/tokens
- Uses \`data-component="capsule"\` / \`data-component="capsule-row"\`；表面走 surface/radius/shadow token。
`

export default {
  title: "UI/Capsule",
  id: "components-capsule",
  component: mod.Capsule,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component: docs,
      },
    },
  },
}

const Frame = (props) => (
  <div style={{ padding: "24px", background: "var(--background-weak)", "min-height": "100vh" }}>{props.children}</div>
)

export const Floating = {
  render: () => (
    <Frame>
      <mod.Capsule
        attach="floating"
        class="w-[360px]"
        title="环境信息"
        action={<IconButton icon="plus-small" variant="ghost" />}
      >
        <mod.CapsuleRow icon="branch" label="变更" trailing={<span>+8804 -126</span>} />
        <mod.CapsuleRow icon="server" label="本地" chevron />
        <mod.CapsuleRow icon="branch" label="master" selected chevron />
        <mod.CapsuleRow icon="arrow-up" label="提交或推送" onClick={() => {}} />
      </mod.Capsule>
    </Frame>
  ),
}

export const Inline = {
  render: () => (
    <Frame>
      <div class="w-[320px]">
        <mod.Capsule attach="inline" title="服务器">
          <mod.CapsuleRow
            status="success"
            label="localhost:4097"
            description="v0.11.7"
            trailing={<span>默认</span>}
            onClick={() => {}}
          />
          <mod.CapsuleRow status="critical" label="remote.example" description="连接失败" disabled />
        </mod.Capsule>
      </div>
    </Frame>
  ),
}

export const Rows = {
  render: () => (
    <Frame>
      <div class="w-[320px]">
        <mod.Capsule attach="inline">
          <mod.CapsuleRow label="只有标签" />
          <mod.CapsuleRow icon="mcp" label="带图标" />
          <mod.CapsuleRow status="success" label="已连接" description="状态点为成功色" />
          <mod.CapsuleRow status="warning" label="需要授权" description="状态点为警告色" />
          <mod.CapsuleRow status="critical" label="已失败" description="状态点为错误色" />
          <mod.CapsuleRow status="idle" label="已禁用" description="状态点为中性色" />
          <mod.CapsuleRow label="带开关" trailing={<Switch checked onChange={() => {}} />} />
          <mod.CapsuleRow label="选中态" selected />
          <mod.CapsuleRow label="禁用态" disabled />
          <mod.CapsuleRow label="可点击" chevron onClick={() => {}} />
        </mod.Capsule>
      </div>
    </Frame>
  ),
}
