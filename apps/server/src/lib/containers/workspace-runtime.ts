import { AsyncLocalStorage } from "node:async_hooks"
import { Buffer } from "node:buffer"
import { getSandbox } from "@cloudflare/sandbox"
import type { FlueExecutionInterceptor, SandboxFactory, SessionEnv } from "@flue/runtime"
import { getCloudflareContext } from "@flue/runtime/cloudflare"
import type { DoPrepEnv } from "./do-prep"
import type { JaredSandbox } from "./sandbox"
import { SANDBOX_OPTS } from "./sandbox-opts"
import { inspectWorkspace, prepareWorkspace, workspaceStore } from "./workspace-checkpoint"
import { WorkspaceLostError, WorkspaceRecovery, withWorkspaceDeadline } from "./workspace-recovery"

const activeWorkspace = new AsyncLocalStorage<WorkspaceRecovery>()

export function assertWorkspaceUsable() {
  activeWorkspace.getStore()?.assertUsable()
}

export function currentWorkspace(): WorkspaceRecovery {
  const guard = activeWorkspace.getStore()
  if (!guard) throw new WorkspaceLostError("The workspace execution scope is unavailable.")
  return guard
}

/** Submission-scoped, including delegated tasks. No process-global per-user map. */
export const workspaceInterceptor: FlueExecutionInterceptor = async (operation, ctx, next) => {
  if (
    operation.type !== "agent" ||
    !ctx.submissionId ||
    operation.operationId !== ctx.submissionId ||
    ctx.agentName !== "jared" ||
    !ctx.instanceId
  )
    return next()
  const { env, storage } = getCloudflareContext()
  const bindings = env as unknown as DoPrepEnv
  const id = ctx.instanceId
  const sandbox = getSandbox(bindings.Sandbox as DurableObjectNamespace<JaredSandbox>, id, SANDBOX_OPTS)
  const guard = new WorkspaceRecovery({
    runId: ctx.submissionId,
    store: workspaceStore(storage.sql),
    inspect: () => inspectWorkspace(sandbox),
    prepare: (checkpoint, signal) =>
      prepareWorkspace(bindings, id, sandbox, checkpoint, signal, () => guard.assertUsable()),
  })
  const leaseId = `${ctx.submissionId}:${crypto.randomUUID()}`
  return activeWorkspace.run(guard, async () => {
    try {
      await withWorkspaceDeadline(30_000, () => sandbox.acquireRunLease(leaseId))
      const result = await next()
      guard.finish()
      return result
    } catch (error) {
      // Preserve our typed failure if a model/delegate wrapped the tool error.
      guard.finish()
      throw error
    } finally {
      guard.close()
      // The durable watchdog remains a backstop if teardown or this RPC fails.
      await withWorkspaceDeadline(10_000, () => sandbox.releaseRunLease(leaseId)).catch(() =>
        console.warn("jared: workspace lease cleanup deferred to watchdog", { instanceId: id }),
      )
    }
  })
}

/** Decorate Flue's adapter, keeping its cwd, cancellation, and file semantics. */
type SandboxFiles = {
  mkdir(path: string, options: { recursive: boolean }): Promise<unknown>
  writeFile(path: string, contents: string, options?: { encoding: "base64" }): Promise<unknown>
}

export function recoverableSandbox(factory: SandboxFactory, files: SandboxFiles): SandboxFactory {
  return {
    ...factory,
    async createSessionEnv(options) {
      return guardSessionEnv(await factory.createSessionEnv(options), currentWorkspace, files)
    },
  }
}

export function guardSessionEnv(inner: SessionEnv, getGuard: () => WorkspaceRecovery, files: SandboxFiles): SessionEnv {
  return {
    ...inner,
    exec: (command, options) => getGuard().run(() => inner.exec(command, options), true, options?.signal),
    readFile: (path) => getGuard().run(() => inner.readFile(path), false),
    readFileBuffer: (path) => getGuard().run(() => inner.readFileBuffer(path), false),
    stat: (path) => getGuard().run(() => inner.stat(path), false),
    readdir: (path) => getGuard().run(() => inner.readdir(path), false),
    // SessionEnv.exists is specified to never throw. The sticky guard still
    // blocks the next write/exec/model render or the finish hook.
    exists: async (path) => {
      try {
        return await getGuard().run(() => inner.exists(path), false)
      } catch {
        // Reconciliation discovers context outside a submission scope. Missing
        // scope must be false, never an unguarded call into the sandbox.
        return false
      }
    },
    // Flue's generic adapter retries *any* failed write after mkdir. Create the
    // parent first, then make exactly one provider write under our guard.
    writeFile: (path, content) =>
      getGuard().run(async () => {
        const target = inner.resolvePath(path)
        await withWorkspaceDeadline(30_000, () => {
          getGuard().assertUsable()
          return files.mkdir(target.slice(0, target.lastIndexOf("/")) || "/", { recursive: true })
        })
        await getGuard().verifyGeneration()
        await withWorkspaceDeadline(30_000, () => {
          getGuard().assertUsable()
          return typeof content === "string"
            ? files.writeFile(target, content)
            : files.writeFile(target, Buffer.from(content).toString("base64"), { encoding: "base64" })
        })
      }, true),
    mkdir: (path, options) => getGuard().run(() => inner.mkdir(path, options), true),
    rm: (path, options) => getGuard().run(() => inner.rm(path, options), true),
  }
}
