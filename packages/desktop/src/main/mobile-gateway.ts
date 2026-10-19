import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual, X509Certificate } from "node:crypto"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http"
import { createServer, type Server as HttpsServer } from "node:https"
import { networkInterfaces, tmpdir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { promisify } from "node:util"
import type { ServerResponse } from "node:http"

// 261019 Red Mobile companion access boundaries: docs/notes/implemented/feature/2026-10-19-mobile-companion-gateway.md
const execFileAsync = promisify(execFile)
// 261019 Red Pairing codes are short-lived; device tokens remain individually revocable.
const PAIRING_TTL_MS = 5 * 60_000
const MAX_PAIR_ATTEMPTS = 5
const MAX_PAIRED_DEVICES = 8
const MAX_PAIR_BODY_BYTES = 4 * 1024
const MAX_REQUEST_BODY_BYTES = 1024 * 1024
const MAX_SANITIZED_JSON_BYTES = 1024 * 1024
const DEVICE_COOKIE = "rc_device"

export type MobileGatewayScope = {
  directory: string
  initialSessionID?: string
}

export type MobileGatewayDevice = {
  id: string
  name: string
  pairedAt: number
}

export type MobileGatewayTlsIdentity = {
  key: Buffer
  cert: Buffer
  fingerprint: string
}

type MobileGatewayAuthOptions = {
  pairingCode: string
  expiresAt: number
  now?: () => number
}

type MobileGatewayPairResult = {
  device: MobileGatewayDevice
  token: string
}

export function createMobileGatewayAuth(options: MobileGatewayAuthOptions) {
  const now = options.now ?? Date.now
  let pairingCodeHash = hash(options.pairingCode)
  let expiresAt = options.expiresAt
  let pairingUsed = false
  const devices = new Map<string, { device: MobileGatewayDevice; tokenHash: Buffer }>()
  const streams = new Map<string, Set<() => void>>()
  let attempts = 0

  const closeDeviceStreams = (id: string) => {
    for (const close of streams.get(id) ?? []) close()
    streams.delete(id)
  }

  return {
    pair(code: string, name: string): MobileGatewayPairResult | undefined {
      if (now() >= expiresAt || pairingUsed || attempts >= MAX_PAIR_ATTEMPTS || devices.size >= MAX_PAIRED_DEVICES)
        return
      const supplied = hash(code)
      if (!timingSafeEqual(supplied, pairingCodeHash)) {
        attempts += 1
        return
      }

      pairingUsed = true
      const token = randomBytes(32).toString("base64url")
      const device = {
        id: randomUUID(),
        name: name.trim().slice(0, 64) || "Android device",
        pairedAt: now(),
      }
      devices.set(device.id, { device, tokenHash: hash(token) })
      return { device, token }
    },
    rotate(code: string, nextExpiresAt: number) {
      pairingCodeHash = hash(code)
      expiresAt = nextExpiresAt
      attempts = 0
      pairingUsed = false
    },
    authenticate(token: string | undefined) {
      if (!token) return
      const supplied = hash(token)
      for (const value of devices.values()) {
        if (timingSafeEqual(supplied, value.tokenHash)) return value.device
      }
    },
    devices() {
      return [...devices.values()].map((value) => ({ ...value.device }))
    },
    track(id: string, close: () => void) {
      const active = streams.get(id)
      if (active) active.add(close)
      else streams.set(id, new Set([close]))
      return () => {
        const current = streams.get(id)
        current?.delete(close)
        if (current?.size === 0) streams.delete(id)
      }
    },
    revoke(id: string) {
      if (!devices.delete(id)) return false
      closeDeviceStreams(id)
      return true
    },
    clear() {
      for (const id of streams.keys()) closeDeviceStreams(id)
      devices.clear()
    },
  }
}

export type MobileGatewayRoute = {
  kind:
    | "read"
    | "event"
    | "projects"
    | "providers"
    | "sessions"
    | "session-status"
    | "questions"
    | "prompt"
    | "abort"
    | "question"
  maxBodyBytes: number
}

const SESSION_ID = "[A-Za-z0-9_-]+"

export function mobileGatewayRoute(method: string, pathname: string): MobileGatewayRoute | undefined {
  if (method === "GET" && pathname === "/session") return { kind: "sessions", maxBodyBytes: 0 }
  if (method === "GET" && pathname === "/session/status") return { kind: "session-status", maxBodyBytes: 0 }
  if (method === "GET" && pathname === "/question") return { kind: "questions", maxBodyBytes: 0 }
  if (
    method === "GET" &&
    (pathname === "/global/health" ||
      pathname === "/global/event" ||
      pathname === "/project/current" ||
      new RegExp(`^/session/${SESSION_ID}$`).test(pathname) ||
      new RegExp(`^/session/${SESSION_ID}/(?:message|changes|todo|goal)$`).test(pathname) ||
      new RegExp(`^/session/${SESSION_ID}/message/${SESSION_ID}$`).test(pathname))
  ) {
    return { kind: pathname.endsWith("/event") ? "event" : "read", maxBodyBytes: 0 }
  }
  if (method === "GET" && pathname === "/project") return { kind: "projects", maxBodyBytes: 0 }
  if (method === "GET" && pathname === "/config/providers") return { kind: "providers", maxBodyBytes: 0 }

  if (method === "POST" && new RegExp(`^/session/${SESSION_ID}/prompt_async$`).test(pathname))
    return { kind: "prompt", maxBodyBytes: MAX_REQUEST_BODY_BYTES }

  if (method === "POST" && new RegExp(`^/session/${SESSION_ID}/abort$`).test(pathname))
    return { kind: "abort", maxBodyBytes: MAX_PAIR_BODY_BYTES }

  if (method === "POST" && new RegExp(`^/question/${SESSION_ID}/reply$`).test(pathname))
    return { kind: "question", maxBodyBytes: MAX_PAIR_BODY_BYTES }
}

export function isSafeMobileGatewayHost(host: string) {
  if (host === "127.0.0.1") return true
  const parts = host.split(".").map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  if (parts[0] === 10) return true
  if (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) return true
  return parts[0] === 192 && parts[1] === 168
}

export function mobileGatewaySessionInScope(session: unknown, sessionID: string, directory: string) {
  return isRecord(session) && session.id === sessionID && session.directory === directory
}

export function listMobileGatewayHosts() {
  const hosts = new Map<string, string>([["127.0.0.1", "USB / loopback only"]])
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || !isSafeMobileGatewayHost(address.address) || address.address === "127.0.0.1")
        continue
      hosts.set(address.address, name)
    }
  }
  return [...hosts].map(([address, name]) => ({ address, name }))
}

