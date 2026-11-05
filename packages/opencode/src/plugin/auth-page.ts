// 261106 Red codex.ts / xai.ts 各自内嵌了一份逐字相同的 OAuth 回调页 HTML（success + error
// 两张，字节级 diff 确认仅 <title> 一词之差；error 页另有一处注入方式差异），抽到这里共享。
// 261106 Red error 页原本由调用方自行决定转义（codex 原样注入 → URL error_description 可注
// 入 HTML），现在统一收普通文本、本模块内部转义，调用方无法再忘记转义。

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;"
      case "<":
        return "&lt;"
      case ">":
        return "&gt;"
      case '"':
        return "&quot;"
      case "'":
        return "&#39;"
      default:
        return char
    }
  })
}

export function renderAuthSuccessPage(options: { title: string }): string {
  return `<!doctype html>
<html>
  <head>
    <title>${options.title}</title>
    <style>
      body {
        font-family:
          system-ui,
          -apple-system,
          sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        background: #131010;
        color: #f1ecec;
      }
      .container {
        text-align: center;
        padding: 2rem;
      }
      h1 {
        color: #f1ecec;
        margin-bottom: 1rem;
      }
      p {
        color: #b7b1b1;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Authorization Successful</h1>
      <p>You can close this window and return to RedCode.</p>
    </div>
    <script>
      setTimeout(() => window.close(), 2000)
    </script>
  </body>
</html>`
}

export function renderAuthErrorPage(options: { title: string; error: string }): string {
  return `<!doctype html>
<html>
  <head>
    <title>${options.title}</title>
    <style>
      body {
        font-family:
          system-ui,
          -apple-system,
          sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        background: #131010;
        color: #f1ecec;
      }
      .container {
        text-align: center;
        padding: 2rem;
      }
      h1 {
        color: #fc533a;
        margin-bottom: 1rem;
      }
      p {
        color: #b7b1b1;
      }
      .error {
        color: #ff917b;
        font-family: monospace;
        margin-top: 1rem;
        padding: 1rem;
        background: #3c140d;
        border-radius: 0.5rem;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Authorization Failed</h1>
      <p>An error occurred during authorization.</p>
      <div class="error">${escapeHtml(options.error)}</div>
    </div>
  </body>
</html>`
}
