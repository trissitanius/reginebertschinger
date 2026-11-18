import { DurableObject } from "cloudflare:workers";

// A single Durable Object instance holds the total. It handles one request
// at a time, so simultaneous clicks are never lost.
export class Counter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.count = (await ctx.storage.get("count")) ?? 0;
    });
  }

  async get() {
    return this.count;
  }

  async hit() {
    this.count++;
    await this.ctx.storage.put("count", this.count);
    return this.count;
  }
}

const ALLOWED_ORIGINS = [
  "https://reginebertschinger.com",
  "https://www.reginebertschinger.com",
];
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function corsHeaders(origin) {
  const ok = origin && (ALLOWED_ORIGINS.includes(origin) || LOCAL_ORIGIN.test(origin));
  return {
    "Access-Control-Allow-Origin": ok ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request.headers.get("Origin"));
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const { pathname } = new URL(request.url);
    const counter = env.COUNTER.get(env.COUNTER.idFromName("celebrate"));

    let count;
    if (pathname === "/count" && request.method === "GET") count = await counter.get();
    else if (pathname === "/hit" && request.method === "POST") count = await counter.hit();
    else return new Response("Not found", { status: 404, headers: cors });

    return Response.json({ count }, { headers: { ...cors, "Cache-Control": "no-store" } });
  },
};
