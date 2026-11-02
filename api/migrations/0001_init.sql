-- DRAFT schema. Revise before first `wrangler d1 migrations apply`.
-- One row per player per game, plus one row per report label (Initial, Update 1, ...)
-- so each report only touches its own label and re-scrapes are no-ops.
-- Status ranks (scrapers/base.py STATUS_RANKS): Available 10, Probable 20, Game Time Decision 30,
-- Questionable 40, Doubtful 50, Out (1st Half) 60, Out 70, Out for Season 80.

CREATE TABLE injuries (
    id             INTEGER PRIMARY KEY,
    conference     TEXT NOT NULL,
    team           TEXT NOT NULL,
    player         TEXT NOT NULL,
    number         TEXT,
    position       TEXT,
    opponent       TEXT,
    game_date      TEXT NOT NULL,    -- ISO 8601 date; NOT NULL so the UNIQUE key can conflict
    week           INTEGER,
    injury         TEXT,
    current_status TEXT,             -- current_status/current_rank are maintained by the triggers below
    current_rank   INTEGER,
    source_url     TEXT,
    updated_at     TEXT NOT NULL,
    UNIQUE (conference, team, player, game_date)
);

CREATE INDEX idx_injuries_conf_date ON injuries (conference, game_date);

CREATE TABLE status_updates (
    injury_id   INTEGER NOT NULL REFERENCES injuries (id) ON DELETE CASCADE,
    seq         INTEGER NOT NULL,    -- report order: Initial=1, Update 1=2, ...
    label       TEXT NOT NULL,
    status      TEXT NOT NULL,       -- canonical
    status_raw  TEXT,                -- source wording; NULL = presumed Available (absent from a released report)
    status_rank INTEGER,
    PRIMARY KEY (injury_id, label)
);

CREATE TRIGGER status_updates_ai AFTER INSERT ON status_updates BEGIN
    UPDATE injuries SET (current_status, current_rank) = (
        SELECT status, status_rank FROM status_updates WHERE injury_id = NEW.injury_id ORDER BY seq DESC LIMIT 1
    ) WHERE id = NEW.injury_id;
END;

CREATE TRIGGER status_updates_au AFTER UPDATE OF status, status_rank ON status_updates BEGIN
    UPDATE injuries SET (current_status, current_rank) = (
        SELECT status, status_rank FROM status_updates WHERE injury_id = NEW.injury_id ORDER BY seq DESC LIMIT 1
    ) WHERE id = NEW.injury_id;
END;

-- A team appeared in a released report, injuries or not. No row for a team's game week means
-- no conference report (bye, non-conference game, or not released yet).
CREATE TABLE team_reports (
    conference    TEXT NOT NULL,
    team          TEXT NOT NULL,
    opponent      TEXT,
    game_date     TEXT NOT NULL,
    label         TEXT NOT NULL,
    seq           INTEGER NOT NULL,
    released_at   TEXT,              -- from the source, ISO 8601 UTC; NULL when it doesn't say
    first_seen_at TEXT NOT NULL,     -- when a scrape first found it
    PRIMARY KEY (conference, team, game_date, label)
);

CREATE INDEX idx_team_reports_conf_date ON team_reports (conference, game_date);
