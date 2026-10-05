import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import type { Session } from "@opencode/schema";
import { Effect, Schema } from "effect";

export class CompletionCheckError extends Schema.TaggedError<CompletionCheckError>()(
  "CompletionCheckError",
  { message: Schema.String },
) {}

export const makeRunningCheck =
  (discover = Service.discover) =>
  (sessionID: Session.ID) =>
    Effect.tryPromise({
      try: async (signal) => {
        const endpoint = await discover();
        if (!endpoint) throw new Error("OpenCode service unavailable");

        const client = OpenCode.make({
          baseUrl: endpoint.url,
          headers: Service.headers(endpoint),
        });
        const request = { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) };
        const server = await client.server.info(request);
        if (server.pid !== process.pid) throw new Error("OpenCode service is not the plugin host");

        const active = await client.session.active(request);
        for (const id of Object.keys(active)) {
          if (id === sessionID) continue;
          let currentID: string | undefined = id;
          const visited = new Set<string>();
          while (currentID !== undefined) {
            if (currentID === sessionID) return true;
            if (visited.has(currentID)) throw new Error("Cyclic session ancestry");
            visited.add(currentID);
            const current = await client.session.get({ sessionID: currentID }, request);
            currentID = current.parentID;
          }
        }
        return false;
      },
      catch: () => new CompletionCheckError({ message: "Could not query running subagents" }),
    });
