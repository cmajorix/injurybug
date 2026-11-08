import GamesView from "./GamesView";
import { PlayerDetail, PlayerSearch } from "./PlayerView";
import { useParams } from "./common";

// Routes live in the query string: ?week=&team=|conf=&unit= (games), ?view=players&q= (search),
// ?team=&player= (one player).
export default function App() {
  const [params, navigate] = useParams();
  const player = params.get("player");
  const team = params.get("team");
  const tab = player || params.get("view") === "players" ? "players" : "games";

  return (
    <div className="app">
      <header className="top">
        <h1>
          <a
            href="?"
            onClick={(e) => {
              e.preventDefault();
              navigate({});
            }}
          >
            injurybug
          </a>
        </h1>
        <nav>
          <button aria-pressed={tab === "games"} onClick={() => navigate({})}>
            Games
          </button>
          <button aria-pressed={tab === "players"} onClick={() => navigate({ view: "players" })}>
            Players
          </button>
        </nav>
      </header>
      <main>
        {player && team ? (
          <PlayerDetail key={`${team}|${player}`} team={team} player={player} navigate={navigate} />
        ) : tab === "players" ? (
          <PlayerSearch query={params.get("q") ?? ""} navigate={navigate} />
        ) : (
          <GamesView params={params} navigate={navigate} />
        )}
      </main>
      <footer className="muted small">
        Conference availability reports. “Not listed” means a released report left the player off, so they're
        presumed available.
      </footer>
    </div>
  );
}
