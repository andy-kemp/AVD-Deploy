import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMsal } from '@azure/msal-react';
import { armScope, groupReadScope, groupWriteScope, storageScope } from './authConfig';
import { grantWorkerReader, putJobBlob, startWorker, workerCanRead, workerConfigured, type RunRecord } from './worker';
import {
  getComputeCapacityData, getResourceGroupLocation, listHostPoolRegions, listSubscriptions, listVirtualNetworks,
  type ComputeSku, type Region, type Subscription, type Usage, type VirtualNetwork,
} from './arm';
import { ensureSecurityGroup, searchGroups, type Group } from './graph';
import {
  cidrRange, dayTimes, evaluateCapacity, imageOptions, overlappingPrefixes, personas, proposeAddressSpace, recommend,
  suggestedTimeZone, timeZones, type CapacityResult, type Hosting, type PersonaId,
} from './planning';
import { downloadAnswers, patterns, type Answers } from './answers';
import { InteractionNeededError, useAccessToken } from './useAccessToken';

type Role = 'users' | 'admins';
interface GroupChoice { mode: 'new' | 'existing'; newName: string | null; selected: string }
type Capacity = { key: string; status: 'checking' } | { key: string; status: 'unverified'; message: string } | { key: string; status: 'done'; result: CapacityResult };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function Wizard() {
  const getToken = useAccessToken();
  const { instance } = useMsal();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<string | null>(null);
  // Whether the worker can read the chosen subscription: null while checking or when there is no worker.
  const [workerAccess, setWorkerAccess] = useState<{ subscriptionId: string; ok: boolean; error?: string } | null>(null);

  // 1. Azure location
  const [subscriptions, setSubscriptions] = useState<Subscription[] | null>(null);
  const [subscriptionId, setSubscriptionId] = useState('');
  const [regions, setRegions] = useState<Region[] | null>(null);
  const [location, setLocation] = useState('');
  const [prefix, setPrefix] = useState('AVD');
  const [rgOverride, setRgOverride] = useState<string | null>(null);
  const [rgStatus, setRgStatus] = useState<{ text: string; clash: boolean } | null>(null);

  // 2. Network
  const [networks, setNetworks] = useState<VirtualNetwork[] | null>(null);
  const [networkMode, setNetworkMode] = useState<'New' | 'Existing'>('New');
  const [addressOverride, setAddressOverride] = useState<string | null>(null);
  const [vnetName, setVnetName] = useState('');
  const [hostSubnetChoice, setHostSubnetChoice] = useState('');
  const [peSubnetChoice, setPeSubnetChoice] = useState('');

  // 3. Access groups
  const [groups, setGroups] = useState<Record<Role, GroupChoice>>({
    users: { mode: 'new', newName: null, selected: '' },
    admins: { mode: 'new', newName: null, selected: '' },
  });
  const [addMe, setAddMe] = useState(true);

  // 4. Users and sizing
  const [hosting, setHosting] = useState<Hosting>('Shared');
  const [persona, setPersona] = useState<PersonaId>('Standard');
  const [users, setUsers] = useState('10');
  const [peak, setPeak] = useState('100');
  const [imageByType, setImageByType] = useState<Record<string, string>>({});
  const [capacity, setCapacity] = useState<Capacity | null>(null);
  const [vmSizeChoice, setVmSizeChoice] = useState('');
  const capacityCache = useRef(new Map<string, Promise<{ skus: ComputeSku[]; usages: Usage[] }>>());

  // 5–7. Profiles, scaling, display names
  const [identity, setIdentity] = useState<'CloudOnly' | 'Hybrid'>('CloudOnly');
  const [domainName, setDomainName] = useState('');
  const [domainGuid, setDomainGuid] = useState('');
  const [profileFailure, setProfileFailure] = useState<'TempProfile' | 'Block'>('TempProfile');
  const [scaling, setScaling] = useState<'BusinessHours' | 'None'>('BusinessHours');
  const [timeZoneOverride, setTimeZoneOverride] = useState<string | null>(null);
  const [dayStart, setDayStart] = useState('08:00');
  const [dayEnd, setDayEnd] = useState('18:00');
  const [workspaceOverride, setWorkspaceOverride] = useState<string | null>(null);
  const [desktopOverride, setDesktopOverride] = useState<string | null>(null);

  // 8. Output
  const [validation, setValidation] = useState<string[]>([]);
  const [downloaded, setDownloaded] = useState<{ fileName: string; prefix: string } | null>(null);

  // Defaults derived from the prefix and region until the operator edits them.
  const cleanPrefix = prefix.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  const rgName = rgOverride ?? (cleanPrefix ? `rg-${cleanPrefix}-avd` : '');
  const existingPrefixes = useMemo(() => (networks ?? []).flatMap((n) => n.addressPrefixes), [networks]);
  const addressSpace = addressOverride ?? proposeAddressSpace(existingPrefixes);
  const regionalNetworks = (networks ?? []).filter((n) => n.location === location);
  const vnet = regionalNetworks.find((n) => n.name === vnetName) ?? regionalNetworks[0];
  const subnets = vnet?.subnets ?? [];
  const hostSubnet = subnets.includes(hostSubnetChoice) ? hostSubnetChoice : (subnets[0] ?? '');
  const peSubnet = subnets.includes(peSubnetChoice) ? peSubnetChoice : (subnets[1] ?? subnets[0] ?? '');
  const groupName = (role: Role) => groups[role].newName ?? (cleanPrefix ? `sg-${cleanPrefix}-avd-${role}` : '');
  const hostPoolType = hosting === 'Shared' ? 'Pooled' : 'Personal';
  const images = imageOptions(hostPoolType);
  const imageSku = images.some((i) => i.sku === imageByType[hostPoolType]) ? imageByType[hostPoolType] : images[0].sku;
  const timeZone = timeZoneOverride ?? suggestedTimeZone(location);
  const workspaceName = workspaceOverride ?? (prefix.trim() ? `${prefix.trim()} Workspace` : '');
  const desktopName = desktopOverride ?? (prefix.trim() ? `${prefix.trim()} Virtual Desktop` : '');

  const sizing = useMemo((): { rec?: ReturnType<typeof recommend>; error?: string } => {
    const userCount = Number(users);
    const peakPct = hosting === 'Dedicated' ? 100 : Number(peak);
    if (!Number.isInteger(userCount) || userCount < 1 || userCount > 5000) return { error: 'Users must be 1 to 5000.' };
    if (!Number.isInteger(peakPct) || peakPct < 1 || peakPct > 100) return { error: 'Peak concurrency must be 1 to 100%.' };
    try {
      return { rec: recommend(hosting, persona, userCount, peakPct) };
    } catch (e) {
      return { error: message(e) };
    }
  }, [hosting, persona, users, peak]);
  const rec = sizing.rec;

  // Load subscriptions once signed in.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await listSubscriptions(await getToken(armScope));
        if (cancelled) return;
        setSubscriptions(list);
        if (list.length) setSubscriptionId(list[0].subscriptionId);
      } catch (e) {
        if (!cancelled) setError(message(e));
      }
    })();
    return () => { cancelled = true; };
  }, [getToken]);

  // Regions and networks follow the subscription.
  useEffect(() => {
    if (!subscriptionId) return;
    let cancelled = false;
    setRegions(null);
    setNetworks(null);
    (async () => {
      try {
        const token = await getToken(armScope);
        const [regionList, networkList] = await Promise.all([listHostPoolRegions(token, subscriptionId), listVirtualNetworks(token, subscriptionId)]);
        if (cancelled) return;
        setRegions(regionList);
        setNetworks(networkList);
        setLocation((current) => (regionList.some((r) => r.name === current) ? current : (regionList.find((r) => r.name === 'uksouth') ?? regionList[0])?.name ?? ''));
      } catch (e) {
        if (!cancelled) setError(message(e));
      }
    })();
    return () => { cancelled = true; };
  }, [subscriptionId, getToken]);

  // The worker needs Reader on the target subscription before it can generate and preview.
  useEffect(() => {
    setWorkerAccess(null);
    if (!workerConfigured || !subscriptionId) return;
    let cancelled = false;
    (async () => {
      try {
        const ok = await workerCanRead(await getToken(armScope), subscriptionId);
        if (!cancelled) setWorkerAccess({ subscriptionId, ok });
      } catch (e) {
        if (!cancelled) setWorkerAccess({ subscriptionId, ok: false, error: message(e) });
      }
    })();
    return () => { cancelled = true; };
  }, [subscriptionId, getToken]);

  async function allowWorker() {
    setSubmitting('Giving the portal worker Reader on this subscription…');
    try {
      await grantWorkerReader(await getToken(armScope, true), subscriptionId);
      setWorkerAccess({ subscriptionId, ok: true });
    } catch (e) {
      setWorkerAccess({ subscriptionId, ok: false, error: message(e) });
    } finally {
      setSubmitting(null);
    }
  }

  // Resource group: exists, and in which region.
  useEffect(() => {
    setRgStatus(null);
    if (!subscriptionId || !location || !patterns.resourceGroup.test(rgName)) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const existing = await getResourceGroupLocation(await getToken(armScope), subscriptionId, rgName);
        if (cancelled) return;
        const clash = existing !== null && existing !== location;
        setRgStatus({ text: existing === null ? 'Will be created.' : `Exists in ${existing}${clash ? ' - choose that region or another name.' : '.'}`, clash });
      } catch (e) {
        if (!cancelled) setRgStatus({ text: message(e), clash: false });
      }
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [subscriptionId, location, rgName, getToken]);

  // VM size availability and quota for the recommendation, as the wizard's /api/capacity does.
  const capacityKey = rec && subscriptionId && location ? `${subscriptionId}|${location}|${rec.vmSize}|${rec.count}` : '';
  useEffect(() => {
    if (!capacityKey || !rec) { setCapacity(null); return; }
    let cancelled = false;
    setCapacity({ key: capacityKey, status: 'checking' });
    (async () => {
      try {
        const cacheKey = `${subscriptionId}|${location}`;
        let data = capacityCache.current.get(cacheKey);
        if (!data) {
          data = getToken(armScope).then((token) => getComputeCapacityData(token, subscriptionId, location));
          capacityCache.current.set(cacheKey, data);
          data.catch(() => capacityCache.current.delete(cacheKey));
        }
        const { skus, usages } = await data;
        if (!cancelled) setCapacity({ key: capacityKey, status: 'done', result: evaluateCapacity(skus, usages, location, rec.vmSize, rec.count) });
      } catch (e) {
        if (!cancelled) setCapacity({ key: capacityKey, status: 'unverified', message: message(e) });
      }
    })();
    return () => { cancelled = true; };
    // capacityKey captures every input the check depends on.
  }, [capacityKey]);

  const current = capacity && capacity.key === capacityKey ? capacity : null;
  const vmOptions: string[] = !rec || !current || current.status === 'checking' ? []
    : current.status === 'unverified' ? [rec.vmSize]
    : current.result.ok ? [...new Set([rec.vmSize, ...current.result.alternatives])]
    : current.result.alternatives;
  const vmSize = vmOptions.includes(vmSizeChoice) ? vmSizeChoice : (vmOptions[0] ?? '');

  function collect(): { answers: Answers; errors: string[] } {
    const errors: string[] = [];
    const answers: Answers = {
      answersVersion: '1.0.0', SubscriptionId: subscriptionId, Location: location, Prefix: prefix.trim(), ResourceGroupName: rgName,
      NetworkMode: networkMode, Hosting: hosting, Persona: persona, Users: Number(users), ImageSku: imageSku, VmSize: vmSize,
      ScalingPreset: scaling, WorkspaceName: workspaceName.trim(), DesktopName: desktopName.trim(),
    };
    if (!subscriptionId) errors.push('Choose a subscription.');
    if (!location) errors.push('Choose a region.');
    if (!patterns.prefix.test(answers.Prefix)) errors.push('Prefix: start with a letter; letters, digits and hyphens; max 10.');
    if (!patterns.resourceGroup.test(rgName)) errors.push('Resource group: 1-90 letters, digits, ._-() characters.');
    if (rgStatus?.clash) errors.push('The resource group exists in another region.');
    if (networkMode === 'New') {
      answers.AddressSpace = addressSpace.trim();
      const r = cidrRange(answers.AddressSpace);
      if (!r || !r.aligned || r.bits < 16 || r.bits > 24 || !answers.AddressSpace.endsWith('.0/' + r.bits)) errors.push('Address space must be an aligned /16 to /24 range.');
    } else {
      Object.assign(answers, { VirtualNetworkName: vnet?.name, SessionHostSubnet: hostSubnet, PrivateEndpointSubnet: peSubnet });
      if (!vnet || !hostSubnet || !peSubnet) errors.push('Choose a VNet and both subnets.');
    }
    for (const role of ['users', 'admins'] as const) {
      const key = role === 'users' ? 'Users' : 'Admins';
      if (groups[role].mode === 'new') {
        answers[`New${key}Group`] = groupName(role).trim();
        if (!patterns.groupName.test(answers[`New${key}Group`]!)) errors.push(`Enter a valid name for the new ${role} group.`);
      } else {
        answers[`${key}Group`] = groups[role].selected;
        if (!groups[role].selected) errors.push(`Choose an existing ${role} group.`);
      }
    }
    if ((answers.UsersGroup && answers.UsersGroup === answers.AdminsGroup) || (answers.NewUsersGroup && answers.NewUsersGroup === answers.NewAdminsGroup)) errors.push('The users and admins groups must be different.');
    if (groups.users.mode === 'new') answers.AddMeToUsersGroup = addMe;
    if (sizing.error) errors.push(sizing.error);
    if (!vmSize) errors.push('Wait for the VM size check and choose an available size.');
    if (hosting === 'Shared') {
      Object.assign(answers, { PeakConcurrencyPct: Number(peak), UserIdentity: identity, ProfileFailureAction: profileFailure });
      if (identity === 'Hybrid') {
        Object.assign(answers, { KerberosDomainName: domainName.trim(), KerberosDomainGuid: domainGuid.trim() });
        if (!patterns.domainName.test(answers.KerberosDomainName!)) errors.push('Enter the AD domain name.');
        if (!patterns.guid.test(answers.KerberosDomainGuid!)) errors.push('Enter the AD domain GUID.');
      }
    }
    if (scaling === 'BusinessHours') {
      Object.assign(answers, { TimeZone: timeZone, WorkdayStart: dayStart, WorkdayEnd: dayEnd });
      if (dayEnd <= dayStart) errors.push('The working day must end after it starts.');
    }
    for (const [label, value] of [['Workspace name', answers.WorkspaceName], ['Desktop name', answers.DesktopName]]) {
      if (!patterns.displayName.test(value)) errors.push(`${label}: 1-64 characters, no < or >.`);
    }
    return { answers, errors };
  }

  // Creates any new groups as the operator (the worker has no Graph rights), saves the answers and starts Preview.
  async function onRunPreview() {
    const { answers, errors } = collect();
    setValidation(errors);
    if (errors.length) return;
    const account = instance.getActiveAccount();
    const oid = (account?.idTokenClaims?.oid as string | undefined) ?? account?.localAccountId;
    try {
      if (!oid) throw new Error('Could not read your Entra object ID; sign out and in again.');
      for (const [role, key] of [['users', 'Users'], ['admins', 'Admins']] as const) {
        const name = answers[`New${key}Group`];
        if (!name) continue;
        setSubmitting(`Creating or finding the ${role} group '${name}'…`);
        const group = await ensureSecurityGroup(await getToken(groupWriteScope, true), name, role, oid, role === 'users' && !!answers.AddMeToUsersGroup);
        answers[`${key}Group`] = group.id;
        delete answers[`New${key}Group`];
      }
      delete answers.AddMeToUsersGroup;
      setSubmitting('Saving the answers…');
      const jobId = crypto.randomUUID();
      const storageToken = await getToken(storageScope, true);
      const record: RunRecord = {
        jobId, createdUtc: new Date().toISOString(), createdBy: account?.username ?? '', subscriptionId: answers.SubscriptionId,
        resourceGroup: answers.ResourceGroupName, prefix: answers.Prefix, executions: [],
      };
      await putJobBlob(storageToken, `${jobId}/answers.json`, JSON.stringify(answers, null, 2));
      setSubmitting('Starting Preview in Azure…');
      const name = await startWorker(await getToken(armScope, true), { JOB_ID: jobId, JOB_ACTION: 'preview' });
      record.executions.push({ action: 'preview', name, startedUtc: new Date().toISOString() });
      await putJobBlob(storageToken, `${jobId}/run.json`, JSON.stringify(record, null, 2));
      window.location.hash = `#/runs/${jobId}`;
    } catch (e) {
      setValidation([message(e)]);
    } finally {
      setSubmitting(null);
    }
  }

  function onDownload() {
    const { answers, errors } = collect();
    setValidation(errors);
    if (errors.length) return;
    setDownloaded({ fileName: downloadAnswers(answers), prefix: cleanPrefix });
  }

  if (error) return <section><div className="note err">{error}</div></section>;
  if (!subscriptions) return <section><p className="hint">Loading your subscriptions…</p></section>;
  if (!subscriptions.length) return <section><div className="note warn">You don't have access to any enabled subscriptions in this tenant.</div></section>;

  const overlaps = networkMode === 'New' ? overlappingPrefixes(addressSpace, existingPrefixes) : [];
  const configPath = downloaded ? `.\\sandbox\\${downloaded.prefix}.json` : '';

  return (
    <>
      <Section n={1} title="Azure location">
        <div className="grid">
          <Field label="Subscription">
            <select value={subscriptionId} onChange={(e) => setSubscriptionId(e.target.value)}>
              {subscriptions.map((s) => <option key={s.subscriptionId} value={s.subscriptionId}>{s.displayName} ({s.subscriptionId})</option>)}
            </select>
            {workerAccess && !workerAccess.ok && (
              <div className="note warn">
                {workerAccess.error ? `Could not check the portal worker's access: ${workerAccess.error}` : 'The portal worker cannot read this subscription yet. It needs Reader to build the configuration and run Preview; write access is granted per resource group when you prepare a deployment.'}
                <div><button className="secondary" disabled={!!submitting} onClick={allowWorker}>Give the worker Reader (as me)</button></div>
              </div>
            )}
          </Field>
          <Field label="Region" hint="Regions that support AVD host pools.">
            <select value={location} onChange={(e) => setLocation(e.target.value)} disabled={!regions}>
              {!regions && <option>Loading…</option>}
              {regions?.map((r) => <option key={r.name} value={r.name}>{r.displayName} ({r.name})</option>)}
            </select>
          </Field>
          <Field label="Name prefix" hint="Letters, digits, hyphens; max 10. Used in resource names.">
            <input type="text" value={prefix} maxLength={10} onChange={(e) => setPrefix(e.target.value)} />
          </Field>
          <Field label="Resource group">
            <input type="text" value={rgName} onChange={(e) => setRgOverride(e.target.value)} />
            {rgStatus && <div className="hint" style={rgStatus.clash ? { color: 'var(--err)' } : undefined}>{rgStatus.text}</div>}
          </Field>
        </div>
      </Section>

      <Section n={2} title="Network">
        <Choices value={networkMode} onChange={setNetworkMode} options={[
          ['New', 'Create a new VNet', 'With NAT gateway for outbound access. Recommended for a new environment.'],
          ['Existing', 'Use an existing VNet', 'Must be in the chosen region and have outbound internet access.'],
        ]} />
        {networkMode === 'New' ? (
          <div className="grid" style={{ marginTop: 12 }}>
            <Field label="Address space" hint="/16 to /24 private range. Session hosts use the first /25, the storage private endpoint a /27.">
              <input type="text" value={addressSpace} onChange={(e) => setAddressOverride(e.target.value)} />
            </Field>
            <div>{overlaps.length > 0 && <div className="note warn">Overlaps {overlaps.join(', ')}. That only matters if the networks will ever be connected.</div>}</div>
          </div>
        ) : (
          <div className="grid" style={{ marginTop: 12 }}>
            <Field label="Virtual network" full>
              <select value={vnet?.name ?? ''} onChange={(e) => setVnetName(e.target.value)} disabled={!regionalNetworks.length}>
                {!regionalNetworks.length && <option value="">No VNets in this region</option>}
                {regionalNetworks.map((n) => <option key={`${n.resourceGroup}/${n.name}`} value={n.name}>{n.name} ({n.resourceGroup}, {n.addressPrefixes.join(', ')})</option>)}
              </select>
            </Field>
            <Field label="Session host subnet">
              <select value={hostSubnet} onChange={(e) => setHostSubnetChoice(e.target.value)}>{subnets.map((s) => <option key={s}>{s}</option>)}</select>
            </Field>
            <Field label="Private endpoint subnet">
              <select value={peSubnet} onChange={(e) => setPeSubnetChoice(e.target.value)}>{subnets.map((s) => <option key={s}>{s}</option>)}</select>
            </Field>
          </div>
        )}
      </Section>

      <Section n={3} title="Access groups">
        <div className="grid">
          {(['users', 'admins'] as const).map((role) => (
            <GroupPicker key={role} role={role} choice={groups[role]} defaultName={groupName(role)} getToken={getToken}
              onChange={(choice) => setGroups((g) => ({ ...g, [role]: choice }))}>
              {role === 'users' && groups.users.mode === 'new' && (
                <label className="check"><input type="checkbox" checked={addMe} onChange={(e) => setAddMe(e.target.checked)} /> Add me to this group so I can test sign-in</label>
              )}
            </GroupPicker>
          ))}
        </div>
      </Section>

      <Section n={4} title="Users and sizing">
        <Choices value={hosting} onChange={setHosting} options={[
          ['Shared', 'Shared platform', 'Users share multi-session hosts (pooled). Profiles roam with FSLogix.'],
          ['Dedicated', 'Dedicated session hosts', 'Each user gets their own VM (personal). Profile stays on the VM.'],
        ]} />
        <div className="grid" style={{ marginTop: 12 }}>
          <Field label="Persona" full hint={personas.find((p) => p.id === persona)?.description}>
            <select value={persona} onChange={(e) => setPersona(e.target.value as PersonaId)}>
              {personas.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </Field>
          <Field label="Session host image" full hint={imageSku.endsWith('-m365')
            ? 'Apps included. Eligible Microsoft 365 licensing and shared computer activation are required. Use Intune for ongoing policies and updates.'
            : `Apps are not included. Install Microsoft 365 Apps separately through Intune if needed.${hostPoolType === 'Personal' ? ' Microsoft does not publish an equivalent single-session Apps image in this catalog.' : ''}`}>
            <select value={imageSku} onChange={(e) => setImageByType((m) => ({ ...m, [hostPoolType]: e.target.value }))}>
              {images.map((i) => <option key={i.sku} value={i.sku}>{i.label}</option>)}
            </select>
          </Field>
          <Field label="Number of users">
            <input type="number" min={1} max={5000} value={users} onChange={(e) => setUsers(e.target.value)} />
          </Field>
          {hosting === 'Shared' && (
            <Field label="Peak concurrency (%)" hint="Share of users signed in at the same time.">
              <input type="number" min={1} max={100} value={peak} onChange={(e) => setPeak(e.target.value)} />
            </Field>
          )}
        </div>
        <div className="sizing">
          {rec ? (
            <>
              <strong>Recommendation: {rec.count} x {rec.vmSize}{rec.maxSessionLimit ? `, up to ${rec.maxSessionLimit} sessions per host` : ', one VM per user'}</strong>
              <ul>{rec.explanation.map((line) => <li key={line}>{line}</li>)}</ul>
            </>
          ) : sizing.error}
        </div>
        {rec && <CapacityNote capacity={current} rec={rec} location={location} />}
        <div style={{ marginTop: 10 }}>
          <Field label="Session host VM size" hint="The recommended size is selected when available. Alternatives have the same vCPU count and are checked for regional availability and quota for every host. Preview checks the selected size again.">
            <select value={vmSize} onChange={(e) => setVmSizeChoice(e.target.value)} disabled={!vmOptions.length}>
              {!vmOptions.length && <option value="">{current?.status === 'checking' || !current ? 'Checking…' : 'No sizes available with sufficient quota'}</option>}
              {vmOptions.map((s) => <option key={s} value={s}>{s}{rec && s === rec.vmSize ? ` (Recommended${current?.status === 'unverified' ? '; availability unverified' : ''})` : ''}</option>)}
            </select>
          </Field>
        </div>
      </Section>

      {hosting === 'Shared' && (
        <Section n={5} title="User profiles (FSLogix)">
          <Choices value={identity} onChange={setIdentity} options={[
            ['CloudOnly', 'Cloud-only identities', 'Microsoft Entra ID only. Microsoft preview with extra admin prerequisites.'],
            ['Hybrid', 'Hybrid identities', 'Synced from on-premises Active Directory. Generally available.'],
          ]} />
          {identity === 'Hybrid' ? (
            <div className="grid" style={{ marginTop: 12 }}>
              <Field label="AD domain name" hint="Get-ADDomain DNSRoot"><input type="text" placeholder="corp.contoso.com" value={domainName} onChange={(e) => setDomainName(e.target.value)} /></Field>
              <Field label="AD domain GUID" hint="Get-ADDomain ObjectGUID"><input type="text" placeholder="00000000-0000-0000-0000-000000000000" value={domainGuid} onChange={(e) => setDomainGuid(e.target.value)} /></Field>
            </div>
          ) : (
            <div className="note warn">Cloud-only FSLogix is a Microsoft preview. Its Entra prerequisites (admin consent, the cloud group SID tag, private-link names, the MFA Conditional Access exclusion and folder permissions) are applied by Deploy with -PostDeploy.</div>
          )}
          <label style={{ marginTop: 12 }}>If a user's profile cannot load</label>
          <Choices value={profileFailure} onChange={setProfileFailure} options={[
            ['TempProfile', 'Use a temporary profile', 'The user can work, but changes are lost at sign-out. Easier while piloting.'],
            ['Block', 'Block the sign-in', 'The problem is visible straight away and no work is lost. Recommended for production.'],
          ]} />
        </Section>
      )}

      <Section n={hosting === 'Shared' ? 6 : 5} title="Scaling">
        <Choices value={scaling} onChange={setScaling} options={[
          ['BusinessHours', 'Business hours', 'One host always on, spare host ready while people work, scale down when quiet.'],
          ['None', 'Always available', 'No scaling plan; all hosts stay running.'],
        ]} />
        {scaling === 'BusinessHours' && (
          <div className="grid" style={{ marginTop: 12 }}>
            <Field label="Time zone" full>
              <select value={timeZone} onChange={(e) => setTimeZoneOverride(e.target.value)}>
                {timeZones.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
            </Field>
            <Field label="Working day starts"><select value={dayStart} onChange={(e) => setDayStart(e.target.value)}>{dayTimes.map((t) => <option key={t}>{t}</option>)}</select></Field>
            <Field label="Working day ends"><select value={dayEnd} onChange={(e) => setDayEnd(e.target.value)}>{dayTimes.map((t) => <option key={t}>{t}</option>)}</select></Field>
          </div>
        )}
      </Section>

      <Section n={hosting === 'Shared' ? 7 : 6} title="What users see">
        <div className="grid">
          <Field label="Workspace name" hint="The heading in Windows App and the web client.">
            <input type="text" maxLength={64} value={workspaceName} onChange={(e) => setWorkspaceOverride(e.target.value)} />
          </Field>
          <Field label="Desktop name" hint={'The desktop tile users select (Azure\'s default is "SessionDesktop").'}>
            <input type="text" maxLength={64} value={desktopName} onChange={(e) => setDesktopOverride(e.target.value)} />
          </Field>
        </div>
      </Section>

      <Section n={hosting === 'Shared' ? 8 : 7} title="Create configuration">
        {workerConfigured ? (
          <p className="hint">Run Preview in Azure creates any new groups as you, then the portal worker builds the configuration and previews it. You review the plan, prepare the foundation with your own rights if needed, and approve the deployment.</p>
        ) : (
          <p className="hint">The portal saves your answers as a file. <code>avd.ps1</code> turns them into a validated configuration, creating any new groups and checking resource names as you, then you run Preview and Deploy.</p>
        )}
        {validation.length > 0 && <div className="note err"><ul>{validation.map((v) => <li key={v}>{v}</li>)}</ul></div>}
        {submitting && <div className="note">{submitting}</div>}
        <div className="actions">
          {workerConfigured && <button disabled={!!submitting || !(workerAccess?.subscriptionId === subscriptionId && workerAccess.ok)} title={workerAccess?.ok ? undefined : 'The portal worker needs Reader on this subscription first.'} onClick={onRunPreview}>Run Preview in Azure</button>}
          <button className={workerConfigured ? 'secondary' : undefined} onClick={onDownload}>Download answers</button>
        </div>
        {downloaded && (
          <div style={{ marginTop: 12 }}>
            <div className="note ok">Saved {downloaded.fileName} to your downloads. Move it into your AVD-Deploy folder, then run:</div>
            <Command text={`.\\avd.ps1 -Mode New -AnswersFile .\\${downloaded.fileName} -OutputFile ${configPath}`} />
            <Command text={`.\\avd.ps1 -Mode Preview -ConfigurationFile ${configPath}`} />
            <Command text={`.\\avd.ps1 -Mode Deploy -ConfigurationFile ${configPath} -AsSignedInUser -PostDeploy`} />
          </div>
        )}
      </Section>
    </>
  );
}

function Section({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return <section><h2><span className="n">{n}</span>{title}</h2>{children}</section>;
}

function Field({ label, hint, full, children }: { label: string; hint?: string; full?: boolean; children: ReactNode }) {
  return (
    <div className={full ? 'full' : undefined}>
      <label>{label}{children}</label>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

function Choices<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string, string][] }) {
  const name = useId();
  return (
    <div className="choices">
      {options.map(([v, text, sub]) => (
        <label key={v} className={v === value ? 'choice selected' : 'choice'}>
          <input type="radio" name={name} checked={v === value} onChange={() => onChange(v)} />{text}<small>{sub}</small>
        </label>
      ))}
    </div>
  );
}

function CapacityNote({ capacity, rec, location }: { capacity: Capacity | null; rec: { vmSize: string; count: number }; location: string }) {
  if (!capacity || capacity.status === 'checking') return <div className="note">Checking {rec.vmSize} availability in {location}…</div>;
  if (capacity.status === 'unverified') return <div className="note warn">Could not check VM availability ({capacity.message}). Preview will check it again.</div>;
  const { result } = capacity;
  if (result.ok) return <div className="note ok">{rec.vmSize} is available to this subscription in {location} with enough vCPU quota for {rec.count} host(s).</div>;
  return (
    <div className={result.alternatives.length ? 'note warn' : 'note err'}>
      {result.blockers.join(' ')} {result.alternatives.length
        ? `Available sizes with the same vCPUs and enough quota: ${result.alternatives.join(', ')}.`
        : 'No other size with the same vCPUs is available with enough quota; try another region, a smaller user count, or request a quota increase.'}
    </div>
  );
}

function GroupPicker({ role, choice, defaultName, getToken, onChange, children }: {
  role: Role; choice: GroupChoice; defaultName: string; getToken: ReturnType<typeof useAccessToken>;
  onChange: (c: GroupChoice) => void; children?: ReactNode;
}) {
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<Group[] | null>(null);
  const [problem, setProblem] = useState<{ text: string; consent: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (choice.mode !== 'existing') return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const found = await searchGroups(await getToken(groupReadScope), search);
        if (!cancelled) { setResults(found); setProblem(null); }
      } catch (e) {
        if (!cancelled) setProblem({ text: e instanceof InteractionNeededError ? 'Searching groups needs permission to read group names.' : message(e), consent: e instanceof InteractionNeededError });
      }
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [choice.mode, search, attempt, getToken]);

  async function grant() {
    try {
      await getToken(groupReadScope, true);
      setAttempt((a) => a + 1);
    } catch (e) {
      setProblem({ text: `${message(e)} An administrator may need to grant consent to GroupMember.Read.All (see portal/README.md).`, consent: false });
    }
  }

  return (
    <div>
      <label>{role === 'users' ? 'AVD users group' : 'AVD admins group'}</label>
      <Choices value={choice.mode} onChange={(mode) => onChange({ ...choice, mode })} options={[
        ['new', 'Create new', 'Security group; you become owner'],
        ['existing', 'Use existing', 'Search Entra by name'],
      ]} />
      {choice.mode === 'new' ? (
        <div style={{ marginTop: 8 }}>
          <input type="text" aria-label={`New ${role} group name`} value={defaultName} onChange={(e) => onChange({ ...choice, newName: e.target.value })} />
          {children}
        </div>
      ) : (
        <div style={{ marginTop: 8 }}>
          <input type="text" placeholder="Type to search groups" value={search} onChange={(e) => setSearch(e.target.value)} />
          {problem ? (
            <div className="note warn">{problem.text} {problem.consent && <button className="secondary" onClick={grant}>Allow group search</button>}</div>
          ) : (
            <select size={5} style={{ marginTop: 6 }} value={choice.selected} onChange={(e) => onChange({ ...choice, selected: e.target.value })}>
              {results === null && <option value="" disabled>Loading…</option>}
              {results?.length === 0 && <option value="" disabled>No matching groups</option>}
              {results?.map((g) => <option key={g.id} value={g.id}>{g.displayName}</option>)}
            </select>
          )}
        </div>
      )}
    </div>
  );
}

function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="cmd">
      <code>{text}</code>
      <button className="secondary" onClick={() => navigator.clipboard.writeText(text).then(() => setCopied(true))}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  );
}
