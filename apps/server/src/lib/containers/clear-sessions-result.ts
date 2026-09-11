export type ClearSessionsResult =
  | { ok: true; mode: "idle"; deleted: number; destroyed: number }
  | {
      ok: boolean
      mode: "all"
      deleted: number
      destroyed: number
      deletedKeys: string[]
      failed: string[]
    }
