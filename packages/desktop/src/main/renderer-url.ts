export const rendererProtocol = "oc"
export const rendererHost = "renderer"

export function rendererPage(html: string, devUrl = process.env.ELECTRON_RENDERER_URL) {
  return devUrl ? new URL(html, devUrl).toString() : `${rendererProtocol}://${rendererHost}/${html}`
}

export function isTrustedRendererUrl(value?: string, html = false, devUrl = process.env.ELECTRON_RENDERER_URL) {
  if (!value || !URL.canParse(value)) return false
  const url = new URL(value)
  if (html && !url.pathname.endsWith(".html")) return false
  if (url.protocol === `${rendererProtocol}:` && url.host === rendererHost) return true
  if (!devUrl || !URL.canParse(devUrl)) return false
  return url.origin === new URL(devUrl).origin
}
