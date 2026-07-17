import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"

const execFileAsync = promisify(execFile)
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return

  if (process.env.GITHUB_ACTIONS === "true") {
    await execFileAsync(
      "pwsh",
      ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
      { cwd: rootDir },
    )
    return
  }

  try {
    await execFileAsync("pwsh", [
      "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass",
      "-Command",
      `Set-AuthenticodeSignature -FilePath "${configuration.path}" -Certificate (Get-ChildItem Cert:\\CurrentUser\\My -CodeSigningCert)[0] -TimestampServer http://timestamp.digicert.com -HashAlgorithm SHA256 -Force`,
    ], { stdio: "pipe" })
  } catch {
    // self-signed cert signing failed, still continue
  }
}

const channel = (() => {
  const raw = process.env.REDCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const getBase = (): Configuration => ({
  artifactName: "redcode-desktop-${os}-${arch}.${ext}",
  // 260717 Red RedCode 是中文母语产品，之前没设这个，Electron 默认把全部 55 种
  // Chromium UI 语言的 .pak 都打进包（~48MB 纯浪费）。只保留用得上的。
  electronLanguages: ["zh-CN", "en-US"],
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  afterAllArtifactBuild: async (context) => {
    const fs = await import("node:fs/promises")
    const src = path.join(context.outDir, "win-unpacked")
    const dst = path.join(context.outDir, "win")
    if (src === dst) return []
    try {
      await fs.rm(dst, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
      await fs.cp(src, dst, { recursive: true })
      await fs.rm(src, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    } catch (e) {
      console.error("[afterAllArtifactBuild] win-unpacked → win rename failed:", e)
      throw e
    }
    return []
  },
  files: ["out/**/*", "resources/**/*"],
  extraResources: [
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
    {
      from: "resources/icons",
      to: "icons",
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: true,
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: true,
  },
  protocols: {
    name: "RedCode",
    schemes: ["redcode"],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    signtoolOptions: {
      sign: signWindows,
    },
    target: ["dir"],
    verifyUpdateCodeSignature: false,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig() {
  const base = getBase()

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId: "ai.redcode.desktop.dev",
        productName: "RedCode Dev",
        rpm: { packageName: "redcode-dev" },
      }
    }
    case "beta": {
      return {
        ...base,
        appId: "ai.redcode.desktop.beta",
        productName: "RedCode Beta",
        protocols: { name: "RedCode Beta", schemes: ["redcode"] },
        publish: { provider: "github", owner: "JiaHuiRed", repo: "RedCode", channel: "latest" },
        rpm: { packageName: "redcode-beta" },
      }
    }
    case "prod": {
      return {
        ...base,
        appId: "ai.redcode.desktop",
        productName: "RedCode",
        protocols: { name: "RedCode", schemes: ["redcode"] },
        publish: { provider: "github", owner: "JiaHuiRed", repo: "RedCode", channel: "latest" },
        rpm: { packageName: "redcode" },
      }
    }
  }
}

export default getConfig()
