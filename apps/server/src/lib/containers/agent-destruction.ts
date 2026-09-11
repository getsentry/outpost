/** Only deleteAll removes this marker; it survives an incomplete teardown/reset. */
export const AGENT_DESTRUCTION_MARKER = "jared:destruction-pending"

export type AgentDestructionRpc = {
  prepareDestroy(): Promise<void>
  destroy(): Promise<void>
  isDestroyComplete(): Promise<boolean>
}

/**
 * The SDK wipes storage and then aborts the isolate, which can reject its RPC
 * reply. Never infer success from that error (or from a normal return): require
 * a fresh instance to confirm that the previously acknowledged marker is gone.
 * The session controller holds its persistent D1 fence throughout this protocol.
 */
export async function destroyAgentWithConfirmation(getAgent: () => AgentDestructionRpc): Promise<void> {
  await getAgent().prepareDestroy()
  let failure: unknown
  try {
    await getAgent().destroy()
  } catch (error) {
    failure = error
  }
  // A successful RPC may return just before the SDK's zero-delay abort. A new
  // stub on every probe also avoids reusing the broken RPC connection.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (await getAgent().isDestroyComplete()) return
    } catch (error) {
      failure ??= error
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)))
  }
  throw new Error("Agent storage deletion could not be confirmed", { cause: failure })
}
