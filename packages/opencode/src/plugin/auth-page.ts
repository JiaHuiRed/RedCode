// 261106 Red codex.ts / xai.ts 各自内嵌了一份逐字相同的 OAuth 回调页 HTML（success + error
// 两张，字节级 diff 确认仅 <title> 一词之差；error 页另有一处注入方式差异），抽到这里共享。
// error 页的 <div class="error"> 内容两处转义策略不同（codex 原样注入、xai 经 escapeHtml），
// 为保持各自原行为不动，errorHtml 由调用方传入最终要注入的 HTML 片段，本模块不做转义。

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

export function renderAuthErrorPage(options: { title: string; errorHtml: string }): string {
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
      <div class="error">${options.errorHtml}</div>
    </div>
  </body>
</html>`
}
