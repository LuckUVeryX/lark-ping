import type { Plugin } from "@opencode/plugin/tui";

import { LarkPingRpc } from "./src/rpc";

export default {
  id: "lark-ping.tui",
  setup(ctx) {
    const rpc = ctx.client.rpc(LarkPingRpc);

    return rpc.events.on("changed", (event) => {
      const location = ctx.location ?? ctx.data.location.default();
      const route = ctx.ui.router.current();

      if (
        event.location.directory !== location.directory ||
        route.type !== "session" ||
        route.sessionID !== event.data.sessionID
      ) {
        return;
      }

      ctx.ui.toast.show({
        message: `Lark Ping ${event.data.enabled ? "on" : "off"}`,
        variant: "info",
        duration: 3000,
      });
    });
  },
} satisfies Plugin.Definition;
