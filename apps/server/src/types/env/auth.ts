import type { createAuth } from "@/utils";
import type { BaseEnv } from "./base";

export type AuthEnv = {
  Bindings: BaseEnv["Bindings"];
  Variables: BaseEnv["Variables"] & {
    user: ReturnType<typeof createAuth>["$Infer"]["Session"]["user"] | null;
    session: ReturnType<typeof createAuth>["$Infer"]["Session"]["session"] | null;
  };
};

export type AuthenticatedEnv = {
  Bindings: BaseEnv["Bindings"];
  Variables: BaseEnv["Variables"] & ReturnType<typeof createAuth>["$Infer"]["Session"];
};
