import { useEffect, useState } from "react";
import type { StatusUpdate } from "./api";

// Report labels within a game week, in release order (scrapers/base.py REPORT_LABELS).
export const REPORT_LABELS = ["Initial", "Update 1", "Update 2", "Game Day"];

export type Params = URLSearchParams;
export type Navigate = (next: Record<string, string | undefined>, opts?: { replace?: boolean }) => void;

/** The page's query string as state; navigate() replaces it and keeps back/forward working. */
export function useParams(): [Params, Navigate] {
  const [params, setParams] = useState(() => new URLSearchParams(location.search));
  useEffect(() => {
    const onPop = () => setParams(new URLSearchParams(location.search));
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  const navigate: Navigate = (next, opts) => {
    const query = new URLSearchParams(Object.entries(next).filter((e): e is [string, string] => !!e[1]));
    const url = query.size ? `?${query}` : location.pathname;
    history[opts?.replace ? "replaceState" : "pushState"](null, "", url);
    setParams(query);
    if (!opts?.replace) scrollTo(0, 0);
  };
  return [params, navigate];
}

export type Async<T> = { data?: T; error?: Error; loading: boolean };

export function useAsync<T>(load: () => Promise<T> | undefined, deps: unknown[]): Async<T> {
  const [state, setState] = useState<Async<T>>({ loading: true });
  useEffect(() => {
    const pending = load();
    if (!pending) return setState({ loading: false });
    let current = true;
    setState((s) => ({ ...s, loading: true }));
    pending.then(
      (data) => current && setState({ data, loading: false }),
      (error) => current && setState({ error, loading: false }),
    );
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

export function Status({ update }: { update: StatusUpdate | undefined }) {
  if (!update) return <span className="status status-none">—</span>;
  const presumed = update.status_raw === null;
  return (
    <span
      className={`status status-${update.rank}${presumed ? " status-presumed" : ""}`}
      title={presumed ? "Not on this report: presumed available" : update.status_raw ?? undefined}
    >
      {presumed ? "Not listed" : update.status}
    </span>
  );
}

/** One cell per report label, so rows line up under the table's report columns. */
export function StatusCells({ updates, labels }: { updates: StatusUpdate[]; labels: string[] }) {
  return labels.map((label) => (
    <td key={label} className="status-cell">
      <Status update={updates.find((u) => u.label === label)} />
    </td>
  ));
}

export function Loading({ state, children }: { state: Async<unknown>; children: React.ReactNode }) {
  if (state.error) return <p className="notice error">Couldn't load: {state.error.message}</p>;
  if (state.loading && state.data === undefined) return <p className="notice">Loading…</p>;
  return children;
}
