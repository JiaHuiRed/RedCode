export function htmlPreviewDocument(source: string) {
  const escaped = source.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
  return `<!doctype html><meta charset="utf-8"><title>HTML preview</title><iframe sandbox="allow-scripts" referrerpolicy="no-referrer" style="border:0;position:fixed;inset:0;width:100%;height:100%" srcdoc="${escaped}"></iframe>`
}
