// AKC-only: approve or decline organisation requests (private beta). The API enforces this; the link is only a convenience.
import { useCallback, useEffect, useState } from 'react';
import { message, useApi, type OrganisationRequest, type OrganisationStatus } from '../api';

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function AdminRequests() {
  const api = useApi();
  const [filter, setFilter] = useState<OrganisationStatus | ''>('pending');
  const [rows, setRows] = useState<OrganisationRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows((await api<{ organisations: OrganisationRequest[] }>('GET', `/admin/organisations${filter ? `?status=${filter}` : ''}`)).organisations);
    } catch (e) {
      setError(message(e));
    }
  }, [api, filter]);
  useEffect(() => { void load(); }, [load]);

  async function decide(row: OrganisationRequest, decision: 'approve' | 'decline') {
    if (!window.confirm(`${decision === 'approve' ? 'Approve' : 'Decline'} ${row.name}?`)) return;
    setBusy(row.id);
    setError(null);
    try {
      await api('POST', `/admin/organisations/${row.id}/${decision}`);
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <p className="eyebrow">AKC admin</p>
      <h1>Organisation requests</h1>
      <section className="card">
        <div className="toolbar">
          <label htmlFor="status-filter">Show</label>
          <select id="status-filter" value={filter} onChange={(e) => setFilter(e.target.value as OrganisationStatus | '')}>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="declined">Declined</option>
            <option value="">All</option>
          </select>
          <button className="btn btn-secondary btn-small" onClick={load}>Refresh</button>
        </div>
        {error && <div className="note err">{error}</div>}
        {!rows ? <p className="muted">Loading…</p> : rows.length === 0 ? <p className="muted">Nothing here.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Organisation</th><th>Requested by</th><th>When</th><th>Status</th><th /></tr></thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.name}<div className="mono muted">{row.id}</div></td>
                    <td>{row.requesterName || '—'}<div className="muted">{row.requesterEmail}</div></td>
                    <td>{when(row.requestedAt)}</td>
                    <td><span className={`pill ${row.status === 'approved' ? 'ok' : row.status === 'pending' ? '' : 'bad'}`}>{row.status}</span></td>
                    <td className="row-actions">
                      {row.status === 'pending' && (
                        <>
                          <button className="btn btn-primary btn-small" disabled={busy === row.id} onClick={() => decide(row, 'approve')}>Approve</button>
                          <button className="btn btn-secondary btn-small" disabled={busy === row.id} onClick={() => decide(row, 'decline')}>Decline</button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
