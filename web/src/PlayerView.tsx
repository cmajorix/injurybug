import { useEffect, useState } from "react";
import { api, formatDate, type Injury, type Week } from "./api";
import { Loading, REPORT_LABELS, Status, StatusCells, useAsync, type Navigate } from "./common";
import { UNIT_LABELS, unitOf } from "./positions";

export function PlayerSearch({ query, navigate }: { query: string; navigate: Navigate }) {
  const [text, setText] = useState(query);
  const [debounced, setDebounced] = useState(query);
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(text.trim());
      navigate({ view: "players", q: text.trim() || undefined }, { replace: true });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  const results = useAsync(() => (debounced.length >= 2 ? api.players(debounced) : undefined), [debounced]);

  return (
    <>
      <div className="controls">
        <label className="grow">
          <span>Player name</span>
          <input
            type="search"
            autoFocus
            placeholder="At least 2 letters"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
      </div>
      {debounced.length >= 2 && (
        <Loading state={results}>
          {results.data?.length === 0 ? (
            <p className="notice">No injured players match “{debounced}”.</p>
          ) : (
            <ul className="results">
              {results.data?.map((p) => (
                <li key={`${p.team}|${p.player}`}>
                  <a
                    href={`?team=${encodeURIComponent(p.team)}&player=${encodeURIComponent(p.player)}`}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate({ team: p.team, player: p.player });
                    }}
                  >
                    {p.player}
                  </a>
                  <span className="muted small">
                    {p.team} · {p.conference}
                    {p.position && ` · ${p.position}`} · {p.games} game{p.games === 1 ? "" : "s"} listed, last{" "}
                    {formatDate(p.last_game_date)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Loading>
      )}
    </>
  );
}

export function PlayerDetail({ team, player, navigate }: { team: string; player: string; navigate: Navigate }) {
  const injuries = useAsync(() => api.playerInjuries(team, player), [team, player]);
  const weeks = useAsync(api.weeks, []);
  const rows = [...(injuries.data ?? [])].sort((a, b) => b.game_date.localeCompare(a.game_date));
  const latest = rows[0];
  const labels = REPORT_LABELS.filter((l) => rows.some((r) => r.updates.some((u) => u.label === l)));
  const missed = rows.filter((r) => (r.current_rank ?? 0) >= 70).length;

  return (
    <Loading state={injuries}>
      <header className="player-header">
        <h2>{player}</h2>
        <p className="muted">
          <a
            href={`?team=${encodeURIComponent(team)}`}
            onClick={(e) => {
              e.preventDefault();
              navigate({ team });
            }}
          >
            {team}
          </a>
          {latest && ` · ${latest.conference}`}
          {latest?.position && ` · ${latest.position} (${UNIT_LABELS[unitOf(latest.position)]})`}
          {latest?.number && ` · #${latest.number}`}
        </p>
      </header>

      {rows.length === 0 ? (
        <p className="notice">No injury reports list this player.</p>
      ) : (
        <>
          <p>
            On the injury report for <strong>{rows.length}</strong> game{rows.length === 1 ? "" : "s"}; ruled out of{" "}
            <strong>{missed}</strong>. {latest.current_status && <>Most recent: <Status update={latest.updates.at(-1)} /></>}
          </p>
          {weeks.data && <SeasonStrip weeks={weeks.data} rows={rows} />}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Week</th>
                  <th>Game</th>
                  {labels.map((l) => (
                    <th key={l}>{l}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <a
                        href={`?week=${r.game_date}&team=${encodeURIComponent(r.team)}`}
                        onClick={(e) => {
                          e.preventDefault();
                          navigate({ week: r.game_date, team: r.team });
                        }}
                      >
                        {r.week ?? "—"}
                      </a>
                    </td>
                    <td>
                      {r.opponent ? `vs ${r.opponent}` : "—"}
                      <div className="muted small">
                        {formatDate(r.game_date)}
                        {r.injury && ` · ${r.injury}`}
                      </div>
                    </td>
                    <StatusCells updates={r.updates} labels={labels} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Loading>
  );
}

/** A cell per week of the season, colored by the player's final status that week. */
function SeasonStrip({ weeks, rows }: { weeks: Week[]; rows: Injury[] }) {
  const season = [...weeks]
    .reverse()
    .filter((w) => w.start >= rows.at(-1)!.game_date.slice(0, 4) + "-07-01");
  return (
    <div className="strip" aria-label="Final status by week">
      {season.map((w) => {
        const row = rows.find((r) => r.game_date >= w.start && r.game_date <= addDays(w.start, 6));
        const update = row?.updates.at(-1);
        return (
          <div key={w.start} className="strip-week" title={update ? `${update.status} vs ${row!.opponent}` : "Not listed"}>
            <span className={`strip-cell ${update ? `status-${update.rank}` : "status-none"}`} />
            <span className="muted small">{w.week ?? "?"}</span>
          </div>
        );
      })}
    </div>
  );
}

const addDays = (date: string, days: number) => new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10);
