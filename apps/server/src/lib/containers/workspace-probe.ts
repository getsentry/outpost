import { isTransientSandboxError } from "./sandbox-errors"

export type WorkspaceProbeFailure = {
  kind: "timeout" | "transport" | "command_failed" | "invalid_checkpoint" | "unknown"
  attempts: number
  exitCode?: number
}

/** Contains no provider message, stderr, command, credentials, or file contents. */
export class WorkspaceProbeError extends Error {
  readonly kind: "command_failed" | "invalid_checkpoint"
  readonly exitCode?: number

  constructor(kind: "command_failed" | "invalid_checkpoint", exitCode?: number) {
    super(`Workspace probe failed: ${kind}`)
    this.name = "WorkspaceProbeError"
    this.kind = kind
    if (typeof exitCode === "number" && Number.isInteger(exitCode) && exitCode >= -1 && exitCode <= 255)
      this.exitCode = exitCode
  }
}

export function classifyWorkspaceProbeFailure(error: unknown): Omit<WorkspaceProbeFailure, "attempts"> {
  if (error instanceof WorkspaceProbeError)
    return { kind: error.kind, ...(error.exitCode !== undefined ? { exitCode: error.exitCode } : {}) }
  if (error instanceof Error && error.name === "TimeoutError") return { kind: "timeout" }
  if (isTransientSandboxError(error)) return { kind: "transport" }
  return { kind: "unknown" }
}
