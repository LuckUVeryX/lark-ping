import { describe, expect, it } from "@effect/vitest";
import { Form, Permission, SessionMessage } from "@opencode/schema";
import { SessionEvent } from "@opencode/schema/session-event";
import { Option, Schema } from "effect";

import { notificationIntent, turnDurationMs } from "../src/notification";

describe("turnDurationMs", () => {
  const prompt = (id: string, created: number) =>
    Schema.decodeSync(SessionMessage.User)({
      id,
      type: "user",
      text: "fake-text",
      time: { created },
    });

  const assistant = (id: string, created: number, completed?: number) =>
    Schema.decodeSync(SessionMessage.Assistant)({
      id,
      type: "assistant",
      agent: "build",
      model: { id: "test-model", providerID: "test-provider" },
      content: [],
      time: {
        created,
        ...(completed === undefined ? {} : { completed }),
      },
    });

  const idle = (id: string, created: number) =>
    Schema.decodeSync(SessionMessage.Idle)({
      id,
      type: "idle",
      outcome: "succeeded",
      time: { created },
    });

  const completionID = SessionMessage.ID.make("msg_completion");

  it("returns the duration of a completed turn", () => {
    const messages = [
      prompt("msg_prompt", 0),
      assistant("msg_assistant", 1000, 2000),
      idle("msg_completion", 2100),
    ];
    expect(turnDurationMs(messages, completionID)).toEqual(Option.some(2000));
  });

  it("uses the first prompt and final assistant completion across steering", () => {
    const messages = [
      prompt("msg_prompt", 0),
      assistant("msg_first_assistant", 1000, 2000),
      prompt("msg_steering", 3000),
      assistant("msg_final_assistant", 4000, 6000),
      idle("msg_completion", 6100),
    ];

    expect(turnDurationMs(messages, completionID)).toEqual(Option.some(6000));
  });

  it("excludes messages from the previous turn", () => {
    const messages = [
      prompt("msg_previous_prompt", 0),
      assistant("msg_previous_assistant", 1000, 2000),
      idle("msg_previous_idle", 2100),
      prompt("msg_prompt", 10_000),
      assistant("msg_assistant", 11_000, 12_000),
      idle("msg_completion", 12_100),
    ];

    expect(turnDurationMs(messages, completionID)).toEqual(Option.some(2000));
  });

  it("measures the requested turn even when a newer turn exists", () => {
    const messages = [
      prompt("msg_prompt", 0),
      assistant("msg_assistant", 1000, 2000),
      idle("msg_completion", 2100),
      prompt("msg_new_prompt", 3000),
      assistant("msg_new_assistant", 4000, 9000),
      idle("msg_new_idle", 9100),
    ];

    expect(turnDurationMs(messages, completionID)).toEqual(Option.some(2000));
  });

  it("supports turns started by synthetic input", () => {
    const synthetic = Schema.decodeSync(SessionMessage.Synthetic)({
      id: "msg_synthetic",
      type: "synthetic",
      text: "fake-text",
      time: { created: 1000 },
    });

    const messages = [
      synthetic,
      assistant("msg_assistant", 2000, 5000),
      idle("msg_completion", 5100),
    ];

    expect(turnDurationMs(messages, completionID)).toEqual(Option.some(4000));
  });

  it("returns unknown timing when the turn includes completed compaction", () => {
    const compaction = Schema.decodeSync(SessionMessage.CompactionCompleted)({
      id: "msg_compaction",
      type: "compaction",
      status: "completed",
      reason: "auto",
      summary: "fake-summary",
      recent: "fake-recent",
      time: { created: 2000 },
    });

    const messages = [
      compaction,
      prompt("msg_steering", 3000),
      assistant("msg_assistant", 4000, 6000),
      idle("msg_completion", 6100),
    ];

    expect(turnDurationMs(messages, completionID)).toEqual(Option.none());
  });

  it("returns unknown timing when the completion marker is missing", () => {
    const messages = [prompt("msg_prompt", 0), assistant("msg_assistant", 1000, 2000)];

    expect(turnDurationMs(messages, completionID)).toEqual(Option.none());
  });

  it("returns unknown timing when the prompt is missing", () => {
    const messages = [assistant("msg_assistant", 1000, 2000), idle("msg_completion", 2100)];

    expect(turnDurationMs(messages, completionID)).toEqual(Option.none());
  });

  it("returns unknown timing when no assistant has completed", () => {
    const messages = [
      prompt("msg_prompt", 0),
      assistant("msg_assistant", 1000),
      idle("msg_completion", 2100),
    ];

    expect(turnDurationMs(messages, completionID)).toEqual(Option.none());
  });

  it("returns unknown timing when completion precedes the prompt", () => {
    const messages = [
      prompt("msg_prompt", 3000),
      assistant("msg_assistant", 1000, 2000),
      idle("msg_completion", 3100),
    ];

    expect(turnDurationMs(messages, completionID)).toEqual(Option.none());
  });
});

