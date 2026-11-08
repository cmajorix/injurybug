export type Week = { week: number | null; start: string; end: string };

export type StatusUpdate = { label: string; status: string; status_raw: string | null; rank: number };

export type Injury = {
  id: number;
  conference: string;
  team: string;
  player: string;
  number: string | null;
  position: string | null;
  opponent: string | null;
  game_date: string;
  week: number | null;
  injury: string | null;
  current_status: string | null;
  current_rank: number | null;
  updates: StatusUpdate[];
};

export type Side = {
  conference: string;
  team: string;
  opponent: string | null;
  reports: string[]; // report labels released for this team, in order
  players: Injury[];
};

export type Game = { game_date: string; teams: Side[] };

export type PlayerMatch = {
  conference: string;
  team: string;
  player: string;
  position: string | null;
  games: number;
  last_game_date: string;
};

async function get<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> {
  const query = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1]));
  const res = await fetch(`/api/v1${path}${query.size ? `?${query}` : ""}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

export const api = {
  weeks: () => get<{ data: Week[] }>("/weeks").then((r) => r.data),
  games: (week?: string) => get<{ week: Week; data: Game[] }>("/games", { week }),
  players: (q: string) => get<{ data: PlayerMatch[] }>("/players", { q }).then((r) => r.data),
  async playerInjuries(team: string, player: string) {
    const rows: Injury[] = [];
    let cursor: string | null = null;
    do {
      const page: { data: Injury[]; next: string | null } = await get("/injuries", {
        team,
        player,
        limit: "500",
        cursor: cursor ?? undefined,
      });
      rows.push(...page.data);
      cursor = page.next;
    } while (cursor);
    return rows;
  },
};

const dateFmt = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const shortFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export const formatDate = (iso: string) => dateFmt.format(new Date(iso));

export const weekLabel = (w: Week) =>
  `${w.week === null ? "Week of" : `Week ${w.week} ·`} ${shortFmt.format(new Date(w.start))}–${shortFmt.format(new Date(w.end))}`;