export async function createMobileGatewayTlsIdentity(host: string): Promise<MobileGatewayTlsIdentity> {
  if (!isSafeMobileGatewayHost(host)) throw new Error("Mobile Gateway requires a loopback or private IPv4 address")
  const directory = await mkdtemp(join(tmpdir(), "redcode-mobile-tls-"))
  const keyPath = join(directory, "key.pem")
  const certPath = join(directory, "cert.pem")
  const subjectAltName = host === "127.0.0.1" ? "DNS:localhost,IP:127.0.0.1" : `DNS:localhost,IP:127.0.0.1,IP:${host}`

  try {
    // 261019 Red Android trusts this self-signed identity only after an out-of-band SHA-256 pin match.
    await execFileAsync(resolveOpenSSL(), [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "3650",
      "-subj",
      "/CN=RedCode Mobile",
      "-addext",
      `subjectAltName=${subjectAltName}`,
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "extendedKeyUsage=serverAuth",
      "-addext",
      "keyUsage=critical,digitalSignature,keyCertSign,cRLSign",
    ], { timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true })
    const cert = await readFile(certPath)
    return {
      key: await readFile(keyPath),
      cert,
      fingerprint: new X509Certificate(cert).fingerprint256.replaceAll(":", "").toLowerCase(),
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function resolveOpenSSL() {
  const executable = process.platform === "win32" ? "openssl.exe" : "openssl"
  const fromPath = (process.env.PATH ?? "")
    .split(delimiter)
    .flatMap((entry) => {
      const path = resolve(entry)
      return [join(path, executable), join(dirname(path), "usr", "bin", executable)]
    })
    .find((path) => existsSync(path))
  return fromPath ?? "openssl"
}

function hash(value: string) {
  return createHash("sha256").update(value).digest()
}

type Sidecar = {
  url: string
  username: string
  password: string
}

type MobileGatewayOptions = {
  host: string
  port?: number
  scope: MobileGatewayScope
  sidecar: Sidecar
  tls?: MobileGatewayTlsIdentity
}

export type MobileGatewayStartInfo = {
  url: string
  host: string
  port: number
  pairingCode: string
  pairingExpiresAt: number
  fingerprint: string
}

export function createMobileGateway(options: MobileGatewayOptions) {
  let server: HttpsServer | undefined
  let auth: ReturnType<typeof createMobileGatewayAuth> | undefined
  let startInfo: MobileGatewayStartInfo | undefined
  let access: MobileGatewayAccess | undefined

  return {
    async start(): Promise<MobileGatewayStartInfo> {
      if (server && startInfo) return startInfo
      if (!isSafeMobileGatewayHost(options.host)) throw new Error("Select a loopback or private IPv4 interface")
      const sidecar = new URL(options.sidecar.url)
      if (sidecar.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(sidecar.hostname))
        throw new Error("Mobile Gateway upstream must be the local GUI sidecar")

      const tls = options.tls ?? (await createMobileGatewayTlsIdentity(options.host))
      const pairingCode = String(randomInt(0, 100_000_000)).padStart(8, "0")
      const pairingExpiresAt = Date.now() + PAIRING_TTL_MS
      auth = createMobileGatewayAuth({ pairingCode, expiresAt: pairingExpiresAt })
      access = {
        sessions: new Set(options.scope.initialSessionID ? [options.scope.initialSessionID] : []),
        questions: new Set(),
      }
      const activeAccess = access
      server = createServer({ key: tls.key, cert: tls.cert }, (request, response) => {
        void handleRequest({
          request,
          response,
          auth: auth!,
          sidecar: options.sidecar,
          scope: options.scope,
          access: activeAccess,
        })
      })
      const activeServer = server
      try {
        await new Promise<void>((resolveListen, rejectListen) => {
          const onError = (error: Error) => {
            activeServer.off("listening", onListening)
            rejectListen(error)
          }
          const onListening = () => {
            activeServer.off("error", onError)
            resolveListen()
          }
          activeServer.once("error", onError)
          activeServer.once("listening", onListening)
          activeServer.listen(options.port ?? 0, options.host)
        })
      } catch (error) {
        auth.clear()
        auth = undefined
        access = undefined
        server = undefined
        throw error
      }
      const address = activeServer.address()
      if (!address || typeof address === "string") throw new Error("Mobile Gateway failed to acquire a TCP port")
      const host = options.host === "127.0.0.1" ? "localhost" : options.host
      startInfo = {
        url: `https://${host}:${address.port}`,
        host,
        port: address.port,
        pairingCode,
        pairingExpiresAt,
        fingerprint: tls.fingerprint,
      }
      return startInfo
    },
    devices() {
      return auth?.devices() ?? []
    },
    refreshPairingCode() {
      if (!server || !auth || !startInfo) return
      const pairingCode = String(randomInt(0, 100_000_000)).padStart(8, "0")
      const pairingExpiresAt = Date.now() + PAIRING_TTL_MS
      auth.rotate(pairingCode, pairingExpiresAt)
      startInfo = { ...startInfo, pairingCode, pairingExpiresAt }
      return startInfo
    },
    revoke(id: string) {
      return auth?.revoke(id) ?? false
    },
    async stop() {
      const current = server
      server = undefined
      auth?.clear()
      auth = undefined
      access?.sessions.clear()
      access?.questions.clear()
      access = undefined
      startInfo = undefined
      if (!current) return
      current.closeAllConnections()
      await new Promise<void>((resolveClose) => current.close(() => resolveClose()))
    },
  }
}

type RequestContext = {
  request: IncomingMessage
  response: ServerResponse
  auth: ReturnType<typeof createMobileGatewayAuth>
  sidecar: Sidecar
  scope: MobileGatewayScope
  access: MobileGatewayAccess
}

type MobileGatewayAccess = {
  sessions: Set<string>
  questions: Set<string>
}

async function handleRequest(context: RequestContext) {
  const { request, response, auth, sidecar, scope, access } = context
  const url = new URL(request.url ?? "/", "https://mobile.invalid")
  if (request.method === "POST" && url.pathname === "/__mobile/pair") {
    if (request.headers.origin || request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json")
      return writeJson(response, 403, { error: "Pairing requires the native client" })
    const body = await readBody(request, MAX_PAIR_BODY_BYTES).catch((error: unknown) => {
      writeJson(response, error instanceof RequestBodyError ? error.status : 400, { error: "Invalid pairing request" })
      return undefined
    })
    if (!body) return
    const payload = parseObject(body)
    if (!payload || typeof payload.code !== "string" || typeof payload.name !== "string")
      return writeJson(response, 400, { error: "Invalid pairing request" })
    const paired = auth.pair(payload.code, payload.name)
    if (!paired) return writeJson(response, 401, { error: "Pairing code is invalid, expired, or already used" })
    return writeJson(response, 200, {
      deviceID: paired.device.id,
      token: paired.token,
      directory: scope.directory,
      sessionID: scope.initialSessionID,
    })
  }

  const route = mobileGatewayRoute(request.method ?? "", url.pathname)
  if (!route) return writeJson(response, 403, { error: "This route is not available to mobile devices" })
  const host = request.headers.host?.toLowerCase()
  const allowedHost = host === `localhost:${request.socket.localPort}` ||
    host === `127.0.0.1:${request.socket.localPort}` ||
    host === `${request.socket.localAddress}:${request.socket.localPort}`
  if (!allowedHost) return writeJson(response, 421, { error: "Unexpected Gateway host" })

  const token = cookie(request.headers.cookie, DEVICE_COOKIE)
  const device = auth.authenticate(token)
  if (!device) return writeJson(response, 401, { error: "Pair this device with the desktop first" })
  if (request.method !== "GET" && request.headers.origin !== `https://${host}`)
    return writeJson(response, 403, { error: "Cross-origin writes are not allowed" })
  if (url.searchParams.has("workspace")) {
    return writeJson(response, 403, { error: "Workspace routing is not available to mobile devices" })
  }
  if (
    (route.kind === "read" && url.pathname.startsWith("/session/")) ||
    route.kind === "prompt" ||
    route.kind === "abort"
  ) {
    const sessionID = url.pathname.split("/")[2]
    if (!access.sessions.has(sessionID ?? "")) return writeJson(response, 403, { error: "Session is not available to this device" })
  }
  if (route.kind === "question" && !access.questions.has(url.pathname.split("/")[2] ?? "")) {
    return writeJson(response, 403, { error: "Question is not available to this device" })
  }
  const requestDirectory = request.headers["x-redcode-directory"]
  if (requestDirectory && requestDirectory !== scope.directory)
    return writeJson(response, 403, { error: "This device is limited to its paired workspace" })
  const requestedDirectories = url.searchParams.getAll("directory")
  if (requestedDirectories.some((directory) => directory !== scope.directory))
    return writeJson(response, 403, { error: "This device is limited to its paired workspace" })
  const body = await readBody(request, route.maxBodyBytes).catch((error: unknown) => {
    writeJson(response, error instanceof RequestBodyError ? error.status : 400, { error: "Invalid request body" })
    return undefined
  })
  if (!body) return
  if (route.kind === "prompt" && !validPromptBody(body, url.pathname.split("/")[2]))
    return writeJson(response, 400, { error: "Prompt session does not match the requested session" })

  const sidecarURL = new URL(sidecar.url)
  const upstreamPath = new URL(request.url ?? "/", sidecarURL)
  upstreamPath.searchParams.delete("directory")
  if (route.kind === "projects") {
    upstreamPath.pathname = "/project/current"
    upstreamPath.search = ""
  }
  if (request.method === "GET" && url.pathname === "/session") upstreamPath.searchParams.set("scope", "project")
  const headers: Record<string, string> = {
    accept: request.headers.accept ?? "*/*",
    "x-redcode-directory": scope.directory,
    "user-agent": "RedCode Mobile Gateway",
  }
  for (const name of ["content-type", "if-none-match", "last-event-id"] as const) {
    const value = request.headers[name]
    if (typeof value === "string") headers[name] = value
  }
  if (body.length) headers["content-length"] = String(body.length)

  const controller = new AbortController()
  let upstreamRequest: ClientRequest | undefined
  let upstreamResponse: IncomingMessage | undefined
  const abortUpstream = () => {
    const socket = upstreamResponse?.socket ?? upstreamRequest?.socket
    controller.abort()
    upstreamResponse?.destroy()
    upstreamRequest?.destroy()
    socket?.destroy()
  }
  const untrack = auth.track(device.id, abortUpstream)
  const upstream = httpRequest(
    {
      protocol: sidecarURL.protocol,
      hostname: sidecarURL.hostname,
      port: sidecarURL.port,
      path: `${upstreamPath.pathname}${upstreamPath.search}`,
      method: request.method,
      auth: `${sidecar.username}:${sidecar.password}`,
      headers,
      signal: controller.signal,
    },
    (result) => {
      upstreamResponse = result
      if (controller.signal.aborted) return result.destroy()
      response.statusCode = result.statusCode ?? 502
      for (const name of ["cache-control", "content-type", "etag", "last-modified"] as const) {
        const value = result.headers[name]
        if (typeof value === "string") response.setHeader(name, value)
      }
      response.setHeader("cache-control", result.headers["cache-control"] ?? "no-store")
      if (url.pathname === "/global/event" && result.statusCode === 200) {
        return filterGlobalEvents(result, response, scope.directory, access, controller, untrack)
      }
      if (
        ["projects", "providers", "sessions", "session-status", "questions"].includes(route.kind) &&
        result.statusCode === 200
      ) {
        void readUpstreamBody(result, MAX_SANITIZED_JSON_BYTES)
          .then((body) => {
            const safe =
              route.kind === "projects"
                ? projectListResponse(body)
                : route.kind === "providers"
                  ? providerConfigResponse(body)
                  : route.kind === "sessions"
                    ? sessionListResponse(body, scope.directory, access.sessions)
                    : route.kind === "session-status"
                      ? sessionStatusResponse(body, access.sessions)
                      : questionListResponse(body, access.sessions, access.questions)
            if (!safe) return writeJson(response, 502, { error: "GUI sidecar returned an unexpected response" })
            response.statusCode = 200
            response.setHeader("content-type", "application/json; charset=utf-8")
            response.setHeader("cache-control", "no-store")
            response.end(safe)
          })
          .catch(() => writeJson(response, 502, { error: "GUI sidecar response exceeded the mobile limit" }))
          .finally(untrack)
        return
      }
      if (route.kind === "question" && result.statusCode !== undefined && result.statusCode >= 200 && result.statusCode < 300) {
        access.questions.delete(url.pathname.split("/")[2] ?? "")
      }
      result.pipe(response)
      result.once("end", untrack)
    },
  )
  upstreamRequest = upstream
  if (controller.signal.aborted) upstream.destroy()
  upstream.on("error", () => {
    untrack()
    if (response.headersSent) response.destroy()
    else writeJson(response, 502, { error: "GUI sidecar is unavailable" })
  })
  response.once("close", () => {
    abortUpstream()
    untrack()
  })
  upstream.end(body)
}

function filterGlobalEvents(
  upstream: IncomingMessage,
  response: ServerResponse,
  directory: string,
  access: MobileGatewayAccess,
  controller: AbortController,
  untrack: () => void,
) {
  const decoder = new StringDecoder("utf8")
  let pending = ""
  upstream.on("data", (chunk: Buffer) => {
    pending += decoder.write(chunk)
    while (true) {
      const separator = /\r?\n\r?\n/.exec(pending)
      if (!separator || separator.index === undefined) break
      const frame = pending.slice(0, separator.index)
      pending = pending.slice(separator.index + separator[0].length)
      if (eventInScope(frame, directory, access)) response.write(`${frame}\n\n`)
    }
  })
  upstream.once("end", () => {
    pending += decoder.end()
    if (pending && eventInScope(pending, directory, access)) response.write(`${pending}\n\n`)
    response.end()
    untrack()
  })
  upstream.once("error", () => {
    controller.abort()
    untrack()
    response.destroy()
  })
  response.once("close", () => {
    upstream.destroy()
    controller.abort()
    untrack()
  })
}

function eventInScope(frame: string, directory: string, access: MobileGatewayAccess) {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
  if (!data) return false
  const envelope = parseObject(Buffer.from(data))
  if (envelope?.directory !== directory) return false
  if (!isRecord(envelope.payload) || !isRecord(envelope.payload.properties)) return true

  const type = envelope.payload.type
  const properties = envelope.payload.properties
  const sessionID = properties.sessionID
  if (typeof sessionID === "string") access.sessions.add(sessionID)
  if (type === "question.asked" && typeof sessionID === "string" && typeof properties.id === "string") {
    access.questions.add(properties.id)
  }
  if (
    (type === "question.replied" || type === "question.rejected") &&
    typeof properties.requestID === "string"
  ) {
    access.questions.delete(properties.requestID)
  }
  return true
}

class RequestBodyError extends Error {
  constructor(readonly status: number) {
    super("Request body rejected")
  }
}

async function readBody(request: IncomingMessage, limit: number) {
  if (limit === 0) return Buffer.alloc(0)
  const declaredLength = Number(request.headers["content-length"] ?? 0)
  if (declaredLength > limit) throw new RequestBodyError(413)
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > limit) throw new RequestBodyError(413)
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, size)
}

async function readUpstreamBody(response: IncomingMessage, limit: number) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of response) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > limit) throw new Error("Sidecar JSON response exceeded the mobile limit")
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, size)
}

