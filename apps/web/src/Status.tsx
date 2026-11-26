import { useEffect, useState } from "react";
import { STATUS_STAGE_LABELS, STATUS_STAGES, type StatusView } from "@zinkpress/shared";
import { api, ApiError } from "./api";
import { formatWhen } from "./Wizard";

function countdown(toIso: string, now: number) {
  const ms = new Date(toIso).getTime() - now;
  if (ms <= 0) return null;
  const mins = Math.floor(ms / 60_000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`;
}

/** Read-only status on the client's private link: stage, business-day progress and a live countdown. */
export function Status({ token }: { token: string }) {
  const [view, setView] = useState<StatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const load = () =>
      api
        .status(token)
        .then(setView)
        .catch((e) => setError(e instanceof ApiError ? e.message : "We couldn't reach the server. Try again in a minute."));
    load();
    const refresh = setInterval(load, 5 * 60_000); // picks up a stage change without a reload
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      clearInterval(refresh);
      clearInterval(tick);
    };
  }, [token]);

  if (error) {
    return (
      <div className="card center">
        <p className="eyebrow">Project status</p>
        <h1>We can't open your status</h1>
        <p className="muted">{error}</p>
      </div>
    );
  }
  if (!view || !view.stage) return <div className="card center muted">Loading your project…</div>;

  const current = STATUS_STAGES.indexOf(view.stage);
  const left = view.guaranteedDeadline && view.stage !== "LAUNCHED" && view.stage !== "STAGING_REVIEW" ? countdown(view.guaranteedDeadline, now) : null;
  const kickoffIn = view.stage === "INTAKE_COMPLETE" && view.clockStartedAt ? countdown(view.clockStartedAt, now) : null;

  return (
    <div className="card">
      <p className="eyebrow">Project status · {view.projectId}</p>
      <h1>
        {view.stage === "LAUNCHED"
          ? "You're live."
          : view.stage === "STAGING_REVIEW"
            ? "Staging is ready for your review."
            : view.stage === "BUILDING"
              ? "We're building."
              : "Intake complete. Kickoff is booked."}
      </h1>
      <p className="muted">{view.clientName}</p>

      <ol className="tracker" aria-label="Project stages">
        {STATUS_STAGES.map((s, i) => (
          <li key={s} className={i < current ? "done" : i === current ? "active" : ""} aria-current={i === current ? "step" : undefined}>
            <span className="dot">{i < current ? "✓" : i + 1}</span>
            <span>{STATUS_STAGE_LABELS[s]}</span>
          </li>
        ))}
      </ol>

      {view.percent !== null && view.businessDaysTotal !== null && (
        <div className="progress-wrap">
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={view.percent}>
            <span style={{ width: `${view.percent}%` }} />
          </div>
          <p className="small muted">
            Business day {view.businessDaysElapsed} of {view.businessDaysTotal}
            {view.businessDaysLeft ? ` · ${view.businessDaysLeft} to go` : ""}
          </p>
        </div>
      )}

      <dl className="receipt">
        {view.clockStartedAt && (
          <>
            <dt>Kickoff</dt>
            <dd>
              {formatWhen(view.clockStartedAt, view.timeZone)}
              {kickoffIn ? <span className="muted small"> · in {kickoffIn}</span> : null}
            </dd>
          </>
        )}
        {view.guaranteedDeadline && (
          <>
            <dt>Staging due</dt>
            <dd>
              {formatWhen(view.guaranteedDeadline, view.timeZone)}
              {left ? <span className="countdown"> · {left} left</span> : null}
            </dd>
          </>
        )}
        {view.launchedAt && (
          <>
            <dt>Launched</dt>
            <dd>{formatWhen(view.launchedAt, view.timeZone)}</dd>
          </>
        )}
      </dl>

      {view.stage === "STAGING_REVIEW" && (
        <p>
          <a className="primary" href="/review">
            Open my review
          </a>
        </p>
      )}
      <p className="muted small">This page updates on its own. Business days are Monday to Friday. Questions? {view.agencyEmail}</p>
    </div>
  );
}