describe("notificationIntent", () => {
  it("maps session.execution.succeeded to Done", () => {
    const event = Schema.decodeSync(SessionEvent.Execution.Succeeded)({
      type: "session.execution.succeeded",
      data: {
        sessionID: "ses_fake-session-id",
      },
      id: "evt_fake-event-id",
      created: 1,
      durable: {
        aggregateID: "ses_fake-session-id",
        seq: 1,
        version: 1,
      },
    });

    const intent = notificationIntent(event);

    expect(intent).toEqual(Option.some({ kind: "Done", sessionID: "ses_fake-session-id" }));
  });

  it("maps session.execution.failed to Blocked", () => {
    const event = Schema.decodeSync(SessionEvent.Execution.Failed)({
      type: "session.execution.failed",
      id: "evt_fake-event-id",
      created: 1,
      durable: {
        aggregateID: "ses_fake-session-id",
        seq: 1,
        version: 1,
      },
      data: {
        sessionID: "ses_fake-session-id",
        error: {
          type: "FAKE_ERROR",
          message: "fake-error",
        },
      },
    });

    const intent = notificationIntent(event);

    expect(intent).toEqual(Option.some({ kind: "Blocked", sessionID: "ses_fake-session-id" }));
  });

  it("maps permission.asked to Blocked", () => {
    const event = Schema.decodeSync(Permission.Event.Asked)({
      type: "permission.asked",
      id: "evt_fake-event-id",
      created: 1,
      data: {
        sessionID: "ses_fake-session-id",
        id: "perm_fake-permission-id",
        action: "fake-action",
        resources: [],
      },
    });

    const intent = notificationIntent(event);

    expect(intent).toEqual(Option.some({ kind: "Blocked", sessionID: "ses_fake-session-id" }));
  });

  it.each([
    {
      name: "maps session-owned forms to Blocked",
      sessionID: "ses_fake-session-id",
      expected: Option.some({
        kind: "Blocked",
        sessionID: "ses_fake-session-id",
      }),
    },
    {
      name: "ignores forms without a session owner",
      sessionID: "global",
      expected: Option.none(),
    },
  ])("$name", ({ sessionID, expected }) => {
    const event = Schema.decodeSync(Form.Event.Created)({
      type: "form.created",
      id: "evt_fake-event-id",
      created: 1,
      data: {
        form: {
          id: "frm_form-id",
          sessionID,
          fields: [
            {
              type: "boolean",
              key: "fake-key",
            },
          ],
          title: "fake-title",
        },
      },
    });

    expect(notificationIntent(event)).toEqual(expected);
  });

  it("ignores interrupted executions", () => {
    const event = Schema.decodeSync(SessionEvent.Execution.Interrupted)({
      type: "session.execution.interrupted",
      id: "evt_fake-event-id",
      created: 1,
      durable: {
        aggregateID: "ses_fake-session-id",
        seq: 1,
        version: 1,
      },
      data: {
        sessionID: "ses_fake-session-id",
        reason: "user",
      },
    });

    const intent = notificationIntent(event);

    expect(intent).toEqual(Option.none());
  });
});
