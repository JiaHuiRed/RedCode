let serverUrl = ""
let tokenCount = 0

function $(sel) {
  return document.querySelector(sel)
}

function showLoading(status, pct) {
  $("#load-status").textContent = status || "正在启动..."
  if (pct !== undefined) $("#load-bar").style.width = Math.min(100, Math.max(0, pct)) + "%"
}

function showMain() {
  $("#loading").classList.add("hidden")
  $("#container").classList.remove("hidden")
}

async function init() {
  try {
    showLoading("加载中...", 10)
    const data = await window.api.awaitInitialization((step) => {
      if (step.phase === "server_waiting") showLoading("正在启动服务器...", 30)
      else if (step.phase === "sqlite_waiting") showLoading("正在迁移数据库...", 60)
    })
    serverUrl = data.url
    showLoading("就绪", 100)
    setTimeout(showMain, 300)
  } catch (e) {
    showLoading("启动失败: " + e.message)
  }
}

async function sendMessage(text) {
  if (!text.trim() || !serverUrl) return
  const msgDiv = document.createElement("div")
  msgDiv.className = "msg"
  msgDiv.innerHTML = '<div class="role">你</div><div class="content">' + escapeHtml(text) + "</div>"
  $("#messages").appendChild(msgDiv)
  $("#prompt").value = ""
  document.getElementById("send").disabled = true

  const respDiv = document.createElement("div")
  respDiv.className = "msg"
  respDiv.innerHTML = '<div class="role">RedCode</div><div class="content"></div>'
  $("#messages").appendChild(respDiv)
  const contentDiv = respDiv.querySelector(".content")

  try {
    const res = await fetch(serverUrl + "/api/v2/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: text }] }),
    })
    const data = await res.json()
    contentDiv.textContent = data.message?.content || "(无响应)"
    $("#messages").scrollTop = $("#messages").scrollHeight
  } catch (e) {
    contentDiv.textContent = "错误: " + e.message
  }
  document.getElementById("send").disabled = false
}

function escapeHtml(s) {
  const d = document.createElement("div")
  d.textContent = s
  return d.innerHTML
}

$("#send").addEventListener("click", () => sendMessage($("#prompt").value))
$("#prompt").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendMessage(e.target.value)
})

init()
