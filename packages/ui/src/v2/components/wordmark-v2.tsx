import { type ComponentProps } from "solid-js"

export function WordmarkV2(props: Pick<ComponentProps<"span">, "class">) {
  return (
    <span
      style={{
        "font-family": "'Space Grotesk', sans-serif",
        "font-weight": 500,
        "letter-spacing": "0.35em",
        "text-transform": "uppercase",
        "display": "inline-block",
      }}
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <span style={{ color: "#e84057" }}>RED</span>
      <span style={{ color: "currentColor" }}>CODE</span>
    </span>
  )
}
