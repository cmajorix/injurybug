import { Hono } from "hono";
import { cors } from "hono/cors";

type Bindings = { DB: D1Database };

const app = new Hono<{ Bindings: Bindings }>().basePath("/api/v1");

app.use("*", cors());

app.get("/conferences", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT conference, COUNT(*) AS injuries, MAX(updated_at) AS updated_at FROM injuries GROUP BY conference",
  ).all();
  return c.json({ data: results });
});

// GET /api/v1/injuries?conference=B10&team=Northwestern&status=Out&week=4&limit=100&cursor=...
app.get("/injuries", async (c) => {
  // TODO: build WHERE clause from query params, keyset-paginate on id via `cursor`,
  // join status_updates (ORDER BY seq) to return each record's history.
  return c.json({ data: [], next: null });
});

app.get("/teams/:team/injuries", async (c) => {
  // TODO
  return c.json({ data: [], next: null });
});

export default app;
