import { FlueError } from "@flue/runtime"
import { classifyWorkspaceProbeFailure, type WorkspaceProbeFailure } from "./workspace-probe"

export type WorkspaceSnapshot = {
  generation: string
  head: string
  branch: string
  fingerprint: string
  ready: boolean
}
export type WorkspaceState = {
  owner?: string
  checkpoint?: WorkspaceSnapshot
  inFlight: boolean
  recoveries: number
  runId: string
  blocked?: string
  probeFailure?: WorkspaceProbeFailure
}
export type WorkspaceStore = { read(): WorkspaceState | undefined; write(state: WorkspaceState): void }
type Options = {
  inspect(): Promise<WorkspaceSnapshot | null>
  prepare(
    checkpoint: WorkspaceSnapshot | undefined,
    signal: AbortSignal,
    inspect: () => Promise<WorkspaceSnapshot | null>,
  ): Promise<void>
  store: WorkspaceStore
  runId: string
}

export class WorkspaceRecovery {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly options: Options
  private readonly owner = crypto.randomUUID()
  private readonly lifetime = new AbortController()

  constructor(options: Options) {
    this.options = options
    const saved = options.store.read()
    const retained = saved && (saved.runId === options.runId || saved.blocked || saved.inFlight)
    // Claim ownership synchronously; abandoned continuations cannot overwrite
    // this invocation. Blockers retain their original id until acknowledged.
    options.store.write(
      retained
        ? {
            ...saved,
            owner: this.owner,
            blocked:
              saved.blocked ||
              (saved.inFlight
                ? "An earlier operation has an unknown outcome. Inspect its effects before continuing."
                : undefined),
          }
        : {
            owner: this.owner,
            checkpoint: saved?.checkpoint,
            inFlight: false,
            runId: options.runId,
            recoveries: 0,
          },
    )
  }

  private state(): WorkspaceState {
    const saved = this.options.store.read()
    if (this.lifetime.signal.aborted || !saved || saved.owner !== this.owner)
      throw new WorkspaceLostError(
        "This workspace attempt was superseded. Its late result was ignored.",
        this.options.runId,
      )
    return saved
  }

  private block(reason: string, probeFailure?: WorkspaceProbeFailure): never {
    this.options.store.write({ ...this.state(), blocked: reason, ...(probeFailure ? { probeFailure } : {}) })
    throw new WorkspaceLostError(reason, this.state().runId, this.state().probeFailure)
  }

  assertUsable() {
    const state = this.state()
    if (state.blocked) throw new WorkspaceLostError(state.blocked, state.runId, state.probeFailure)
  }

  finish() {
    this.assertUsable()
    if (this.state().inFlight)
      this.block("The run ended with an operation still in flight. Inspect its effects before continuing.")
  }

  close() {
    // Fence late callbacks even if no newer invocation ever claims this guard.
    this.lifetime.abort()
  }

  private signal(signal?: AbortSignal) {
    return signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(work)
    this.queue = pending.catch(() => {})
    return pending
  }

  async start(force: boolean, signal?: AbortSignal) {
    return this.serial(async () => {
      const activeSignal = this.signal(signal)
      activeSignal.throwIfAborted()
      this.assertUsable()
      if (this.state().inFlight)
        this.block("An earlier command has an unknown outcome. Inspect its effects before starting another run.")
      await this.ensureReady(force, activeSignal)
    })
  }

  private async inspect(signal = this.lifetime.signal): Promise<WorkspaceSnapshot | null> {
    for (let attempts = 1; ; attempts++) {
      signal.throwIfAborted()
      this.assertUsable()
      try {
        const snapshot = await withWorkspaceDeadline(30_000, () => this.options.inspect(), signal)
        signal.throwIfAborted()
        this.assertUsable()
        return snapshot
      } catch (error) {
        signal.throwIfAborted()
        this.assertUsable()
        const failure = { ...classifyWorkspaceProbeFailure(error), attempts }
        if (attempts >= 3 || (failure.kind !== "transport" && failure.kind !== "timeout")) {
          console.warn("jared: workspace probe failed", { runId: this.state().runId, ...failure })
          return this.block(
            `The workspace health check failed (${failure.kind}${failure.exitCode !== undefined ? `, exit ${failure.exitCode}` : ""}; ${attempts} ${attempts === 1 ? "attempt" : "attempts"}). No further commands were started.`,
            failure,
          )
        }
        // Only repeat the read-only probe. A timed-out provider call can finish
        // late, but cannot update checkpoints or start preparation/tools.
        await waitForProbeRetry(400 * attempts, signal)
      }
    }
  }