function projectListResponse(body: Buffer) {
  const project = parseObject(body)
  if (!project || typeof project.id !== "string" || typeof project.worktree !== "string") return
  const safe: Record<string, unknown> = { ...project, sandboxes: [] }
  if (isRecord(project.icon)) {
    safe.icon = { ...project.icon, url: undefined, override: undefined }
  }
  return JSON.stringify([safe])
}

function sessionListResponse(body: Buffer, directory: string, allowedSessions: Set<string>) {
  const sessions = parseArray(body)?.filter(
    (session): session is Record<string, unknown> & { id: string } =>
      isRecord(session) && typeof session.id === "string" && session.directory === directory,
  )
  if (!sessions) return
  sessions.forEach((session) => allowedSessions.add(session.id))
  return JSON.stringify(sessions)
}

function sessionStatusResponse(body: Buffer, allowedSessions: Set<string>) {
  const statuses = parseObject(body)
  if (!statuses) return
  return JSON.stringify(Object.fromEntries(Object.entries(statuses).filter(([id]) => allowedSessions.has(id))))
}

function questionListResponse(body: Buffer, allowedSessions: Set<string>, allowedQuestions: Set<string>) {
  const questions = parseArray(body)?.filter(
    (question): question is Record<string, unknown> & { id: string } =>
      isRecord(question) &&
      typeof question.id === "string" &&
      typeof question.sessionID === "string" &&
      allowedSessions.has(question.sessionID),
  )
  if (!questions) return
  questions.forEach((question) => allowedQuestions.add(question.id))
  return JSON.stringify(questions)
}

