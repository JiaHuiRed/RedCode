import { createMemo } from "solid-js"
import { useLocation, useParams } from "@solidjs/router"
import { useServerSync } from "./server-sync"
import { decodeDirectory } from "@/utils/project-dir"
import { productMode } from "@/utils/product-mode"

export function useProductSession() {
  const params = useParams()
  const sync = useServerSync()
  return createMemo(() => {
    const directory = params.dir ? decodeDirectory(params.dir) : undefined
    return directory && params.id
      ? sync.peek(directory, { bootstrap: false })[0].session.find((item) => item.id === params.id)
      : undefined
  })
}

export function useProductMode() {
  const location = useLocation()
  const params = useParams()
  const session = useProductSession()
  return createMemo(() => (params.id && !session() ? undefined : productMode(location.pathname, session())))
}
