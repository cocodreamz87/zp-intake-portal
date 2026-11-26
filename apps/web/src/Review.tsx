import { useEffect, useState } from "react";
import { LAUNCH_SIGNOFF_TEXT, type ReviewView } from "@zinkpress/shared";
import { api, ApiError } from "./api";
import { formatWhen } from "./Wizard";

/** /review?token=... : the client watches the walkthrough, opens staging, and signs off the launch. */
export function Review({ token }: { token: string }) {
  const [view, setView] = useState<ReviewView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [signerName, setSignerName] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  useEffect(() => {
    api
      .review(token)
      .then(setView)
      .catch((e) => setError(e instanceof ApiError ? e.message : "We couldn't reach the server. Try again in a minute."));
  }, [token]);

  async function approve() {
    const errs: Record<string, string> = {};
    if (!confirmed) errs.confirmed = "Tick the box to approve the launch.";
    if (signerName.trim().length < 2) errs.signerName = "Type your full name.";
    setFieldErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setBanner(null);
    try {
      const r = await api.approve(token, { confirmed, signerName: signerName.trim() });
      setView((v) => (v ? { ...v, status: r.status, approvedAt: r.approvedAt, approvedBy: signerName.trim() } : v));
    } catch (e) {
      if (e instanceof ApiError && Object.keys(e.fields).length) setFieldErrors(e.fields);
      setBanner(e instanceof Error ? e.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <div className="card center">
        <p className="eyebrow">Launch review</p>
        <h1>We can't open your review</h1>
        <p className="muted">{error}</p>
      </div>
    );
  }
  if (!view) return <div className="card center muted">Loading your review…</div>;

  if (view.status === "LAUNCHED") {
    return (
      <div className="card">
        <span className="pill">Launch approved</span>
        <h1>Thank you. We're taking it live.</h1>
        <p className="muted">
          Project <strong>{view.projectId}</strong> was approved
          {view.approvedBy ? ` by ${view.approvedBy}` : ""}
          {view.approvedAt ? ` on ${formatWhen(view.approvedAt, "America/New_York")}` : ""}. We'll let you know as soon as your site
          is on your domain.
        </p>
        <p className="muted small">Questions? {view.agencyEmail}</p>
      </div>
    );
  }

  return (
    <div className="card">
      <header className="topbar">
        <div>
          <p className="eyebrow">{view.agencyName} · Launch review</p>
          <h1>{view.clientName}</h1>
          <p className="muted small">{view.projectId}</p>
        </div>
      </header>

      <h2>1. Watch the walkthrough</h2>
      {view.loomEmbedUrl ? (
        <div className="video">
          <iframe
            src={view.loomEmbedUrl}
            title="Walkthrough video"
            allow="fullscreen; picture-in-picture"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        </div>
      ) : view.loomUrl ? (
        <p>
          <a href={view.loomUrl} target="_blank" rel="noreferrer">
            Open the walkthrough video
          </a>
        </p>
      ) : null}

      <h2>2. Try your staging site</h2>
      {view.stagingUrl && (
        <a className="staging-link" href={view.stagingUrl} target="_blank" rel="noreferrer">
          Open staging in a new tab ↗
        </a>
      )}

      <h2>3. Read the release notes</h2>
      <div className="notes">{view.releaseNotes}</div>

      <h2>4. Sign off</h2>
      {banner && <div className="alert">{banner}</div>}
      <div className={`check ${fieldErrors.confirmed ? "has-error" : ""}`}>
        <label>
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          <span>{LAUNCH_SIGNOFF_TEXT}</span>
        </label>
        {fieldErrors.confirmed && <span className="error">{fieldErrors.confirmed}</span>}
      </div>
      <label className={`field ${fieldErrors.signerName ? "has-error" : ""}`}>
        <span className="label">Your full name</span>
        <input value={signerName} autoComplete="name" onChange={(e) => setSignerName(e.target.value)} />
        {fieldErrors.signerName ? (
          <span className="error">{fieldErrors.signerName}</span>
        ) : (
          <span className="hint">We record your name, the time and your IP address with this approval.</span>
        )}
      </label>
      <button type="button" className="primary big" disabled={busy} onClick={approve}>
        {busy ? "Approving…" : "Approve & Launch to Production"}
      </button>
      <p className="muted small">Not ready? Reply to your review email or write to {view.agencyEmail} with your changes.</p>
    </div>
  );
}