const publicModelFields = [
  "id",
  "providerID",
  "api",
  "name",
  "family",
  "capabilities",
  "cost",
  "limit",
  "status",
  "release_date",
  "reasoningOptions",
] as const

function providerConfigResponse(body: Buffer) {
  const payload = parseObject(body)
  if (!payload || !Array.isArray(payload.providers) || !isRecord(payload.default)) return
  const providers = payload.providers.flatMap((provider) => {
    if (!isRecord(provider) || typeof provider.id !== "string" || typeof provider.name !== "string") return []
    if (!isRecord(provider.models)) return []
    const models = Object.fromEntries(
      Object.entries(provider.models).flatMap(([id, model]) => {
        if (!isRecord(model)) return []
        const publicModel = Object.fromEntries(
          publicModelFields.flatMap((key) => (Object.hasOwn(model, key) ? [[key, model[key]]] : [])),
        )
        return [[id, { ...publicModel, options: {}, headers: {} }]]
      }),
    )
    const source = ["env", "config", "custom", "api"].includes(String(provider.source)) ? provider.source : "config"
    return [{ id: provider.id, name: provider.name, source, env: [], options: {}, models }]
  })
  const defaults = Object.fromEntries(Object.entries(payload.default).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
  return JSON.stringify({ providers, default: defaults })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function parseObject(body: Buffer) {
  let value: unknown
  try {
    value = JSON.parse(body.toString("utf8"))
  } catch {
    // Malformed mobile JSON is a client error; it must not reach the sidecar parser.
    return
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function parseArray(body: Buffer) {
  let value: unknown
  try {
    value = JSON.parse(body.toString("utf8"))
  } catch {
    // Malformed sidecar arrays must fail closed instead of exposing the unfiltered body.
    return
  }
  if (!Array.isArray(value)) return
  return value as unknown[]
}

function validPromptBody(body: Buffer, sessionID: string | undefined) {
  const payload = parseObject(body)
  return !!payload && Array.isArray(payload.parts) && (!Object.hasOwn(payload, "sessionID") || payload.sessionID === sessionID)
}

function cookie(header: string | undefined, name: string) {
  return header
    ?.split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`))
    ?.slice(name.length + 1)
}

function writeJson(response: ServerResponse, status: number, body: Record<string, unknown>) {
  if (response.destroyed) return
  response.statusCode = status
  response.setHeader("cache-control", "no-store")
  response.setHeader("content-type", "application/json; charset=utf-8")
  response.end(JSON.stringify(body))
}
