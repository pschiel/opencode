import path from "path"
import fs from "fs/promises"
import fsSync from "fs"
import { Global } from "../global"
import z from "zod"

export namespace Log {
  export const Level = z.enum(["DEBUG", "INFO", "WARN", "ERROR"]).meta({ ref: "LogLevel", description: "Log level" })
  export type Level = z.infer<typeof Level>

  const levelPriority: Record<Level, number> = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
  }

  let level: Level = "INFO"

  function shouldLog(input: Level): boolean {
    return levelPriority[input] >= levelPriority[level]
  }

  export type Logger = {
    debug(message?: any, extra?: Record<string, any>): void
    info(message?: any, extra?: Record<string, any>): void
    error(message?: any, extra?: Record<string, any>): void
    warn(message?: any, extra?: Record<string, any>): void
    tag(key: string, value: string): Logger
    clone(): Logger
    time(
      message: string,
      extra?: Record<string, any>,
    ): {
      stop(): void
      [Symbol.dispose](): void
    }
  }

  const loggers = new Map<string, Logger>()

  export const Default = create({ service: "default" })

  export interface Options {
    print: boolean
    dev?: boolean
    level?: Level
    requestLog?: boolean
  }

  let logpath = ""
  export function file() {
    return logpath
  }
  let write = (msg: any): number | Promise<number> => {
    process.stderr.write(msg)
    return msg.length
  }

  let requestLogPath = ""
  let requestLogEnabled = false
  export function requestFile() {
    return requestLogPath
  }
  let requestWrite = (msg: any): number | Promise<number> => {
    return 0
  }

  export async function init(options: Options) {
    if (options.level) level = options.level
    cleanup(Global.Path.log)
    if (options.print) return
    logpath = path.join(
      Global.Path.log,
      options.dev ? "dev.log" : new Date().toISOString().split(".")[0].replace(/:/g, "") + ".log",
    )
    const logfile = Bun.file(logpath)
    await fs.truncate(logpath).catch(() => {})
    const writer = logfile.writer()
    write = async (msg: any) => {
      const num = writer.write(msg)
      writer.flush()
      return num
    }

    if (options.requestLog) {
      requestLogEnabled = true
      requestLogPath = path.join(
        Global.Path.log,
        options.dev ? "dev.request.log" : new Date().toISOString().split(".")[0].replace(/:/g, "") + ".request.log",
      )
      // Create the file initially
      await fs.writeFile(requestLogPath, "").catch(() => {})

      // Use SYNCHRONOUS file appending to ensure writes complete before process exit
      requestWrite = (msg: any) => {
        try {
          fsSync.appendFileSync(requestLogPath, msg)
          return msg.length
        } catch (e) {
          return 0
        }
      }
    }
  }

  export function isRequestLoggingEnabled() {
    return requestLogEnabled
  }

  function formatRequestLog(data: any): string {
    const timestamp = new Date().toISOString()
    const time = timestamp.substring(11, 19) // HH:MM:SS

    // ANSI color codes
    const RESET = "\x1b[0m"
    const BOLD = "\x1b[1m"
    const DIM = "\x1b[2m"
    const CYAN = "\x1b[36m"
    const GREEN = "\x1b[32m"
    const YELLOW = "\x1b[33m"
    const RED = "\x1b[31m"
    const BLUE = "\x1b[34m"
    const MAGENTA = "\x1b[35m"
    const GRAY = "\x1b[90m"
    const ORANGE = "\x1b[38;5;208m"

    const lines: string[] = []
    const separator = GRAY + "─".repeat(100) + RESET
    const requestId = data.requestId ? `${GRAY}[${data.requestId}]${RESET}` : ""

    if (data.type === "REQUEST") {
      // Single status line with request ID
      const statusLine = `${CYAN}${BOLD}▶ REQUEST${RESET} ${DIM}${time}${RESET} ${requestId} ${GRAY}|${RESET} ${data.provider}${GRAY}/${RESET}${BLUE}${BOLD}${data.model}${RESET} ${GRAY}|${RESET} ${DIM}${data.url}${RESET}`
      lines.push(separator)
      lines.push(statusLine)
      lines.push("") // blank line after status

      if (data.body?.messages) {
        for (const msg of data.body.messages) {
          const roleColor = msg.role === "user" ? GREEN : msg.role === "assistant" ? BLUE : MAGENTA
          const content = msg.content.trim()

          // Show full content at first column, no indentation
          lines.push(`${roleColor}${BOLD}[${msg.role}]${RESET} ${content}`)
        }
      }

      if (data.body?.tools_count) {
        lines.push(`${DIM}Tools: ${data.body.tools_count} (${data.body.tools_summary})${RESET}`)
      }
    } else if (data.type === "RESPONSE") {
      // Single status line with request ID
      const statusColor = data.status >= 200 && data.status < 300 ? GREEN : RED
      const tokenInfo = data.total_tokens
        ? `${GRAY}|${RESET} Tokens: ${CYAN}${data.input_tokens}${RESET}/${YELLOW}${data.output_tokens}${RESET}=${BOLD}${data.total_tokens}${RESET}`
        : ""

      const statusLine = `${GREEN}${BOLD}◀ RESPONSE${RESET} ${DIM}${time}${RESET} ${requestId} ${GRAY}|${RESET} ${statusColor}${data.status}${RESET} ${GRAY}|${RESET} ${data.duration}ms ${tokenInfo}`
      lines.push(separator)
      lines.push(statusLine)
      lines.push("") // blank line after status

      if (data.completion) {
        // Format: [model] completion text at first column
        const modelName = data.model || "model"
        lines.push(`${BLUE}${BOLD}[${modelName}]${RESET} ${data.completion}`)
      }
    } else if (data.type === "ERROR") {
      // Single status line with request ID
      const statusLine = `${RED}${BOLD}✖ ERROR${RESET} ${DIM}${time}${RESET} ${requestId} ${GRAY}|${RESET} ${data.provider}${GRAY}/${RESET}${data.model} ${GRAY}|${RESET} ${data.duration}ms`
      lines.push(separator)
      lines.push(statusLine)
      lines.push("") // blank line after status
      lines.push(`${RED}${data.error}${RESET}`)
    }

    lines.push("") // blank line after entry
    return lines.join("\n")
  }

  export async function logRequest(data: any) {
    if (!requestLogEnabled) return
    requestWrite(formatRequestLog(data))
  }

  export async function flushRequestLog() {
    // No-op since we're using synchronous writes
  }

  async function cleanup(dir: string) {
    const glob = new Bun.Glob("????-??-??T??????.log")
    const requestGlob = new Bun.Glob("????-??-??T??????.request.log")
    const files = await Array.fromAsync(
      glob.scan({
        cwd: dir,
        absolute: true,
      }),
    )
    const requestFiles = await Array.fromAsync(
      requestGlob.scan({
        cwd: dir,
        absolute: true,
      }),
    )
    if (files.length > 5) {
      const filesToDelete = files.slice(0, -10)
      await Promise.all(filesToDelete.map((file) => fs.unlink(file).catch(() => {})))
    }
    if (requestFiles.length > 5) {
      const filesToDelete = requestFiles.slice(0, -10)
      await Promise.all(filesToDelete.map((file) => fs.unlink(file).catch(() => {})))
    }
  }

  function formatError(error: Error, depth = 0): string {
    const result = error.message
    return error.cause instanceof Error && depth < 10
      ? result + " Caused by: " + formatError(error.cause, depth + 1)
      : result
  }

  let last = Date.now()
  export function create(tags?: Record<string, any>) {
    tags = tags || {}

    const service = tags["service"]
    if (service && typeof service === "string") {
      const cached = loggers.get(service)
      if (cached) {
        return cached
      }
    }

    function build(message: any, extra?: Record<string, any>) {
      const prefix = Object.entries({
        ...tags,
        ...extra,
      })
        .filter(([_, value]) => value !== undefined && value !== null)
        .map(([key, value]) => {
          const prefix = `${key}=`
          if (value instanceof Error) return prefix + formatError(value)
          if (typeof value === "object") return prefix + JSON.stringify(value)
          return prefix + value
        })
        .join(" ")
      const next = new Date()
      const diff = next.getTime() - last
      last = next.getTime()
      return [next.toISOString().split(".")[0], "+" + diff + "ms", prefix, message].filter(Boolean).join(" ") + "\n"
    }
    const result: Logger = {
      debug(message?: any, extra?: Record<string, any>) {
        if (shouldLog("DEBUG")) {
          write("DEBUG " + build(message, extra))
        }
      },
      info(message?: any, extra?: Record<string, any>) {
        if (shouldLog("INFO")) {
          write("INFO  " + build(message, extra))
        }
      },
      error(message?: any, extra?: Record<string, any>) {
        if (shouldLog("ERROR")) {
          write("ERROR " + build(message, extra))
        }
      },
      warn(message?: any, extra?: Record<string, any>) {
        if (shouldLog("WARN")) {
          write("WARN  " + build(message, extra))
        }
      },
      tag(key: string, value: string) {
        if (tags) tags[key] = value
        return result
      },
      clone() {
        return Log.create({ ...tags })
      },
      time(message: string, extra?: Record<string, any>) {
        const now = Date.now()
        result.info(message, { status: "started", ...extra })
        function stop() {
          result.info(message, {
            status: "completed",
            duration: Date.now() - now,
            ...extra,
          })
        }
        return {
          stop,
          [Symbol.dispose]() {
            stop()
          },
        }
      },
    }

    if (service && typeof service === "string") {
      loggers.set(service, result)
    }

    return result
  }
}
