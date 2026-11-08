import { Hono } from "hono";
import { cors } from "hono/cors";

type Bindings = { DB: D1Database };

const app = new Hono<{ Bindings: Bindings }>().basePath("/api/v1");

app.use("*", cors());

// A game week opens with Tuesday's games and runs through Saturday (`end`). Queries also take in
// the Sunday and Monday after, so a rare holiday game lands with the week before it. Sources
// without archives never store a week number, so weeks are keyed by their Tuesday and numbered
// from whichever rows in that window carry one.
const WEEK_START_SQL = "date(game_date, '+1 day', 'weekday 2', '-7 days')";
const DAY_MS = 86_400_000;
const WEEKS_TTL_MS = 5 * 60_000;
// How far a stored week number is extrapolated to unnumbered weeks; keeps it inside one season.
const MAX_EXTRAPOLATE_DAYS = 140;

type Week = { week: number | null; start: string; end: string };
const QUERY_DAYS = 6; // Tuesday + 6 = Monday

const addDays = (date: string, days: number) =>
  new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);
const weekStart = (date: string) => addDays(date, -((new Date(date).getUTCDay() + 5) % 7));

let weeksCache: { at: number; weeks: Week[] } | null = null;

/** Every week with a report or an injury, latest first. */
async function loadWeeks(db: D1Database): Promise<Week[]> {
  if (weeksCache && Date.now() - weeksCache.at < WEEKS_TTL_MS) return weeksCache.weeks;
  const { results } = await db
    .prepare(
      `SELECT start, MAX(week) AS week FROM (
         SELECT ${WEEK_START_SQL} AS start, week FROM injuries
         UNION ALL
         SELECT ${WEEK_START_SQL}, NULL FROM team_reports
       ) GROUP BY start ORDER BY start DESC`,
    )
    .all<{ start: string; week: number | null }>();
  const known = results.filter((r) => r.week !== null);
  const weeks = results.map(({ start, week }) => {
    if (week === null) {
      const nearest = known.reduce<(typeof known)[number] | null>(
        (best, k) =>
          !best || Math.abs(daysBetween(k.start, start)) < Math.abs(daysBetween(best.start, start)) ? k : best,
        null,
      );
      if (nearest && Math.abs(daysBetween(nearest.start, start)) <= MAX_EXTRAPOLATE_DAYS) {
        week = nearest.week! + daysBetween(nearest.start, start) / 7;
      }
    }
    return { week, start, end: addDays(start, 4) };
  });
  weeksCache = { at: Date.now(), weeks };
  return weeks;
}

/** `value` is a week number (the latest season's) or any date inside the week; empty = latest. */
function findWeek(weeks: Week[], value: string | undefined): Week | undefined {
  if (!value) return weeks[0];
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const start = weekStart(value);
    return weeks.find((w) => w.start === start) ?? { week: null, start, end: addDays(start, 4) };
  }
  return weeks.find((w) => String(w.week) === value);
}

// Archive backfills have no positions or numbers, and the roster fill only reaches current
// players, so a gap is filled from the same player's other rows.
const fillFromPlayer = (column: string) => `coalesce(i.${column}, (
  SELECT p.${column} FROM injuries p
  WHERE p.conference = i.conference AND p.team = i.team AND p.player = i.player AND p.${column} IS NOT NULL
  ORDER BY p.game_date DESC LIMIT 1)) AS ${column}`;

const INJURY_SELECT = `
  SELECT i.id, i.conference, i.team, i.player, ${fillFromPlayer("number")}, ${fillFromPlayer("position")},
         i.opponent, i.game_date, i.injury, i.current_status, i.current_rank, i.source_url, i.updated_at,
         (SELECT json_group_array(json_object('label', label, 'status', status, 'status_raw', status_raw,
                                              'rank', status_rank))
          FROM (SELECT * FROM status_updates WHERE injury_id = i.id ORDER BY seq)) AS updates
  FROM injuries i`;

type InjuryRow = {
  id: number;
  conference: string;
  team: string;
  player: string;
  number: string | null;
  position: string | null;
  opponent: string | null;
  game_date: string;
  injury: string | null;
  current_status: string | null;
  current_rank: number | null;
  source_url: string | null;
  updated_at: string;
  updates: string; // JSON array, parsed by withHistory
};

const withHistory = (row: InjuryRow, weeks: Week[]) => ({
  ...row,
  week: weeks.find((w) => w.start <= row.game_date && row.game_date <= addDays(w.start, QUERY_DAYS))?.week ?? null,
  updates: JSON.parse(row.updates) as { label: string; status: string; status_raw: string | null; rank: number }[],
});

app.get("/conferences", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT conference, COUNT(*) AS injuries, MAX(updated_at) AS updated_at FROM injuries GROUP BY conference",
  ).all();
  return c.json({ data: results });
});

app.get("/weeks", async (c) => {
  return c.json({ data: await loadWeeks(c.env.DB) });
});

