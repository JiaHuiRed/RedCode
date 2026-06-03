import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { z } from "zod";

const WS_PORT = 9001;
let ws = null;
let msgId = 0;
const pending = new Map();

// WebSocket server for Chrome extension
const wss = new WebSocketServer({ port: WS_PORT });
console.error(`[BrowserMCP] WebSocket server listening on port ${WS_PORT}`);

wss.on("connection", (socket) => {
  console.error("[BrowserMCP] Chrome extension connected");
  ws = socket;
  socket.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve(msg.result);
      }
    } catch {}
  });
  socket.on("close", () => { if (ws === socket) ws = null; });
});

function sendToBrowser(type, payload = {}) {
  return new Promise((resolve, reject) => {
    console.error(`[BrowserMCP] sendToBrowser: ws=${!!ws} readyState=${ws?.readyState}`);
    if (!ws || ws.readyState !== 1) {
      reject(new Error("No browser connected. Click the Browser MCP extension icon and Connect."));
      return;
    }
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, type, payload }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("Timeout")); } }, 30000);
  });
}

// MCP Server
const server = new McpServer({ name: "browsermcp", version: "1.0.0" });

server.tool("browser_navigate", "Navigate to a URL", { url: z.string() }, async ({ url }) => {
  await sendToBrowser("browser_navigate", { url });
  return { content: [{ type: "text", text: `Navigated to ${url}` }] };
});

server.tool("browser_go_back", "Go back in browser history", {}, async () => {
  await sendToBrowser("browser_go_back");
  return { content: [{ type: "text", text: "Navigated back" }] };
});

server.tool("browser_go_forward", "Go forward in browser history", {}, async () => {
  await sendToBrowser("browser_go_forward");
  return { content: [{ type: "text", text: "Navigated forward" }] };
});

server.tool("browser_snapshot", "Get accessibility tree of current page", {}, async () => {
  const url = await sendToBrowser("getUrl");
  const title = await sendToBrowser("getTitle");
  const snapshot = await sendToBrowser("browser_snapshot");
  return { content: [{ type: "text", text: `URL: ${url}\nTitle: ${title}\n\n${snapshot}` }] };
});

server.tool("browser_click", "Click an element by ref or text", { element: z.string() }, async ({ element }) => {
  await sendToBrowser("browser_click", { element });
  return { content: [{ type: "text", text: `Clicked "${element}"` }] };
});

server.tool("browser_type", "Type text into an input", { element: z.string(), text: z.string() }, async ({ element, text }) => {
  await sendToBrowser("browser_type", { element, text });
  return { content: [{ type: "text", text: `Typed "${text}" into "${element}"` }] };
});

server.tool("browser_hover", "Hover over an element", { element: z.string() }, async ({ element }) => {
  await sendToBrowser("browser_hover", { element });
  return { content: [{ type: "text", text: `Hovered over "${element}"` }] };
});

server.tool("browser_select_option", "Select option in dropdown", { element: z.string(), value: z.string() }, async ({ element, value }) => {
  await sendToBrowser("browser_select_option", { element, value });
  return { content: [{ type: "text", text: `Selected "${value}" in "${element}"` }] };
});

server.tool("browser_press_key", "Press a keyboard key", { key: z.string() }, async ({ key }) => {
  await sendToBrowser("browser_press_key", { key });
  return { content: [{ type: "text", text: `Pressed ${key}` }] };
});

server.tool("browser_wait", "Wait for N seconds", { time: z.number() }, async ({ time }) => {
  await new Promise(r => setTimeout(r, time * 1000));
  return { content: [{ type: "text", text: `Waited ${time}s` }] };
});

server.tool("browser_screenshot", "Take a screenshot of current page", {}, async () => {
  const b64 = await sendToBrowser("browser_screenshot");
  return { content: [{ type: "image", data: b64, mimeType: "image/png" }] };
});

server.tool("browser_get_console_logs", "Get browser console logs", {}, async () => {
  const logs = await sendToBrowser("browser_get_console_logs");
  const text = Array.isArray(logs) ? logs.map(l => JSON.stringify(l)).join("\n") : String(logs);
  return { content: [{ type: "text", text }] };
});

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[BrowserMCP] MCP server ready");
