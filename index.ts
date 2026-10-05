import { Plugin } from "@opencode/plugin/effect";
import { Effect, Layer, Schedule, Stream } from "effect";

import { registerCommands } from "./src/commands";
import { PluginConfig } from "./src/config";
import { makeHandler } from "./src/handler";
import { LarkSender } from "./src/lark";
import { LarkPingRpc } from "./src/rpc";
import { makeRunningCheck } from "./src/sessions";

export default Plugin.define({
  id: "lark-ping",
  effect: (ctx) => {
    const layer = LarkSender.layer.pipe(Layer.provideMerge(PluginConfig.layer(ctx.options)));

    return Effect.gen(function* () {
      const rpc = yield* ctx.rpc.register(LarkPingRpc, {});
      yield* registerCommands({
        command: ctx.command,
        storage: ctx.storage,
        events: rpc.events,
      });

      const handleEvent = yield* makeHandler({
        session: ctx.session,
        location: ctx.location,
        storage: ctx.storage,
        hasRunningSubagents: makeRunningCheck(),
      });

      yield* ctx.event.subscribe().pipe(
        Stream.tapError(() => Effect.logWarning("Lark Ping disconnected; reconnecting")),
        Stream.retry(Schedule.spaced("1 second")),
        Stream.runForEach(handleEvent),
        Effect.catch(() => Effect.logError("Lark Ping listener stopped")),
        Effect.forkScoped,
      );

      yield* Effect.logInfo("Lark Ping plugin loaded");
    }).pipe(
      Effect.provide(layer),
      Effect.catch(() => Effect.logError("Lark Ping startup failed")),
    );
  },
});
