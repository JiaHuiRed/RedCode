import { Global } from "@redcode-ai/core/global"
import { Filesystem } from "@/util/filesystem"
import { Flock } from "@redcode-ai/core/util/flock"
import { rename, rm } from "fs/promises"
import { createSignal, type Setter } from "solid-js"
import { createStore, unwrap } from "solid-js/store"
import { createSimpleContext } from "./helper"
import path from "path"

export const { use: useKV, provider: KVProvider } = createSimpleContext({
  name: "KV",
  init: () => {
    const [ready, setReady] = createSignal(false)
    const [store, setStore] = createStore<Record<string, any>>()
    const filePath = path.join(Global.Path.state, "kv.json")
    const lock = `tui-kv:${filePath}`
    // Queue same-process writes so rapid updates persist in order.
    let write = Promise.resolve()

    // Write to a temp file first so kv.json is only replaced once the JSON is complete, avoiding partial writes if shutdown interrupts persistence.
    function writeSnapshot(snapshot: Record<string, any>) {
      const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
      return Filesystem.writeJson(tempPath, snapshot)
        .then(() => rename(tempPath, filePath))
        .catch(async (error) => {
          await rm(tempPath, { force: true }).catch(() => undefined)
          throw error
        })
    }

    // Read under the same lock used for writes because kv.json is shared across processes.
    Flock.withLock(lock, () => Filesystem.readJson<Record<string, any>>(filePath))
      .then((x) => {
        setStore(x)
        // 260603 Red 一次性迁移：kv_version < 1 时将 scrollbar_visible 从 false 升级为 true
        const kvVersion = x["kv_version"] ?? 0
        if (kvVersion < 1) {
          if (x["scrollbar_visible"] === false) setStore("scrollbar_visible", true)
          setStore("kv_version", 1)
        }
      })
      .catch((error) => {
        console.error("Failed to read KV state", { filePath, error })
      })
      .finally(() => {
        setReady(true)
      })

    const result = {
      get ready() {
        return ready()
      },
      get store() {
        return store
      },
      signal<T>(name: string, defaultValue: T) {
        if (store[name] === undefined) setStore(name, defaultValue)
        return [
          function () {
            return result.get(name)
          },
          function setter(next: Setter<T>) {
            result.set(name, next)
          },
        ] as const
      },
      get(key: string, defaultValue?: unknown) {
        return store[key] ?? defaultValue
      },
      set(key: string, value: any) {
        setStore(key, value)
        const snapshot = structuredClone(unwrap(store))
        write = write
          .then(() => Flock.withLock(lock, () => writeSnapshot(snapshot)))
          .catch((error) => {
            console.error("Failed to write KV state", { filePath, error })
          })
      },
    }
    return result
  },
})
