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

// Game leaderboard: one row per name (case-insensitive), keeping that name's best score.
export class Leaderboard extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS scores (
      key TEXT PRIMARY KEY, name TEXT NOT NULL, score INTEGER NOT NULL, level INTEGER NOT NULL, ts INTEGER NOT NULL)`);
  }

  top(limit = 10) {
    return this.sql.exec(
      "SELECT name, score, level FROM scores ORDER BY score DESC, ts ASC LIMIT ?", limit).toArray();
  }

  submit(name, score, level) {
    const key = name.toLowerCase();
    this.sql.exec(
      `INSERT INTO scores (key, name, score, level, ts) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET name = excluded.name, score = excluded.score,
         level = excluded.level, ts = excluded.ts
       WHERE excluded.score > scores.score`,
      key, name, score, level, Date.now());
    const row = this.sql.exec("SELECT score, ts FROM scores WHERE key = ?", key).one();
    const rank = this.sql.exec(
      "SELECT COUNT(*) AS n FROM scores WHERE score > ? OR (score = ? AND ts < ?)",
      row.score, row.score, row.ts).one().n + 1;
    return { top: this.top(), rank, best: row.score };
  }

  remove(name) {
    this.sql.exec("DELETE FROM scores WHERE key = ?", name.toLowerCase());
    return { top: this.top() };
  }
}

// Trim, drop control characters, collapse spaces, max 16 characters.
function cleanName(raw) {
  if (typeof raw !== "string") return "";
  return [...raw.replace(/[\p{C}]/gu, "").replace(/\s+/g, " ").trim()].slice(0, 16).join("").trim();
}

// Highest score the game can award by the end of `level` (level bonus + max time + 1st place + no-zap bonus).
function maxScore(level) {
  return 250 * level * (level + 1) + 2900 * level;
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
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request.headers.get("Origin"));
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(request.url);
    const { pathname } = url;
    const json = (data, status = 200) =>
      Response.json(data, { status, headers: { ...cors, "Cache-Control": "no-store" } });

    if (pathname === "/leaderboard") {
      const board = env.LEADERBOARD.get(env.LEADERBOARD.idFromName("game"));
      if (request.method === "GET") return json({ top: await board.top() });
      if (request.method === "POST") {
        let body;
        try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
        const name = cleanName(body.name);
        const score = body.score, level = body.level;
        if (!name) return json({ error: "name required" }, 400);
        if (!Number.isInteger(level) || level < 1 || level > 500 ||
            !Number.isInteger(score) || score < 1 || score > maxScore(level)) {
          return json({ error: "invalid score" }, 400);
        }
        return json(await board.submit(name, score, level));
      }
      if (request.method === "DELETE") {
        if (!env.ADMIN_KEY || request.headers.get("Authorization") !== `Bearer ${env.ADMIN_KEY}`) {
          return json({ error: "unauthorized" }, 401);
        }
        return json(await board.remove(url.searchParams.get("name") || ""));
      }
      return json({ error: "method not allowed" }, 405);
    }

    const counter = env.COUNTER.get(env.COUNTER.idFromName("celebrate"));

    let count;
    if (pathname === "/count" && request.method === "GET") count = await counter.get();
    else if (pathname === "/hit" && request.method === "POST") count = await counter.hit();
    else return new Response("Not found", { status: 404, headers: cors });

    return Response.json({ count }, { headers: { ...cors, "Cache-Control": "no-store" } });
  },
};
