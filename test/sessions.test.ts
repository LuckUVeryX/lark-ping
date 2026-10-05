import { describe, expect, it } from "@effect/vitest";
import { Session } from "@opencode/schema";
import { Effect, Exit } from "effect";
import { afterEach, vi } from "vitest";

import { makeRunningCheck } from "../src/sessions";

describe("running subagent query", () => {
  afterEach(() => vi.restoreAllMocks());

  const mainID = Session.ID.make("ses_main");
  const endpoint = {
    url: "http://localhost:4096",
    auth: { type: "basic" as const, username: "opencode", password: "fake-password" },
  };

  const serve = (
    active: Record<string, { type: "running" }>,
    parents: Record<string, string | undefined> = {},
    pid = process.pid,
  ) => {
    const paths: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Basic ${Buffer.from("opencode:fake-password").toString("base64")}`,
      );
      const path = new URL(url instanceof Request ? url.url : url).pathname;
      paths.push(path);
      if (path === "/api/info")
        return Response.json({ pid, version: "2.0.22", urls: [], paths: { tmp: "/test" } });
      if (path === "/api/session/active") return Response.json({ data: active });
      const id = path.slice("/api/session/".length);
      if (!(id in parents)) return new Response(null, { status: 500 });
      return Response.json({ data: { id, parentID: parents[id] } });
    });
    return paths;
  };

  for (const nested of [false, true]) {
    it.effect(`finds a running ${nested ? "nested " : ""}subagent without start events`, () =>
      Effect.gen(function* () {
        serve(
          { ses_child: { type: "running" } },
          {
            ses_child: nested ? "ses_parent" : mainID,
            ses_parent: mainID,
          },
        );
        const check = makeRunningCheck(async () => endpoint);
        expect(yield* check(mainID)).toBe(true);
      }),
    );
  }

  it.effect("ignores the main session and unrelated running agents", () =>
    Effect.gen(function* () {
      const paths = serve(
        { ses_main: { type: "running" }, ses_other_child: { type: "running" } },
        { ses_other_child: "ses_other", ses_other: undefined },
      );
      expect(yield* makeRunningCheck(async () => endpoint)(mainID)).toBe(false);
      expect(paths).not.toContain("/api/session/ses_main");
    }),
  );

  it.effect("reads a fresh snapshot on every main completion", () =>
    Effect.gen(function* () {
      const active: Record<string, { type: "running" }> = { ses_child: { type: "running" } };
      serve(active, { ses_child: mainID });
      const check = makeRunningCheck(async () => endpoint);
      expect(yield* check(mainID)).toBe(true);
      delete active["ses_child"];
      expect(yield* check(mainID)).toBe(false);
    }),
  );

  it.effect("does not query another server's running sessions", () =>
    Effect.gen(function* () {
      const paths = serve({}, {}, process.pid + 1);
      const result = yield* Effect.exit(makeRunningCheck(async () => endpoint)(mainID));
      expect(Exit.isFailure(result)).toBe(true);
      expect(paths).toEqual(["/api/info"]);
    }),
  );

  for (const failure of [
    "missing service",
    "missing ancestor",
    "cyclic ancestry",
    "active query",
  ] as const) {
    it.effect(`fails closed on ${failure}`, () =>
      Effect.gen(function* () {
        serve(
          { ses_child: { type: "running" } },
          failure === "cyclic ancestry" ? { ses_child: "ses_child" } : {},
        );
        if (failure === "active query") {
          const fetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
          vi.mocked(globalThis.fetch).mockImplementation((url, init) =>
            new URL(url instanceof Request ? url.url : url).pathname === "/api/session/active"
              ? Promise.resolve(new Response(null, { status: 503 }))
              : fetch(url, init),
          );
        }
        const check = makeRunningCheck(async () =>
          failure === "missing service" ? undefined : endpoint,
        );
        const result = yield* Effect.exit(check(mainID));
        expect(Exit.isFailure(result)).toBe(true);
        if (failure === "missing service") expect(globalThis.fetch).not.toHaveBeenCalled();
      }),
    );
  }
});
