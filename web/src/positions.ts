export type Unit = "offense" | "defense" | "special" | "unknown";

export const UNIT_LABELS: Record<Unit, string> = {
  offense: "Offense",
  defense: "Defense",
  special: "Special teams",
  unknown: "Position unknown",
};

// Codes seen across the conference sources. SL is Rice's slot receiver; NCK, MB, N/S and EDG
// are nickel, Mike backer, nickel/safety and edge.
const UNITS: Record<string, Unit> = {
  ...Object.fromEntries(
    ["QB", "RB", "TB", "HB", "FB", "WR", "SL", "TE", "OL", "OT", "OG", "IOL", "C", "G", "T"].map((p) => [p, "offense"]),
  ),
  ...Object.fromEntries(
    ["DL", "DT", "DE", "NT", "NG", "EDG", "EDGE", "LB", "ILB", "OLB", "MLB", "MB", "DB", "CB", "S", "FS", "SS", "NB", "NCK", "N/S", "STAR"].map(
      (p) => [p, "defense"],
    ),
  ),
  ...Object.fromEntries(["K", "PK", "P", "LS", "KR", "PR"].map((p) => [p, "special"])),
};

export const unitOf = (position: string | null): Unit =>
  (position && UNITS[position.toUpperCase()]) || "unknown";
