const statusEl = document.getElementById("status")
const btn = document.getElementById("btn")

function updateUI(connected) {
  statusEl.textContent = connected ? "Connected" : "Disconnected"
  statusEl.className = "status " + (connected ? "connected" : "disconnected")
  btn.textContent = connected ? "Disconnect" : "Connect"
  btn.className = connected ? "disconnect" : "connect"
}

chrome.runtime.sendMessage({ action: "getStatus" }, (connected) => {
  updateUI(connected)
})

btn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "toggle" }, (connected) => {
    updateUI(connected)
  })
})
