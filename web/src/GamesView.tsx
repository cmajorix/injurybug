import { api, formatDate, weekLabel, type Game, type Side } from "./api";
import { Loading, REPORT_LABELS, StatusCells, useAsync, type Navigate, type Params } from "./common";
import { UNIT_LABELS, unitOf, type Unit } from "./positions";

const UNIT_ORDER: Record<string, Unit[]> = {
  all: ["offense", "defense", "special", "unknown"],
  offense: ["offense"],
  defense: ["defense"],
};

export default function GamesView({ params, navigate }: { params: Params; navigate: Navigate }) {
  const weeks = useAsync(api.weeks, []);
  const weekParam = params.get("week") ?? undefined;
  const games = useAsync(() => api.games(weekParam), [weekParam]);
  const scope = params.get("team") ? `team:${params.get("team")}` : params.get("conf") ? `conf:${params.get("conf")}` : "";
  const unit = params.get("unit") ?? "all";

  const set = (next: Record<string, string | undefined>) => {
    const current = Object.fromEntries(params);
    navigate({ ...current, ...next }, { replace: true });
  };
  const setScope = (value: string) => {
    const [kind, name] = [value.slice(0, value.indexOf(":")), value.slice(value.indexOf(":") + 1)];
    set({ team: kind === "team" ? name : undefined, conf: kind === "conf" ? name : undefined });
  };

  // Teams and conferences come from the week's reports, so the picker only offers ones that played.
  const byConference = new Map<string, Set<string>>();
  for (const g of games.data?.data ?? []) {
    for (const s of g.teams) {
      if (!byConference.has(s.conference)) byConference.set(s.conference, new Set());
      byConference.get(s.conference)!.add(s.team);
    }
  }
  const conferences = [...byConference.keys()].sort();

  const shown = (games.data?.data ?? []).filter((g) => {
    if (scope.startsWith("team:")) return g.teams.some((s) => s.team === scope.slice(5) || s.opponent === scope.slice(5));
    if (scope.startsWith("conf:")) return g.teams.some((s) => s.conference === scope.slice(5));
    return true;
  });

  return (
    <>
      <div className="controls">
        <label>
          <span>Week</span>
          <select value={games.data?.week.start ?? ""} onChange={(e) => set({ week: e.target.value })}>
            {(weeks.data ?? []).map((w) => (
              <option key={w.start} value={w.start}>
                {weekLabel(w)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Team or conference</span>
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="">All games</option>
            <optgroup label="Conferences">
              {conferences.map((c) => (
                <option key={c} value={`conf:${c}`}>
                  {c}
                </option>
              ))}
            </optgroup>
            {conferences.map((c) => (
              <optgroup key={c} label={c}>
                {[...byConference.get(c)!].sort().map((t) => (
                  <option key={t} value={`team:${t}`}>
                    {t}
                  </option>
                ))}
              </optgroup>
            ))}
            {scope && !conferences.some((c) => scope === `conf:${c}` || byConference.get(c)!.has(scope.slice(5))) && (
              <option value={scope}>{scope.slice(5)}</option>
            )}
          </select>
        </label>
        <div className="segmented" role="group" aria-label="Side of the ball">
          {(["all", "offense", "defense"] as const).map((u) => (
            <button key={u} aria-pressed={unit === u} onClick={() => set({ unit: u === "all" ? undefined : u })}>
              {u === "all" ? "All" : UNIT_LABELS[u]}
            </button>
          ))}
        </div>
      </div>

      <Loading state={games}>
        {shown.length === 0 ? (
          <p className="notice">No conference reports for this selection this week.</p>
        ) : (
          <div className={games.loading ? "stale" : undefined}>
            {shown.map((g) => (
              <GameCard key={g.game_date + g.teams.map((t) => t.team).join()} game={g} units={UNIT_ORDER[unit] ?? UNIT_ORDER.all} navigate={navigate} />
            ))}
          </div>
        )}
      </Loading>
    </>
  );
}

function GameCard({ game, units, navigate }: { game: Game; units: Unit[]; navigate: Navigate }) {
  const [first] = game.teams;
  const names = game.teams.length === 2 ? game.teams.map((t) => t.team) : [first.team, first.opponent ?? "TBD"];
  return (
    <section className="game">
      <header className="game-header">
        <h2>
          {names[0]} <span className="vs">vs</span> {names[1]}
        </h2>
        <span className="muted">{formatDate(game.game_date)}</span>
      </header>
      <div className="sides">
        {game.teams.map((side) => (
          <TeamReport key={side.team} side={side} units={units} navigate={navigate} />
        ))}
        {game.teams.length === 1 && first.opponent && (
          <div className="side">
            <h3>{first.opponent}</h3>
            <p className="muted">No conference report (non-conference opponent).</p>
          </div>
        )}
      </div>
    </section>
  );
}

function TeamReport({ side, units, navigate }: { side: Side; units: Unit[]; navigate: Navigate }) {
  const labels = REPORT_LABELS.filter(
    (l) => side.reports.includes(l) || side.players.some((p) => p.updates.some((u) => u.label === l)),
  );
  const groups = units
    .map((unit) => ({ unit, players: side.players.filter((p) => unitOf(p.position) === unit) }))
    .filter((g) => g.players.length);
  const hidden = side.players.length - groups.reduce((n, g) => n + g.players.length, 0);

  return (
    <div className="side">
      <h3>
        {side.team} <span className="muted small">{side.conference}</span>
      </h3>
      <p className="muted small">
        {side.reports.length ? `Latest report: ${side.reports[side.reports.length - 1]}` : "No report released yet"}
        {" · "}
        {side.players.length} listed
      </p>
      {side.players.length === 0 ? (
        <p className="notice">{side.reports.length ? "No injuries reported." : "Nothing reported yet."}</p>
      ) : groups.length === 0 ? (
        <p className="muted small">None of the {side.players.length} listed players match this filter.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Player</th>
                <th>Pos</th>
                {labels.map((l) => (
                  <th key={l}>{l}</th>
                ))}
              </tr>
            </thead>
            {groups.map(({ unit, players }) => (
              <tbody key={unit}>
                <tr className="group-row">
                  <th colSpan={2 + labels.length}>
                    {UNIT_LABELS[unit]} <span className="muted">({players.length})</span>
                  </th>
                </tr>
                {players.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <a
                        href={`?team=${encodeURIComponent(p.team)}&player=${encodeURIComponent(p.player)}`}
                        onClick={(e) => {
                          e.preventDefault();
                          navigate({ team: p.team, player: p.player });
                        }}
                      >
                        {p.player}
                      </a>
                      {p.number && <span className="muted small"> #{p.number}</span>}
                      {p.injury && <div className="muted small">{p.injury}</div>}
                    </td>
                    <td>{p.position ?? "—"}</td>
                    <StatusCells updates={p.updates} labels={labels} />
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}
      {hidden > 0 && groups.length > 0 && (
        <p className="muted small">{hidden} other listed player{hidden === 1 ? "" : "s"} hidden by the filter.</p>
      )}
    </div>
  );
}
