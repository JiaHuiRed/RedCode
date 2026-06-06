import type { ColorScheme } from "@redcode-ai/ui/theme/context"

export const colorSchemeOrder: ColorScheme[] = ["system", "light", "dark", "cream", "green", "deepblue"]

export const colorSchemeKey: Record<ColorScheme, string> = {
  system: "theme.scheme.system",
  light: "theme.scheme.light",
  dark: "theme.scheme.dark",
  cream: "theme.scheme.cream",
  green: "theme.scheme.green",
  deepblue: "theme.scheme.deepblue",
}