// GET /api/v1/games?week=10&conference=B10 (or team=Northwestern; or neither, for every game)
// Each game pairs both teams' reports for the week, injured players with their status history.
app.get("/games", async (c) => {
  const { week: weekParam, conference, team } = c.req.query();
  const week = findWeek(await loadWeeks(c.env.DB), weekParam);
  if (!week) return c.json({ error: "unknown week" }, 404);

  const [reports, injuries] = await c.env.DB.batch([
    c.env.DB.prepare(
      "SELECT conference, team, opponent, game_date, label FROM team_reports WHERE game_date BETWEEN ? AND ? ORDER BY seq",
    ).bind(week.start, addDays(week.start, QUERY_DAYS)),
    c.env.DB.prepare(`${INJURY_SELECT} WHERE i.game_date BETWEEN ? AND ? ORDER BY i.current_rank DESC, i.player`).bind(
      week.start,
      addDays(week.start, QUERY_DAYS),
    ),
  ]);
  const weeks = [week];

  type Side = {
    conference: string;
    team: string;
    opponent: string | null;
    reports: string[];
    players: ReturnType<typeof withHistory>[];
  };
  const sides = new Map<string, Side>();
  const sideFor = (r: { conference: string; team: string; opponent: string | null; game_date: string }) => {
    const key = `${r.game_date}|${r.team}`;
    let side = sides.get(key);
    if (!side) {
      side = { conference: r.conference, team: r.team, opponent: r.opponent, reports: [], players: [] };
      sides.set(key, side);
    }
    side.opponent ??= r.opponent;
    return side;
  };
  for (const r of reports.results as { conference: string; team: string; opponent: string | null; game_date: string; label: string }[]) {
    sideFor(r).reports.push(r.label);
  }
  for (const r of injuries.results as InjuryRow[]) sideFor(r).players.push(withHistory(r, weeks));

  const games = new Map<string, { game_date: string; teams: Side[] }>();
  for (const [key, side] of sides) {
    const game_date = key.slice(0, 10);
    const gameKey = `${game_date}|${[side.team, side.opponent ?? ""].sort().join("|")}`;
    const game = games.get(gameKey) ?? { game_date, teams: [] };
    game.teams.push(side);
    games.set(gameKey, game);
  }

  const data = [...games.values()]
    .filter(
      (g) =>
        (!conference || g.teams.some((s) => s.conference === conference)) &&
        (!team || g.teams.some((s) => s.team === team || s.opponent === team)),
    )
    .map((g) => ({ ...g, teams: g.teams.sort((a, b) => a.team.localeCompare(b.team)) }))
    .sort((a, b) => a.game_date.localeCompare(b.game_date) || a.teams[0].team.localeCompare(b.teams[0].team));
  return c.json({ week, data });
});

// GET /api/v1/players?q=smith — players with any injury row, most recently listed first.
app.get("/players", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (q.length < 2) return c.json({ data: [] });
  const { results } = await c.env.DB.prepare(
    `SELECT conference, team, player, MAX(position) AS position, COUNT(*) AS games, MAX(game_date) AS last_game_date
     FROM injuries WHERE player LIKE ? ESCAPE '\\'
     GROUP BY conference, team, player ORDER BY last_game_date DESC LIMIT 25`,
  )
    .bind(`%${q.replace(/[\\%_]/g, "\\$&")}%`)
    .all();
  return c.json({ data: results });
});

// GET /api/v1/injuries?conference=B10&team=Northwestern&player=...&status=Out&week=4&limit=100&cursor=...
async function listInjuries(db: D1Database, q: Record<string, string>) {
  const weeks = await loadWeeks(db);
  const where: string[] = [];
  const params: (string | number)[] = [];
  for (const key of ["conference", "team", "player"] as const) {
    if (q[key]) {
      where.push(`i.${key} = ?`);
      params.push(q[key]);
    }
  }
  if (q.status) {
    where.push("i.current_status = ?");
    params.push(q.status);
  }
  if (q.week) {
    const week = findWeek(weeks, q.week);
    if (!week) return { data: [], next: null };
    where.push("i.game_date BETWEEN ? AND ?");
    params.push(week.start, addDays(week.start, QUERY_DAYS));
  }
  if (q.cursor) {
    where.push("i.id > ?");
    params.push(Number(q.cursor));
  }
  const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
  const { results } = await db
    .prepare(`${INJURY_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY i.id LIMIT ?`)
    .bind(...params, limit + 1)
    .all<InjuryRow>();
  const page = results.slice(0, limit);
  return {
    data: page.map((r) => withHistory(r, weeks)),
    next: results.length > limit ? String(page[page.length - 1].id) : null,
  };
}

app.get("/injuries", async (c) => c.json(await listInjuries(c.env.DB, c.req.query())));

app.get("/teams/:team/injuries", async (c) =>
  c.json(await listInjuries(c.env.DB, { ...c.req.query(), team: c.req.param("team") })),
);

export default app;
