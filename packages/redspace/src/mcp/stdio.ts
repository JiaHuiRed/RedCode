import { PassThrough, type Stream, type Writable } from "node:stream"
import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js"
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js"
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js"
import { Process, type Child } from "@/util/process"

export class WindowsJobStdioClientTransport implements Transport {
  private readonly server: StdioServerParameters
  private readonly readBuffer: ReadBuffer
  private readonly stderrStream: PassThrough | null
  private process: Child | undefined
  private closing: Promise<void> | undefined

  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  constructor(server: StdioServerParameters) {
    this.server = server
    this.readBuffer = new ReadBuffer({ maxBufferSize: server.maxBufferSize })
    this.stderrStream = server.stderr === "pipe" || server.stderr === "overlapped" ? new PassThrough() : null
  }

  async start() {
    if (this.process) throw new Error("WindowsJobStdioClientTransport already started!")

    const child = Process.spawn([this.server.command, ...(this.server.args ?? [])], {
      cwd: this.server.cwd,
      env: this.server.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: this.server.stderr === "pipe" || this.server.stderr === "overlapped" ? "pipe" : "inherit",
    })
    this.process = child

    child.on("error", (error) => this.onerror?.(error))
    child.on("close", () => {
      if (this.process === child) this.process = undefined
      this.onclose?.()
    })
    child.stdin?.on("error", (error) => this.onerror?.(error))
    child.stdout?.on("error", (error) => this.onerror?.(error))
    child.stdout?.on("data", (chunk: Buffer) => {
      try {
        this.readBuffer.append(chunk)
      } catch (error) {
        // 260908 Red ReadBuffer overflow is fatal for this transport; report it before closing the Job.
        this.onerror?.(error instanceof Error ? error : new Error(String(error)))
        void this.close()
        return
      }
      this.processReadBuffer()
    })
    if (this.stderrStream && child.stderr) child.stderr.pipe(this.stderrStream)
    void child.exited.catch((error: unknown) =>
      this.onerror?.(error instanceof Error ? error : new Error(String(error))),
    )

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.removeListener("error", onError)
        resolve()
      }
      const onError = (error: Error) => {
        child.removeListener("spawn", onSpawn)
        reject(error)
      }
      child.once("spawn", onSpawn)
      child.once("error", onError)
    })
  }

  get stderr(): Stream | null {
    return this.stderrStream ?? this.process?.stderr ?? null
  }

  get stdin(): Writable | null {
    return this.process?.stdin ?? null
  }

  get pid(): number | null {
    return this.process?.pid ?? null
  }

  private processReadBuffer() {
    while (true) {
      try {
        const message = this.readBuffer.readMessage()
        if (message === null) return
        this.onmessage?.(message)
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }

  async close() {
    if (this.closing) return this.closing
    const child = this.process
    if (!child) {
      this.readBuffer.clear()
      return
    }

    this.closing = (async () => {
      const close = new Promise<void>((resolve) => child.once("close", resolve))
      child.stdin?.end()
      await Promise.race([close, delay(2_000)])
      if (child.exitCode === null && child.signalCode === null) {
        await Process.stop(child)
        await Promise.race([close, delay(2_000)])
      }
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      await Promise.race([close, delay(2_000)])
      this.readBuffer.clear()
    })()
    return this.closing
  }

  send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    const stdin = this.process?.stdin
    if (!stdin) return Promise.reject(new Error("Not connected"))
    const json = serializeMessage(message)
    if (stdin.write(json)) return Promise.resolve()
    return new Promise<void>((resolve) => stdin.once("drain", resolve))
  }
}

export function createStdioClientTransport(server: StdioServerParameters) {
  if (process.platform === "win32" && typeof Bun !== "undefined") {
    return new WindowsJobStdioClientTransport(server)
  }
  return new StdioClientTransport(server)
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

export * as McpStdio from "./stdio"
