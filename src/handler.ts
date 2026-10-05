import { basename } from "node:path";

import type { OpenCodeEvent } from "@opencode/client/effect";
import type { Plugin } from "@opencode/plugin/effect";
import { SessionMessage } from "@opencode/schema";
import { Effect, Option } from "effect";

import { PluginConfig } from "./config";
import { LarkSender } from "./lark";
import { Notice, notificationIntent, turnDurationMs } from "./notification";
import { notificationKey } from "./preferences";
import type { makeRunningCheck } from "./sessions";

type HandlerDependencies = {
  readonly session: Pick<Plugin.Context["session"], "get" | "context">;
  readonly location: Plugin.Context["location"];
  readonly storage: Pick<Plugin.Context["storage"], "get">;
  readonly hasRunningSubagents: ReturnType<typeof makeRunningCheck>;
};

export const makeHandler = Effect.fn("LarkPing.makeHandler")(function* ({
  session,
  location,
  storage,
  hasRunningSubagents,
}: HandlerDependencies) {
  const config = yield* PluginConfig;
  const sender = yield* LarkSender;

  return Effect.fn("LarkPing.handleEvent")(function* (event: OpenCodeEvent) {
    const intent = notificationIntent(event);
    if (Option.isNone(intent)) {
      return;
    }

    const key = notificationKey(intent.value.sessionID);
    const enabled = (yield* storage.get(key)) === true;
    if (!enabled) {
      return;
    }

    const info = yield* session
      .get({ sessionID: intent.value.sessionID })
      .pipe(
        Effect.catch(() =>
          Effect.logWarning("Lark Ping could not read session info").pipe(Effect.as(undefined)),
        ),
      );

    if (info === undefined) {
      return;
    }

    if (info.location.directory !== location.directory) {
      return;
    }

    if (info.parentID !== undefined) {
      return;
    }

    if (intent.value.kind === "Done") {
      const running = yield* hasRunningSubagents(info.id).pipe(
        Effect.catch(() =>
          Effect.logWarning("Lark Ping could not verify agent completion").pipe(Effect.as(true)),
        ),
      );
      if (running) return;
    }

    if (intent.value.kind === "Done" && config.minimumTurnDurationMs > 0) {
      const messages = yield* session
        .context({ sessionID: info.id })
        .pipe(
          Effect.catch(() =>
            Effect.logWarning("Lark Ping could not read turn timing").pipe(Effect.as([])),
          ),
        );

      const duration = turnDurationMs(messages, SessionMessage.ID.fromEvent(event.id));

      if (Option.isSome(duration) && duration.value < config.minimumTurnDurationMs) {
        return;
      }
    }

    const notice: Notice = {
      _tag: intent.value.kind,
      session: {
        title: info.title ?? "Untitled",
        project: basename(location.project.canonical),
      },
    };

    yield* sender.send(notice, event.id).pipe(
      Effect.catchTag("DeliveryError", (error) =>
        Effect.logWarning("Lark Ping delivery failed", {
          message: error.message,
        }),
      ),
    );
  });
});
