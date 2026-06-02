import type { ColorScheme } from "@redcode-ai/ui/theme/context"

export const colorSchemeOrder: ColorScheme[] = ["system", "light", "dark"]

export const colorSchemeKey: Record<ColorScheme, "theme.scheme.system" | "theme.scheme.light" | "theme.scheme.dark"> = {
  system: "theme.scheme.system",
  light: "theme.scheme.light",
  dark: "theme.scheme.dark",
}
