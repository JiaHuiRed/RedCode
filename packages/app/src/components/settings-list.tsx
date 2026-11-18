import { createUniqueId, type Component, type JSX } from "solid-js"
import { FormField } from "@redcode-ai/ui/form-field"

export const SettingsList: Component<{ children: JSX.Element }> = (props) => {
  return <div class="settings-list">{props.children}</div>
}

interface SettingsRowProps {
  title: string | JSX.Element
  description: string | JSX.Element
  children: JSX.Element
}

// 260829 Red 从 settings-general.tsx 移到这里：智能体设置面板要用同一行布局，
// 行结构（标题 + 说明 + 右侧控件）不该被一个面板私有。
export const SettingsRow: Component<SettingsRowProps> = (props) => {
  const id = createUniqueId()
  return (
    <FormField label={`${id}-label`} description={`${id}-description`}>
      <div class="settings-row">
        <div class="settings-row-copy">
          <span id={`${id}-label`} class="settings-row-title">
            {props.title}
          </span>
          <span id={`${id}-description`} class="settings-row-description">
            {props.description}
          </span>
        </div>
        <div class="settings-row-control">{props.children}</div>
      </div>
    </FormField>
  )
}
