const WS_PORT = 9001
let ws = null
let connected = false

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return

  try {
    ws = new WebSocket(`ws://localhost:${WS_PORT}`)
  } catch (err) {
    console.error("[BrowserMCP] WebSocket create error:", err)
    scheduleReconnect()
    return
  }

  ws.onopen = () => {
    connected = true
    chrome.action.setBadgeText({ text: "ON" })
    chrome.action.setBadgeBackgroundColor({ color: "#28a745" })
    console.log("[BrowserMCP] Connected to server")
    scheduleReconnect()
  }

  ws.onclose = () => {
    connected = false
    chrome.action.setBadgeText({ text: "" })
    ws = null
    scheduleReconnect()
  }

  ws.onerror = (err) => {
    console.error("[BrowserMCP] WebSocket error:", err)
  }

  ws.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data)
      const result = await handleMessage(msg)
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ id: msg.id, result }))
      }
    } catch (err) {
      console.error("[BrowserMCP] handleMessage error:", err)
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ id: msg?.id, error: String(err) }))
      }
    }
  }
}

function scheduleReconnect() {
  chrome.alarms.create("mcp-reconnect", { delayInMinutes: 0.4 })
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "mcp-reconnect") {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connect()
    } else {
      scheduleReconnect()
    }
  }
})

async function handleMessage(msg) {
  const { type, payload } = msg

  switch (type) {
    case "browser_navigate":
      return await navigate(payload.url)
    case "browser_go_back":
      return await goBack()
    case "browser_go_forward":
      return await goForward()
    case "browser_snapshot":
      return await getSnapshot()
    case "browser_click":
      return await clickElement(payload.element)
    case "browser_type":
      return await typeText(payload.element, payload.text)
    case "browser_hover":
      return await hoverElement(payload.element)
    case "browser_select_option":
      return await selectOption(payload.element, payload.value)
    case "browser_press_key":
      return await pressKey(payload.key)
    case "browser_wait":
      return await wait(payload.time)
    case "browser_screenshot":
      return await screenshot()
    case "browser_get_console_logs":
      return await getConsoleLogs()
    case "getUrl":
      return await getUrl()
    case "getTitle":
      return await getTitle()
    case "getStatus":
      return connected
    default:
      throw new Error(`Unknown message type: ${type}`)
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab) throw new Error("No active tab")
  return tab
}

async function execInTab(code) {
  const tab = await getActiveTab()
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: code,
  })
  return results[0]?.result
}

async function navigate(url) {
  const tab = await getActiveTab()
  await chrome.tabs.update(tab.id, { url })
  return `Navigated to ${url}`
}

async function goBack() {
  const tab = await getActiveTab()
  await chrome.tabs.goBack(tab.id)
  return "Navigated back"
}

async function goForward() {
  const tab = await getActiveTab()
  await chrome.tabs.goForward(tab.id)
  return "Navigated forward"
}

async function getUrl() {
  return await execInTab(() => window.location.href)
}

async function getTitle() {
  return await execInTab(() => document.title)
}

async function screenshot() {
  const tab = await getActiveTab()
  const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "png" })
  return dataUrl.replace(/^data:image\/png;base64,/, "")
}

async function getSnapshot() {
  return await execInTab(() => {
    function getAriaTree(node, depth = 0) {
      if (depth > 10) return ""
      const indent = "  ".repeat(depth)
      let result = ""

      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue
        const el = child
        const role = el.getAttribute("role") || el.tagName.toLowerCase()
        const name = el.getAttribute("aria-label") || el.textContent?.trim().slice(0, 50) || ""
        const ref = el.getAttribute("data-ref") || ""

        if (name || role === "button" || role === "link" || role === "textbox") {
          result += `${indent}- ${role}${ref ? " [ref=" + ref + "]" : ""}${name ? ": " + name : ""}\n`
        }

        if (el.children.length > 0) {
          result += getAriaTree(el, depth + 1)
        }
      }
      return result
    }

    return getAriaTree(document.body)
  })
}

async function clickElement(ref) {
  return await execInTab((ref) => {
    let el = document.querySelector(`[data-ref="${ref}"]`)
    if (!el) {
      const all = document.querySelectorAll('button, a, input, [role="button"], [role="link"]')
      for (const e of all) {
        if (e.textContent?.trim().includes(ref) || e.getAttribute("aria-label")?.includes(ref)) {
          el = e
          break
        }
      }
    }
    if (!el) throw new Error(`Element not found: ${ref}`)
    el.click()
    return `Clicked ${ref}`
  }, ref)
}

async function typeText(ref, text) {
  return await execInTab(
    (ref, text) => {
      let el = document.querySelector(`[data-ref="${ref}"]`)
      if (!el) {
        const all = document.querySelectorAll('input, textarea, [contenteditable="true"], [role="textbox"]')
        for (const e of all) {
          if (e.getAttribute("aria-label")?.includes(ref) || e.placeholder?.includes(ref)) {
            el = e
            break
          }
        }
      }
      if (!el) throw new Error(`Input not found: ${ref}`)
      el.focus()
      el.value = text
      el.dispatchEvent(new Event("input", { bubbles: true }))
      return `Typed "${text}" into ${ref}`
    },
    ref,
    text,
  )
}

async function hoverElement(ref) {
  return await execInTab((ref) => {
    let el = document.querySelector(`[data-ref="${ref}"]`)
    if (!el) {
      const all = document.querySelectorAll("*")
      for (const e of all) {
        if (e.getAttribute("aria-label")?.includes(ref)) {
          el = e
          break
        }
      }
    }
    if (!el) throw new Error(`Element not found: ${ref}`)
    el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }))
    return `Hovered over ${ref}`
  }, ref)
}

async function selectOption(ref, value) {
  return await execInTab(
    (ref, value) => {
      let el = document.querySelector(`[data-ref="${ref}"]`)
      if (!el || el.tagName !== "SELECT") {
        const all = document.querySelectorAll("select")
        for (const e of all) {
          if (e.getAttribute("aria-label")?.includes(ref)) {
            el = e
            break
          }
        }
      }
      if (!el || el.tagName !== "SELECT") throw new Error(`Select not found: ${ref}`)
      el.value = value
      el.dispatchEvent(new Event("change", { bubbles: true }))
      return `Selected "${value}" in ${ref}`
    },
    ref,
    value,
  )
}

async function pressKey(key) {
  return await execInTab((key) => {
    const keyMap = {
      Enter: { key: "Enter", keyCode: 13 },
      Tab: { key: "Tab", keyCode: 9 },
      Escape: { key: "Escape", keyCode: 27 },
      Backspace: { key: "Backspace", keyCode: 8 },
      ArrowUp: { key: "ArrowUp", keyCode: 38 },
      ArrowDown: { key: "ArrowDown", keyCode: 40 },
    }
    const k = keyMap[key] || { key, keyCode: key.charCodeAt(0) }
    document.dispatchEvent(new KeyboardEvent("keydown", k))
    document.dispatchEvent(new KeyboardEvent("keyup", k))
    return `Pressed ${key}`
  }, key)
}

async function wait(time) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(`Waited for ${time} seconds`), time * 1000)
  })
}

async function getConsoleLogs() {
  return await execInTab(() => {
    return "Console logs require page refresh to capture"
  })
}

// Message listener for popup communication
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "getStatus") {
    sendResponse(connected)
  } else if (msg.action === "toggle") {
    if (connected) {
      ws?.close()
      sendResponse(false)
    } else {
      connect()
      sendResponse(true)
    }
  }
})

// Auto-connect on startup
connect()
