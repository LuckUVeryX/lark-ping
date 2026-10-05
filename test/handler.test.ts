import { describe, expect, it } from "@effect/vitest";
import type { Plugin } from "@opencode/plugin/effect";
import type { CommandDefinition } from "@opencode/plugin/effect/command";
import { Location, Session, SessionMessage } from "@opencode/schema";
import { SessionEvent } from "@opencode/schema/session-event";
import { Effect, Schema } from "effect";

import { registerCommands } from "../src/commands";
import { PluginConfig } from "../src/config";
import { makeHandler } from "../src/handler";
import { DeliveryError, LarkSender } from "../src/lark";
import type { Notice } from "../src/notification";
import { notificationKey } from "../src/preferences";
import { CompletionCheckError, makeRunningCheck } from "../src/sessions";

describe("handler", () => {
  const fixtures = Effect.gen(function* () {
    const location = yield* Schema.decodeEffect(Location.Info)({
      directory: "/projects/lark-ping",
      project: {
        id: "prj_test",
        directory: "/projects/lark-ping",
        canonical: "/projects/lark-ping",
      },
    });
    const info = yield* Schema.decodeEffect(Session.Info)({
      id: "ses_test",
      projectID: "prj_test",
      title: "Build notifications",
      location: { directory: location.directory },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      time: { created: 0, updated: 1000 },
    });

    const event = yield* Schema.decodeEffect(SessionEvent.Execution.Succeeded)({
      type: "session.execution.succeeded",
      id: "evt_done",
      created: 1000,
      data: { sessionID: info.id },
      durable: {
        aggregateID: info.id,
        seq: 1,
        version: 1,
      },
    });

    const blocked = yield* Schema.decodeEffect(SessionEvent.Execution.Failed)({
      type: "session.execution.failed",
      id: "evt_blocked",
      created: 1000,
      data: {
        sessionID: info.id,
        error: { type: "TEST_ERROR", message: "fake-error" },
      },
      durable: { aggregateID: info.id, seq: 2, version: 1 },
    });

    const followup = yield* Schema.decodeEffect(SessionEvent.Execution.Succeeded)({
      ...event,
      id: "evt_followup",
      created: 2000,
      durable: { ...event.durable, seq: 3 },
    });

    return { location, info, event, blocked, followup };
  });

  const setup = (
    info: Session.Info,
    location: Location.Info,
    minimumTurnDurationMs: number,
    overrides: Partial<Pick<Plugin.Context["session"], "get" | "context">> & {
      storage?: Pick<Plugin.Context["storage"], "get">;
      hasRunningSubagents?: ReturnType<typeof makeRunningCheck>;
    } = {},
    send: Parameters<typeof LarkSender.of>[0]["send"] = () => Effect.succeed("fake-message-id"),
  ) =>
    Effect.gen(function* () {
      let contextReads = 0;
      let completionQueries = 0;
      const deliveries: Array<{ notice: Notice; deliveryId: string }> = [];

      const handleEvent = yield* makeHandler({
        location,
        hasRunningSubagents: (sessionID) =>
          Effect.gen(function* () {
            completionQueries++;
            return overrides.hasRunningSubagents === undefined
              ? false
              : yield* overrides.hasRunningSubagents(sessionID);
          }),
        session: {
          get:
            overrides.get ??
            (({ sessionID }) => {
              expect(sessionID).toBe(info.id);
              return Effect.succeed(info);
            }),
          context: (input) =>
            Effect.gen(function* () {
              contextReads++;
              return overrides.context === undefined ? [] : yield* overrides.context(input);
            }),
        },
        storage: overrides.storage ?? { get: () => Effect.succeed(true) },
      }).pipe(
        Effect.provide(
          PluginConfig.layer({
            recipient: { id: "open-code" },
            credentials: { appId: "app", appSecret: "secret" },
            minimumTurnDurationMs,
          }),
        ),
        Effect.provideService(
          LarkSender,
          LarkSender.of({
            send: (notice, deliveryId) =>
              Effect.gen(function* () {
                const messageID = yield* send(notice, deliveryId);
                deliveries.push({ notice, deliveryId });
                return messageID;
              }),
          }),
        ),
      );

      return {
        handleEvent,
        deliveries,
        contextReads: () => contextReads,
        completionQueries: () => completionQueries,
      };
    });

  for (const announcementFails of [false, true]) {
    it.effect(
      announcementFails
        ? "keeps toggled preferences when state announcement fails"
        : "announces the saved state when toggling notifications on and off",
      () =>
        Effect.gen(function* () {
          const sessionID = Session.ID.make("ses_test");
          const preferences = new Map<string, Schema.Json>();
          const changes: Array<{
            sessionID: string;
            enabled: boolean;
            saved: Schema.Json | undefined;
          }> = [];
          let execute: CommandDefinition["execute"] | undefined;

          yield* registerCommands({
            command: {
              transform: (edit) =>
                Effect.sync(() => {
                  edit({
                    add: (definition) => {
                      execute = definition.execute;
                    },
                  });
                  return { dispose: Effect.void };
                }),
            },
            storage: {
              get: (key) => Effect.sync(() => preferences.get(key)),
              set: (key, value) =>
                Effect.sync(() => {
                  preferences.set(key, value);
                }),
            },
            events: {
              emit: (_name, state) =>
                Effect.gen(function* () {
                  changes.push({
                    ...state,
                    saved: preferences.get(notificationKey(sessionID)),
                  });
                  if (announcementFails) {
                    return yield* Effect.fail("fake-announcement-failure");
                  }
                }),
            },
          });

          if (execute === undefined) {
            throw new Error("Lark Ping command was not registered");
          }

          const input: Parameters<CommandDefinition["execute"]>[0] = {
            sessionID,
            prompt: { text: "" },
            delivery: "steer",
          };

          yield* execute(input);
          expect(preferences.get(notificationKey(sessionID))).toBe(true);
          yield* execute(input);
          expect(preferences.get(notificationKey(sessionID))).toBe(false);

          expect(changes).toEqual([
            { sessionID: "ses_test", enabled: true, saved: true },
            { sessionID: "ses_test", enabled: false, saved: false },
          ]);
        }),
    );
  }

  it.effect("sends Done without reading timing when filtering is disabled", () =>
    Effect.gen(function* () {
      const { location, info, event } = yield* fixtures;
      const test = yield* setup(info, location, 0);

      yield* test.handleEvent(event);
      expect(test.contextReads()).toBe(0);
      expect(test.deliveries).toEqual([
        {
          deliveryId: event.id,
          notice: {
            _tag: "Done",
            session: { project: "lark-ping", title: "Build notifications" },
          },
        },
      ]);
    }),
  );

  for (const preference of [undefined, false]) {
    it.effect(
      `suppresses Done and Blocked when preference is ${preference}, then sends when enabled`,
      () =>
        Effect.gen(function* () {
          const { location, info, event, blocked } = yield* fixtures;
          let enabled = preference;
          const test = yield* setup(info, location, 300_000, {
            storage: { get: () => Effect.sync(() => enabled) },
          });

          yield* test.handleEvent(event);
          yield* test.handleEvent(blocked);

          expect(test.deliveries).toEqual([]);
          expect(test.contextReads()).toBe(0);
          expect(test.completionQueries()).toBe(0);

          enabled = true;
          yield* test.handleEvent(event);
          yield* test.handleEvent(blocked);

          expect(test.deliveries).toEqual([
            {
              deliveryId: "evt_done",
              notice: expect.objectContaining({ _tag: "Done" }),
            },
            {
              deliveryId: "evt_blocked",
              notice: expect.objectContaining({ _tag: "Blocked" }),
            },
          ]);
        }),
    );
  }

  it.effect("suppresses completion without needing subagent start events", () =>
    Effect.gen(function* () {
      const { location, info, event, followup } = yield* fixtures;
      let running = true;
      const test = yield* setup(info, location, 0, {
        hasRunningSubagents: (sessionID) => {
          expect(sessionID).toBe(info.id);
          return Effect.sync(() => running);
        },
      });
      yield* test.handleEvent(event);
      expect(test.deliveries).toEqual([]);
      running = false;
      yield* test.handleEvent(followup);
      expect(test.deliveries).toEqual([
        { deliveryId: followup.id, notice: expect.objectContaining({ _tag: "Done" }) },
      ]);
    }),
  );

  for (const outcome of ["succeeded", "failed", "interrupted"] as const) {
    it.effect(`does not replay completion when the last subagent is ${outcome}`, () =>
      Effect.gen(function* () {
        const { location, info, event, blocked, followup } = yield* fixtures;
        const child = { ...info, id: Session.ID.make("ses_child"), parentID: info.id };
        let running = true;
        const test = yield* setup(info, location, 0, {
          hasRunningSubagents: () => Effect.sync(() => running),
          get: ({ sessionID }) => Effect.succeed(sessionID === info.id ? info : child),
        });
        const started = yield* Schema.decodeEffect(SessionEvent.Execution.Started)({
          ...event,
          type: "session.execution.started",
          data: { sessionID: child.id },
        });
        yield* test.handleEvent(started);
        yield* test.handleEvent(event);
        expect(test.deliveries).toEqual([]);
        yield* test.handleEvent({ ...started, data: { sessionID: info.id } });
        const terminal =
          outcome === "succeeded"
            ? { ...event, data: { sessionID: child.id } }
            : outcome === "failed"
              ? { ...blocked, data: { ...blocked.data, sessionID: child.id } }
              : yield* Schema.decodeEffect(SessionEvent.Execution.Interrupted)({
                  ...event,
                  type: "session.execution.interrupted",
                  data: { sessionID: child.id, reason: "user" },
                });
        running = false;
        yield* test.handleEvent(terminal);
        yield* test.handleEvent(terminal);
        expect(test.deliveries).toEqual([]);
        yield* test.handleEvent(followup);
        expect(test.deliveries).toEqual([
          { deliveryId: followup.id, notice: expect.objectContaining({ _tag: "Done" }) },
        ]);
      }),
    );
  }

  it.effect(
    "withholds completion when the query fails and retries on the next main completion",
    () =>
      Effect.gen(function* () {
        const { location, info, event, followup } = yield* fixtures;
        let fails = true;
        const test = yield* setup(info, location, 0, {
          hasRunningSubagents: () =>
            Effect.suspend(() =>
              fails
                ? Effect.fail(new CompletionCheckError({ message: "fake-query-failure" }))
                : Effect.succeed(false),
            ),
        });
        yield* test.handleEvent(event);
        expect(test.deliveries).toEqual([]);
        fails = false;
        yield* test.handleEvent(followup);
        expect(test.deliveries).toHaveLength(1);
      }),
  );

  it.effect("enabling one session leaves another session muted", () =>
    Effect.gen(function* () {
      const { location, info, event } = yield* fixtures;
      const other = yield* Schema.decodeEffect(SessionEvent.Execution.Succeeded)({
        type: "session.execution.succeeded",
        id: "evt_other",
        created: 1000,
        data: { sessionID: "ses_other" },
        durable: { aggregateID: "ses_other", seq: 1, version: 1 },
      });
      const preferences = new Map([[notificationKey(info.id), true]]);
      const test = yield* setup(info, location, 0, {
        get: ({ sessionID }) => Effect.succeed({ ...info, id: sessionID }),
        storage: {
          get: (key) => Effect.succeed(preferences.get(key)),
        },
      });

      yield* test.handleEvent(event);
      yield* test.handleEvent(other);

      expect(test.deliveries).toEqual([
        {
          deliveryId: "evt_done",
          notice: expect.objectContaining({ _tag: "Done" }),
        },
      ]);
    }),
  );

  it.effect("skips short Done turns but sends at the threshold", () =>
    Effect.gen(function* () {
      const { location, info, event } = yield* fixtures;
      const messages = yield* Schema.decodeEffect(Schema.Array(SessionMessage.Info))([
        {
          id: "msg_prompt",
          type: "user",
          text: "fake-text",
          time: { created: 0 },
        },
        {
          id: "msg_assistant",
          type: "assistant",
          agent: "build",
          model: { id: "test-model", providerID: "test-provider" },
          content: [],
          time: { created: 0, completed: 2000 },
        },
        {
          id: "msg_done",
          type: "idle",
          outcome: "succeeded",
          time: { created: 2000 },
        },
      ]);
      const context = () => Effect.succeed(messages);
      const short = yield* setup(info, location, 2001, { context });
      const boundary = yield* setup(info, location, 2000, { context });

      yield* short.handleEvent(event);
      yield* boundary.handleEvent(event);

      expect(short.deliveries).toEqual([]);
      expect(boundary.deliveries).toEqual([
        {
          deliveryId: "evt_done",
          notice: expect.objectContaining({ _tag: "Done" }),
        },
      ]);
    }),
  );

  it.effect("sends Done when timing is unknown", () =>
    Effect.gen(function* () {
      const { location, info, event } = yield* fixtures;
      const test = yield* setup(info, location, 300_000);

      yield* test.handleEvent(event);

      expect(test.contextReads()).toBe(1);
      expect(test.deliveries).toEqual([
        {
          deliveryId: "evt_done",
          notice: expect.objectContaining({ _tag: "Done" }),
        },
      ]);
    }),
  );

  it.effect("sends Done when context retrieval fails", () =>
    Effect.gen(function* () {
      const { location, info, event } = yield* fixtures;
      const test = yield* setup(info, location, 300_000, {
        context: () => Schema.decodeUnknownEffect(Schema.Array(SessionMessage.Info))(null),
      });

      yield* test.handleEvent(event);

      expect(test.deliveries).toEqual([
        {
          deliveryId: "evt_done",
          notice: expect.objectContaining({ _tag: "Done" }),
        },
      ]);
    }),
  );

  it.effect("sends Blocked without reading timing when filtering is enabled", () =>
    Effect.gen(function* () {
      const { location, info, blocked } = yield* fixtures;
      const test = yield* setup(info, location, 300_000);

      yield* test.handleEvent(blocked);

      expect(test.contextReads()).toBe(0);
      expect(test.completionQueries()).toBe(0);
      expect(test.deliveries).toEqual([
        {
          deliveryId: "evt_blocked",
          notice: expect.objectContaining({ _tag: "Blocked" }),
        },
      ]);
    }),
  );

  for (const scope of ["other directory", "child session"] as const) {
    it.effect(`ignores a ${scope} but sends for a local root session`, () =>
      Effect.gen(function* () {
        const { location, info, event } = yield* fixtures;
        const excluded =
          scope === "other directory"
            ? {
                ...info,
                location: yield* Schema.decodeEffect(Location.Ref)({
                  directory: "/projects/other",
                }),
              }
            : { ...info, parentID: Session.ID.make("ses_parent") };
        const ignored = yield* setup(excluded, location, 0);
        const included = yield* setup(info, location, 0);

        yield* ignored.handleEvent(event);
        yield* included.handleEvent(event);

        expect(ignored.deliveries).toEqual([]);
        expect(ignored.contextReads()).toBe(0);
        expect(ignored.completionQueries()).toBe(0);
        expect(included.deliveries).toEqual([
          {
            deliveryId: "evt_done",
            notice: expect.objectContaining({ _tag: "Done" }),
          },
        ]);
      }),
    );
  }

  it.effect("continues with a later event after session retrieval fails", () =>
    Effect.gen(function* () {
      const { location, info, event, blocked } = yield* fixtures;
      let reads = 0;
      const test = yield* setup(info, location, 0, {
        get: () =>
          Effect.suspend(() => {
            reads++;
            return reads === 1
              ? Schema.decodeUnknownEffect(Session.Info)(null)
              : Effect.succeed(info);
          }),
      });

      yield* test.handleEvent(event);
      yield* test.handleEvent(blocked);

      expect(test.deliveries).toEqual([
        {
          deliveryId: "evt_blocked",
          notice: expect.objectContaining({ _tag: "Blocked" }),
        },
      ]);
    }),
  );

  it.effect("continues with a later event after delivery fails", () =>
    Effect.gen(function* () {
      const { location, info, event, blocked } = yield* fixtures;
      let attempts = 0;
      const test = yield* setup(info, location, 0, {}, () =>
        Effect.gen(function* () {
          attempts++;
          if (attempts === 1) {
            return yield* new DeliveryError({ message: "fake-failure" });
          }
          return "fake-message-id";
        }),
      );

      yield* test.handleEvent(event);
      yield* test.handleEvent(blocked);

      expect(test.deliveries).toEqual([
        {
          deliveryId: "evt_blocked",
          notice: expect.objectContaining({ _tag: "Blocked" }),
        },
      ]);
    }),
  );
});