  private async ensureReady(force = false, signal = this.lifetime.signal): Promise<WorkspaceSnapshot> {
    this.assertUsable()
    const state = this.state()
    let current = await this.inspect(signal)
    signal.throwIfAborted()
    this.assertUsable()
    const replaced = !!state.checkpoint && (!current || current.generation !== state.checkpoint.generation)
    if (force || !current?.ready || current.generation === "untracked" || replaced) {
      const recovering = !!state.checkpoint && (!current?.ready || replaced)
      if (recovering && state.recoveries >= 2) this.block("Workspace recovery was exhausted after two attempts.")
      // Commit the budget before external work so a DO restart cannot reset it.
      this.options.store.write({ ...this.state(), inFlight: true, recoveries: state.recoveries + Number(recovering) })
      try {
        await withWorkspaceDeadline(
          180_000,
          (preparationSignal) =>
            this.options.prepare(replaced ? state.checkpoint : undefined, preparationSignal, () =>
              this.inspect(preparationSignal),
            ),
          signal,
        )
      } catch {
        // A preparation probe may already have recorded a specific failure.
        this.assertUsable()
        this.block("The repository, skills, authentication, or saved Git checkpoint could not be restored.")
      }
      current = await this.inspect(signal)
      if (!current?.ready) this.block("Workspace preparation did not produce a usable repository and authentication.")
      this.options.store.write({ ...this.state(), inFlight: false })
    }
    if (!current) this.block("The workspace is missing.")
    if (replaced && state.checkpoint && !sameCheckpoint(current, state.checkpoint)) {
      this.block(
        "The saved branch, commit, or local changes could not be restored. Work has not been silently restarted on the default branch.",
      )
    }
    this.options.store.write({ ...this.state(), checkpoint: current })
    return current
  }

  run<T>(operation: () => Promise<T>, mutating: boolean, signal?: AbortSignal): Promise<T> {
    return this.serial(async () => {
      const activeSignal = this.signal(signal)
      activeSignal.throwIfAborted()
      this.assertUsable()
      if (this.state().inFlight)
        this.block("An earlier command has an unknown outcome. Inspect its effects before continuing.")
      const before = await this.ensureReady(false, activeSignal)
      activeSignal.throwIfAborted()
      if (mutating) this.options.store.write({ ...this.state(), inFlight: true })
      let result: T
      try {
        result = await operation()
      } catch (error) {
        // A failed exec may still have pushed, created a PR, or left an orphan
        // process running. Never replay it, even when a root-cwd probe works.
        if (mutating)
          this.block(
            "A command or write has an unknown outcome. It was not replayed; inspect its effects before retrying.",
          )
        const current = await this.inspect(activeSignal)
        if (current?.ready && current.generation === before.generation) throw error
        await this.ensureReady(false, activeSignal)
        // Reads alone may be retried, once. A second workspace loss is terminal.
        try {
          result = await operation()
        } catch (retryError) {
          const retried = await this.inspect(activeSignal)
          if (!retried?.ready || retried.generation !== this.state().checkpoint?.generation)
            this.block("The workspace was lost again during the read retry.")
          throw retryError
        }
      }
      const after = await this.inspect(activeSignal)
      if (!after || after.generation !== this.state().checkpoint?.generation) {
        this.block("The workspace disappeared during an operation. Its result cannot be trusted.")
      }
      this.options.store.write({ ...this.state(), checkpoint: after, inFlight: false })
      return result
    })
  }

  async verifyGeneration() {
    this.assertUsable()
    const current = await this.inspect()
    if (!current || current.generation !== this.state().checkpoint?.generation)
      this.block("The workspace disappeared before a write. No file contents were written.")
  }
}

/** A container-side exec timeout cannot bound a dead Worker-to-container RPC. */
export async function withWorkspaceDeadline<T>(
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted()
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      controller.abort(signal?.reason)
      reject(controller.signal.reason)
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    timer = setTimeout(() => {
      const error = new DOMException("Workspace operation timed out", "TimeoutError")
      controller.abort(error)
      reject(error)
    }, ms)
  })
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted()
        return work(controller.signal)
      }),
      deadline,
    ])
  } finally {
    clearTimeout(timer)
    if (onAbort) signal?.removeEventListener("abort", onAbort)
  }
}

function sameCheckpoint(a: WorkspaceSnapshot, b: WorkspaceSnapshot) {
  return a.head === b.head && a.branch === b.branch && a.fingerprint === b.fingerprint
}

function waitForProbeRetry(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

/** Deliberately contains no command, token, stderr, or repository contents. */
export class WorkspaceLostError extends FlueError {
  constructor(reason: string, runId?: string, probeFailure?: WorkspaceProbeFailure) {
    super({
      type: "workspace_lost",
      message: "Jared is blocked by a lost or uncertain workspace.",
      details: reason,
      dev: "",
      ...(runId || probeFailure
        ? {
            meta: {
              ...(runId ? { workspaceRunId: runId } : {}),
              ...(probeFailure ? { workspaceProbe: probeFailure } : {}),
            },
          }
        : {}),
    })
  }
}
