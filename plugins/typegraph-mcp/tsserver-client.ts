/**
 * TsServerClient — TypeScript Server Protocol Bridge
 *
 * Spawns tsserver as a child process and provides a typed async API
 * for sending commands and receiving responses.
 *
 * Protocol: tsserver uses Content-Length framed JSON over stdin/stdout.
 * Requests are newline-terminated JSON. Responses are matched by request_seq.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { createRequire } from "node:module";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Location {
  line: number;
  offset: number;
}

export interface DefinitionResult {
  file: string;
  start: Location;
  end: Location;
  contextStart?: Location;
  contextEnd?: Location;
}

export interface ReferenceEntry {
  file: string;
  start: Location;
  end: Location;
  isDefinition: boolean;
  isWriteAccess: boolean;
  lineText: string;
}

export interface QuickInfoResult {
  displayString: string;
  documentation: string;
  kind: string;
  kindModifiers: string;
  start: Location;
  end: Location;
}

export interface NavToItem {
  name: string;
  kind: string;
  file: string;
  start: Location;
  end: Location;
  containerName: string;
  containerKind: string;
  matchKind: string;
}

export interface NavBarItem {
  text: string;
  kind: string;
  kindModifiers: string;
  spans: Array<{ start: Location; end: Location }>;
  childItems: NavBarItem[];
}

// ─── Logging ─────────────────────────────────────────────────────────────────

const log = (...args: unknown[]) => console.error("[typegraph/tsserver]", ...args);

// ─── TsServerClient ─────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 10_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  command: string;
}

export class TsServerClient {
  private child: ChildProcess | null = null;
  private seq = 0;
  private pending = new Map<number, PendingRequest>();
  private openFiles = new Set<string>();
  private buffer = Buffer.alloc(0);
  private ready = false;
  private shuttingDown = false;
  private restartCount = 0;
  private readonly maxRestarts = 3;

  constructor(
    private readonly projectRoot: string,
    private readonly tsconfigPath: string = "./tsconfig.json"
  ) {}

  // ─── Path Resolution ────────────────────────────────────────────────────

  resolvePath(file: string): string {
    return path.isAbsolute(file) ? file : path.resolve(this.projectRoot, file);
  }

  relativePath(file: string): string {
    return path.relative(this.projectRoot, file);
  }

  /** Read a line from a file (1-based line number). Returns trimmed content. */
  readLine(file: string, line: number): string {
    try {
      const absPath = this.resolvePath(file);
      const content = fs.readFileSync(absPath, "utf-8");
      const lines = content.split("\n");
      return lines[line - 1]?.trim() ?? "";
    } catch {
      return "";
    }
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.child) return;

    // Resolve tsserver from the TARGET project's node_modules, not the MCP server's
    const require = createRequire(path.resolve(this.projectRoot, "package.json"));
    const tsserverPath = require.resolve("typescript/lib/tsserver.js");

    log(`Spawning tsserver: ${tsserverPath}`);
    log(`Project root: ${this.projectRoot}`);
    log(`tsconfig: ${this.tsconfigPath}`);

    this.child = spawn("node", [tsserverPath, "--disableAutomaticTypingAcquisition"], {
      cwd: this.projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TSS_LOG: undefined },
    });

    this.child.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
    this.child.stderr!.on("data", (chunk: Buffer) => {
      // tsserver stderr is diagnostic info — log it
      const text = chunk.toString().trim();
      if (text) log(`[stderr] ${text}`);
    });

    this.child.on("close", (code) => {
      log(`tsserver exited with code ${code}`);
      this.child = null;
      this.rejectAllPending(new Error(`tsserver exited with code ${code}`));
      this.tryRestart();
    });

    this.child.on("error", (err) => {
      log(`tsserver error: ${err.message}`);
      this.rejectAllPending(err);
    });

    // Send configure request to set the project
    await this.sendRequest("configure", {
      preferences: {
        disableSuggestions: true,
      },
    });

    // Warm up by opening the tsconfig's root file
    const warmStart = performance.now();
    const tsconfigAbs = this.resolvePath(this.tsconfigPath);
    if (fs.existsSync(tsconfigAbs)) {
      await this.sendRequest("compilerOptionsForInferredProjects", {
        options: { allowJs: true, checkJs: false },
      });
    }
    this.ready = true;
    log(`Ready [${(performance.now() - warmStart).toFixed(0)}ms configure]`);
  }

  shutdown(): void {
    this.shuttingDown = true;
    if (this.child) {
      this.child.kill("SIGTERM");
      this.child = null;
    }
    this.rejectAllPending(new Error("Client shutdown"));
  }

  private tryRestart(): void {
    if (this.shuttingDown) return;
    if (this.restartCount >= this.maxRestarts) {
      log(`Max restarts (${this.maxRestarts}) reached, not restarting`);
      return;
    }
    this.restartCount++;
    log(`Restarting tsserver (attempt ${this.restartCount})...`);
    this.buffer = Buffer.alloc(0);

    // Re-open previously tracked files after restart
    const filesToReopen = [...this.openFiles];
    this.openFiles.clear();
    this.start().then(async () => {
      for (const file of filesToReopen) {
        await this.ensureOpen(file).catch(() => {});
      }
    });
  }

  private rejectAllPending(err: Error): void {
    for (const [seq, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  // ─── Protocol: Parsing ──────────────────────────────────────────────────

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.processBuffer();
  }

  private processBuffer(): void {
    while (true) {
      // Look for Content-Length header
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return; // Need more data

      const header = this.buffer.subarray(0, headerEnd).toString("utf-8");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        // Skip malformed data — advance past the header
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1]!, 10);
      const bodyStart = headerEnd + 4;

      if (this.buffer.length < bodyStart + contentLength) {
        return; // Need more data for the body
      }

      const bodyBytes = this.buffer.subarray(bodyStart, bodyStart + contentLength);
      this.buffer = this.buffer.subarray(bodyStart + contentLength);

      try {
        const message = JSON.parse(bodyBytes.toString("utf-8"));
        this.onMessage(message);
      } catch {
        log("Failed to parse tsserver message");
      }
    }
  }

  private onMessage(message: {
    type: string;
    request_seq?: number;
    success?: boolean;
    body?: unknown;
    message?: string;
    command?: string;
  }): void {
    if (message.type === "response" && message.request_seq !== undefined) {
      const pending = this.pending.get(message.request_seq);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.request_seq);
        if (message.success) {
          pending.resolve(message.body);
        } else {
          pending.reject(
            new Error(`tsserver ${pending.command} failed: ${message.message ?? "unknown error"}`)
          );
        }
      }
    }
    // Ignore events (type: "event") — tsserver sends diagnostics, etc.
  }

  // ─── Protocol: Sending ──────────────────────────────────────────────────

  private sendRequest(command: string, args?: object): Promise<unknown> {
    if (!this.child?.stdin?.writable) {
      return Promise.reject(new Error("tsserver not running"));
    }

    const seq = ++this.seq;
    const request = {
      seq,
      type: "request",
      command,
      arguments: args,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`tsserver ${command} timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(seq, { resolve, reject, timer, command });
      this.child!.stdin!.write(JSON.stringify(request) + "\n");
    });
  }

  // Fire-and-forget — for commands like `open` that may not send a response
  private sendNotification(command: string, args?: object): void {
    if (!this.child?.stdin?.writable) return;
    const seq = ++this.seq;
    const request = { seq, type: "request", command, arguments: args };
    this.child.stdin.write(JSON.stringify(request) + "\n");
  }

  // ─── File Management ───────────────────────────────────────────────────

  async ensureOpen(file: string): Promise<void> {
    const absPath = this.resolvePath(file);
    if (this.openFiles.has(absPath)) return;
    this.openFiles.add(absPath);
    // `open` is fire-and-forget — tsserver doesn't reliably respond
    this.sendNotification("open", { file: absPath });
    // Small delay to let tsserver process the open before we query
    await new Promise((r) => setTimeout(r, 50));
  }

  async reloadOpenFile(file: string): Promise<boolean> {
    const absPath = this.resolvePath(file);
    if (!this.openFiles.has(absPath)) return false;
    await this.sendRequest("reload", {
      file: absPath,
      tmpfile: absPath,
    });
    return true;
  }

  closeFile(file: string): boolean {
    const absPath = this.resolvePath(file);
    if (!this.openFiles.delete(absPath)) return false;
    this.sendNotification("close", { file: absPath });
    return true;
  }

  // ─── Public API ────────────────────────────────────────────────────────

  async definition(file: string, line: number, offset: number): Promise<DefinitionResult[]> {
    const absPath = this.resolvePath(file);
    await this.ensureOpen(absPath);

    const body = (await this.sendRequest("definition", {
      file: absPath,
      line,
      offset,
    })) as DefinitionResult[] | undefined;

    if (!body || !Array.isArray(body)) return [];

    return body.map((d) => ({
      ...d,
      file: this.relativePath(d.file),
    }));
  }

  async references(file: string, line: number, offset: number): Promise<ReferenceEntry[]> {
    const absPath = this.resolvePath(file);
    await this.ensureOpen(absPath);

    const body = (await this.sendRequest("references", {
      file: absPath,
      line,
      offset,
    })) as { refs?: ReferenceEntry[] } | undefined;

    if (!body?.refs) return [];

    return body.refs.map((r) => ({
      ...r,
      file: this.relativePath(r.file),
    }));
  }

  async quickinfo(file: string, line: number, offset: number): Promise<QuickInfoResult | null> {
    const absPath = this.resolvePath(file);
    await this.ensureOpen(absPath);

    try {
      const body = (await this.sendRequest("quickinfo", {
        file: absPath,
        line,
        offset,
      })) as QuickInfoResult | undefined;

      return body ?? null;
    } catch {
      // tsserver returns success:false with "No content available" for positions
      // without type info (e.g., keywords, whitespace). This is expected, not an error.
      return null;
    }
  }

  async navto(searchValue: string, maxResults = 10, file?: string): Promise<NavToItem[]> {
    // If a file is specified, open it first so tsserver knows about it
    if (file) await this.ensureOpen(file);

    const args: Record<string, unknown> = {
      searchValue,
      maxResultCount: maxResults,
    };
    if (file) args["file"] = this.resolvePath(file);

    const body = (await this.sendRequest("navto", args)) as NavToItem[] | undefined;

    if (!body || !Array.isArray(body)) return [];

    return body.map((item) => ({
      ...item,
      file: this.relativePath(item.file),
    }));
  }

  async navbar(file: string): Promise<NavBarItem[]> {
    const absPath = this.resolvePath(file);
    await this.ensureOpen(absPath);

    const body = (await this.sendRequest("navbar", {
      file: absPath,
    })) as NavBarItem[] | undefined;

    return body ?? [];
  }
}
