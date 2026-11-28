import { useEffect, useState } from "react";
import type { MaintenanceView } from "@zinkpress/shared";
import { api, ApiError } from "./api";
import { formatWhen } from "./Wizard";

/** /maintenance?token=... : a launched client re-enters only the keys a change request needs. */
export function Maintenance({ token }: { token: string }) {
  const [view, setView] = useState<MaintenanceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  useEffect(() => {
    api
      .maintenance(token)
      .then(setView)
      .catch((e) => setError(e instanceof ApiError ? e.message : "We couldn't reach the server. Try again in a minute."));
  }, [token]);

  async function submit() {
    if (!view) return;
    const errs: Record<string, string> = {};
    for (const k of view.requiredIntegrations) if (!values[k]?.trim()) errs[`secrets.${k}`] = "Paste this key.";
    setFields(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setBanner(null);
    try {
      const r = await api.submitMaintenance(token, values);
      setValues({});
      setView({ ...view, status: "SUBMITTED", submittedAt: r.submittedAt });
    } catch (e) {
      if (e instanceof ApiError && Object.keys(e.fields).length) setFields(e.fields);
      setBanner(e instanceof Error ? e.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <div className="card center">
        <p className="eyebrow">Change request</p>
        <h1>We can't open this link</h1>
        <p className="muted">{error}</p>
      </div>
    );
  }
  if (!view) return <div className="card center muted">Loading…</div>;

  if (view.status !== "OPEN") {
    return (
      <div className="card">
        <span className="pill">{view.status === "EXPIRED" ? "Link expired" : "Keys received"}</span>
        <h1>{view.status === "EXPIRED" ? "This link has expired" : "Thanks. We have what we need."}</h1>
        <p className="muted">
          {view.status === "EXPIRED"
            ? `Email ${view.agencyEmail} for a fresh link.`
            : `Your keys for ${view.projectId} are encrypted. We wipe them again once the change is done.`}
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      <p className="eyebrow">Change request · {view.projectId}</p>
      <h1>Add your keys for this update</h1>
      <p className="muted">
        We wiped your API keys after launch, as promised. To make this change for {view.clientName}, paste these again. They're
        encrypted the moment you send them.
      </p>
      {view.note && (
        <p className="notes">
          <strong>The change:</strong> {view.note}
        </p>
      )}
      {banner && <div className="alert">{banner}</div>}
      {view.requiredIntegrations.map((k) => (
        <label key={k} className={`field ${fields[`secrets.${k}`] ? "has-error" : ""}`}>
          <span className="label">{k}</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={values[k] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))}
          />
          {fields[`secrets.${k}`] && <span className="error">{fields[`secrets.${k}`]}</span>}
        </label>
      ))}
      <button className="primary big" disabled={busy} onClick={submit}>
        {busy ? "Sending…" : "Send my keys securely"}
      </button>
      <p className="muted small">Link works until {formatWhen(view.expiresAt, "America/New_York")}. Questions? {view.agencyEmail}</p>
    </div>
  );
}
