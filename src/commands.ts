import type { Plugin } from "@opencode/plugin/effect";
import type { RpcRegistration } from "@opencode/plugin/effect/rpc";
import { Effect } from "effect";

import { notificationKey } from "./preferences";
import type { LarkPingRpc } from "./rpc";

type CommandDependencies = {
  readonly command: Pick<Plugin.Context["command"], "transform">;
  readonly storage: Pick<Plugin.Context["storage"], "get" | "set">;
  readonly events: RpcRegistration<typeof LarkPingRpc>["events"];
};

export const registerCommands = ({ command, storage, events }: CommandDependencies) =>
  command.transform((editor) => {
    editor.add({
      name: "lark-ping",
      description: "Control Lark notifications for this session",
      execute: Effect.fn("LarkPing.command")(function* ({ sessionID }) {
        const key = notificationKey(sessionID);
        const enabled = (yield* storage.get(key)) === true;

        yield* storage.set(key, !enabled);
        yield* Effect.logInfo(`Lark Ping ${!enabled ? "on" : "off"}`);
        yield* events
          .emit("changed", { sessionID, enabled: !enabled })
          .pipe(
            Effect.catch(() =>
              Effect.logWarning("Lark Ping could not announce notification state"),
            ),
          );
      }),
    });
  });
