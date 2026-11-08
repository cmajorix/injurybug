-- The week views read every conference's rows in a date window.
CREATE INDEX idx_injuries_date ON injuries (game_date);
CREATE INDEX idx_team_reports_date ON team_reports (game_date);
