import path from "path"
import { Global } from "@redcode-ai/core/global"
import { Filesystem } from "@/util/filesystem"
import { onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "../../context/helper"
import { useSync } from "../../context/sync"
import { appendFile, writeFile } from "fs/promises"

function calculateFrecency(entry?: { frequency: number; lastOpen: number }): number {
  if (!entry) return 0
  const daysSince = (Date.now() - entry.lastOpen) / 86400000 // ms per day
  const weight = 1 / (1 + daysSince)
  return entry.frequency * weight
}

const MAX_FRECENCY_ENTRIES = 1000

export const { use: useFrecency, provider: FrecencyProvider } = createSimpleContext({
  name: "Frecency",
  init: () => {
    const frecencyPath = path.join(Global.Path.state, "frecency.jsonl")
    const sync = useSync()
    // 261110 Red 相对路径按所属项目目录解析：多项目切换后进程 cwd 仍是启动目录，
    // 继续用 cwd 会把 B 项目的文件记成 A 项目下的绝对路径。
    const resolveEntry = (filePath: string) =>
      sync.path.directory ? path.resolve(sync.path.directory, filePath) : filePath
    onMount(async () => {
      const text = await Filesystem.readText(frecencyPath).catch(() => "")
      const lines = text
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as { path: string; frequency: number; lastOpen: number }
          } catch {
            return null
          }
        })
        .filter((line): line is { path: string; frequency: number; lastOpen: number } => line !== null)

      const latest = lines.reduce(
        (acc, entry) => {
          acc[entry.path] = entry
          return acc
        },
        {} as Record<string, { path: string; frequency: number; lastOpen: number }>,
      )

      const sorted = Object.values(latest)
        .sort((a, b) => b.lastOpen - a.lastOpen)
        .slice(0, MAX_FRECENCY_ENTRIES)

      setStore(
        "data",
        Object.fromEntries(
          sorted.map((entry) => [entry.path, { frequency: entry.frequency, lastOpen: entry.lastOpen }]),
        ),
      )

      if (sorted.length > 0) {
        const content = sorted.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
        writeFile(frecencyPath, content).catch(() => {})
      }
    })

    const [store, setStore] = createStore({
      data: {} as Record<string, { frequency: number; lastOpen: number }>,
    })

    function updateFrecency(filePath: string) {
      const absolutePath = resolveEntry(filePath)
      const newEntry = {
        frequency: (store.data[absolutePath]?.frequency || 0) + 1,
        lastOpen: Date.now(),
      }
      setStore("data", absolutePath, newEntry)
      appendFile(frecencyPath, JSON.stringify({ path: absolutePath, ...newEntry }) + "\n").catch(() => {})

      if (Object.keys(store.data).length > MAX_FRECENCY_ENTRIES) {
        const sorted = Object.entries(store.data)
          .sort(([, a], [, b]) => b.lastOpen - a.lastOpen)
          .slice(0, MAX_FRECENCY_ENTRIES)
        setStore("data", Object.fromEntries(sorted))
        const content = sorted.map(([path, entry]) => JSON.stringify({ path, ...entry })).join("\n") + "\n"
        writeFile(frecencyPath, content).catch(() => {})
      }
    }

    return {
      getFrecency: (filePath: string) => calculateFrecency(store.data[resolveEntry(filePath)]),
      updateFrecency,
      data: () => store.data,
    }
  },
})
