import { Global } from "@redcode-ai/core/global"
import { Filesystem } from "@/util/filesystem"
import { Flock } from "@redcode-ai/core/util/flock"
import { AppFileSystem } from "@redcode-ai/core/filesystem"
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

    // 先写临时文件再替换，kv.json 只会在 JSON 完整之后被顶掉，关机打断也不会留半截文件。
    //
    // 260901 cc 这里原本自己搓了一份 temp+rename（临时名用 Date.now()，同一毫秒连写会撞名），
    //   现在并到 AppFileSystem.writeFileAtomic：同一份语义，外加 Windows 上目标被外部句柄
    //   临时握住时的 rename 重试。配置文件那条路同时也换成了它。
    function writeSnapshot(snapshot: Record<string, any>) {
      return AppFileSystem.writeFileAtomic(filePath, JSON.stringify(snapshot, null, 2))
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
