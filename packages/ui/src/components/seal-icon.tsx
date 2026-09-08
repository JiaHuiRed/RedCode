import type { Component, JSX } from "solid-js"
import { createUniqueId, splitProps } from "solid-js"

export type SealIconProps = JSX.GSVGAttributes<SVGSVGElement> & {
  class?: string
  classList?: Record<string, boolean | undefined>
}

// 260908 Red 朱印小尺寸标（assets/brand/redcode-mark-simple.svg 的内联刻本）。
// 工具行等 16px 装饰位用它替换文件类型图标：simple 版去掉了崩口与印边留白，
// 那两处细节在 16 像素下只会让边缘发毛（见该 SVG 头注释）。
// 印身固定品牌红 #C8322B——印章不随主题换色；mask id 按实例生成，防多实例 id 冲突。
export const SealIcon: Component<SealIconProps> = (props) => {
  const [local, rest] = splitProps(props, ["class", "classList"])
  const id = `seal-icon-${createUniqueId()}`
  return (
    <svg
      data-component="seal-icon"
      viewBox="0 0 100 100"
      width="16"
      height="16"
      role="img"
      aria-label="RedCode"
      {...rest}
      classList={{ [local.class ?? ""]: !!local.class, ...local.classList }}
    >
      <mask id={id}>
        <rect width="100" height="100" fill="#fff" />
        <polyline
          points="30,31 49,50 30,69"
          fill="none"
          stroke="#000"
          stroke-width="10.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <rect x="56" y="61" width="20" height="8.5" rx="2.5" fill="#000" />
      </mask>
      <rect x="7" y="7" width="86" height="86" rx="7" fill="#C8322B" mask={`url(#${id})`} />
    </svg>
  )
}
