import { useCallback, useEffect, useState } from 'react';
import { useMsal } from '@azure/msal-react';
import { armScope, storageScope } from './authConfig';
import { useAccessToken } from './useAccessToken';
import {
  deployFoundation, getExecutionState, getJobBlob, getJobJson, listJobIds, putJobBlob, startWorker,
  type FoundationRequest, type Plan, type RunRecord, type WorkerStatus,
} from './worker';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function RunList() {
  const getToken = useAccessToken();
  const [runs, setRuns] = useState<{ run: RunRecord; status: WorkerStatus | null }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await getToken(storageScope, true);
        const ids = await listJobIds(token);
        const loaded = await Promise.all(ids.map(async (id) => ({ run: await getJobJson<RunRecord>(token, `${id}/run.json`), status: await getJobJson<WorkerStatus>(token, `${id}/status.json`) })));
        if (!cancelled) setRuns(loaded.filter((r): r is { run: RunRecord; status: WorkerStatus | null } => r.run !== null).sort((a, b) => b.run.createdUtc.localeCompare(a.run.createdUtc)));
      } catch (e) {
        if (!cancelled) setError(message(e));
      }
    })();
    return () => { cancelled = true; };
  }, [getToken]);

  return (
    <section>
      <h2>Runs</h2>
      {error && <div className="note err">{error}</div>}
      {!runs && !error && <p className="hint">Loading…</p>}
      {runs?.length === 0 && <p className="hint">No runs yet. Fill in the form and select Run Preview in Azure.</p>}
      {runs && runs.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Started</th><th>Resource group</th><th>State</th></tr></thead>
            <tbody>
              {runs.map(({ run, status }) => (
                <tr key={run.jobId}>
                  <td><a href={`#/runs/${run.jobId}`}>{new Date(run.createdUtc).toLocaleString()}</a></td>
                  <td>{run.resourceGroup}</td>
                  <td>{status ? `${status.action}: ${status.state}` : 'starting'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function RunPage({ jobId }: { jobId: string }) {
  const getToken = useAccessToken();
  const { instance } = useMsal();
  const [run, setRun] = useState<RunRecord | null>(null);
  const [status, setStatus] = useState<WorkerStatus | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [foundation, setFoundation] = useState<FoundationRequest | null>(null);
  const [log, setLog] = useState('');
  const [execution, setExecution] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [approval, setApproval] = useState('');
  const [tick, setTick] = useState(0);

  const latest = run?.executions[run.executions.length - 1];
  // A status written before the latest execution started belongs to the previous step.
  const current = status && latest && status.action === latest.action && status.startedUtc >= latest.startedUtc ? status : null;
  const active = !!latest && (!current || current.state === 'running') && !['Failed', 'Succeeded', 'Stopped', 'Degraded'].includes(execution);

  const refresh = useCallback(async () => {
    try {
      const token = await getToken(storageScope, true);
      const record = await getJobJson<RunRecord>(token, `${jobId}/run.json`);
      if (!record) { setError('This run was not found.'); return; }
      setRun(record);
      const workerStatus = await getJobJson<WorkerStatus>(token, `${jobId}/status.json`);
      setStatus(workerStatus);
      setLog((await getJobBlob(token, `${jobId}/log.txt`)) ?? '');
      if (workerStatus?.state === 'previewed') {
        setPlan(await getJobJson<Plan>(token, `${jobId}/plan.json`));
        setFoundation(await getJobJson<FoundationRequest>(token, `${jobId}/foundation.json`));
      }
      const last = record.executions[record.executions.length - 1];
      if (last) setExecution(await getExecutionState(await getToken(armScope), last.name));
    } catch (e) {
      setError(message(e));
    }
  }, [getToken, jobId]);

  useEffect(() => { void refresh(); }, [refresh, tick]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((t) => t + 1), 10000);
    return () => clearInterval(timer);
  }, [active]);

  async function start(action: 'preview' | 'deploy', approve?: string) {
    if (!run) return;
    const name = await startWorker(await getToken(armScope, true), { JOB_ID: jobId, JOB_ACTION: action, APPROVE: approve });
    const updated: RunRecord = { ...run, executions: [...run.executions, { action, name, startedUtc: new Date().toISOString() }] };
    await putJobBlob(await getToken(storageScope, true), `${jobId}/run.json`, JSON.stringify(updated, null, 2));
    setRun(updated);
    setTick((t) => t + 1);
  }

  async function act(label: string, work: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try { await work(); } catch (e) { setError(message(e)); } finally { setBusy(null); }
  }

  async function prepare() {
    if (!foundation) return;
    const account = instance.getActiveAccount();
    const oid = (account?.idTokenClaims?.oid as string | undefined) ?? account?.localAccountId;
    if (!oid) throw new Error('Could not read your Entra object ID; sign out and in again.');
    await deployFoundation(await getToken(armScope, true), foundation, oid, (text) => setBusy(text));
    setBusy('Foundation ready. Running Preview again…');
    await start('preview');
  }

  async function downloadConfiguration() {
    const text = await getJobBlob(await getToken(storageScope, true), `${jobId}/config.json`);
    if (!text) throw new Error('No configuration has been generated yet.');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    link.download = `${run?.prefix.toLowerCase() ?? 'avd'}-config.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  if (!run) return <section>{error ? <div className="note err">{error}</div> : <p className="hint">Loading run…</p>}</section>;

  const resourceGroup = run.resourceGroup;
  const step = !current ? 'starting' : `${current.action}-${current.state}`;
  return (
    <>
      <section>
        <h2>Run for {resourceGroup}</h2>
        <p className="hint">Started {new Date(run.createdUtc).toLocaleString()} by {run.createdBy} in subscription {run.subscriptionId}. <a href="#/runs">All runs</a></p>
        {error && <div className="note err">{error}</div>}
        {busy && <div className="note">{busy}</div>}
        {step === 'starting' && latest && <div className="note">Starting the {latest.action} job ({execution || 'queued'})… the container takes a minute or two to start.</div>}
        {current?.state === 'running' && <div className="note">{current.action === 'deploy' ? 'Deploying' : 'Previewing'}: {current.stage}…</div>}
        {current?.state === 'failed' && <div className="note err">The {current.action} failed: {current.message}</div>}
        {!current && ['Failed', 'Stopped', 'Degraded'].includes(execution) && <div className="note err">The job execution ended ({execution}) before reporting status. Check the job's logs in the Azure portal.</div>}
      </section>

      {current?.action === 'preview' && current.state === 'previewed' && plan && (
        <section>
          <h2>Preview</h2>
          <p>{plan.sessionHosts.count} x {plan.sessionHosts.vmSize}, {plan.sessionHosts.image.label}. Plan valid until {new Date(plan.expiresUtc).toLocaleString()}.</p>
          {current.needsFoundation && foundation ? (
            <div className="note warn">
              <strong>Prepare the foundation first.</strong> Using your own Azure rights, the portal will create what's missing ({[...foundation.missing, ...foundation.unregisteredProviders.map((p) => `provider ${p}`)].join(', ')}),
              and give the portal worker access to this resource group only. Then Preview runs again.
              <div className="actions"><button disabled={!!busy} onClick={() => act('Preparing…', prepare)}>Prepare (as me)</button></div>
            </div>
          ) : plan.blockers.length > 0 ? (
            <List kind="err" title="Blockers" items={plan.blockers} />
          ) : null}
          <List kind="warn" title="Warnings" items={plan.warnings} />
          {plan.changes.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 10 }}>
              <table>
                <thead><tr><th>Stage</th><th>Change</th><th>Resource</th></tr></thead>
                <tbody>{plan.changes.map((c) => <tr key={`${c.stage}-${c.resourceId}`}><td>{c.stage}</td><td>{c.changeType}</td><td className="mono">{c.resourceId.split('/providers/').pop()}</td></tr>)}</tbody>
              </table>
            </div>
          )}
          {current.ready && (
            <div style={{ marginTop: 14 }}>
              <label>Type the resource group name <code>{resourceGroup}</code> to deploy this plan
                <input type="text" value={approval} onChange={(e) => setApproval(e.target.value)} />
              </label>
              <div className="actions">
                <button disabled={approval !== resourceGroup || !!busy} onClick={() => act('Starting the deployment…', () => start('deploy', approval))}>Deploy</button>
                <button className="secondary" disabled={!!busy} onClick={() => act('Starting Preview…', () => start('preview'))}>Run Preview again</button>
              </div>
            </div>
          )}
          {!current.ready && !current.needsFoundation && (
            <div className="actions"><button className="secondary" disabled={!!busy} onClick={() => act('Starting Preview…', () => start('preview'))}>Run Preview again</button></div>
          )}
        </section>
      )}

      {current?.action === 'deploy' && current.state === 'deployed' && (
        <section>
          <h2>Deployed</h2>
          <div className="note ok">AVD is deployed to {resourceGroup}.</div>
          <List kind="warn" title="Still to do" items={current.manualTasks ?? []} />
          <p className="hint">Post-deployment configuration changes tenant-wide Entra settings, so it runs with your own sign-in. Download the configuration and run:</p>
          <div className="cmd"><code>{`.\\avd.ps1 -Mode PostDeploy -ConfigurationFile .\\${run.prefix.toLowerCase()}-config.json`}</code></div>
          <div className="actions"><button className="secondary" onClick={() => act('Downloading…', downloadConfiguration)}>Download configuration</button></div>
        </section>
      )}

      {current?.state === 'failed' && (
        <section>
          <div className="actions">
            <button className="secondary" disabled={!!busy} onClick={() => act('Starting Preview…', () => start('preview'))}>Run Preview again</button>
          </div>
        </section>
      )}

      {log && (
        <section>
          <h2>Log</h2>
          <pre className="log">{log.split('\n').slice(-80).join('\n')}</pre>
        </section>
      )}
    </>
  );
}

function List({ kind, title, items }: { kind: 'err' | 'warn'; title: string; items: string[] }) {
  if (!items.length) return null;
  return <div className={`note ${kind}`}><strong>{title}</strong><ul>{items.map((i) => <li key={i}>{i}</li>)}</ul></div>;
}
