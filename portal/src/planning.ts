// Planning helpers ported from the PowerShell modules so the form works without a backend.
// avd.ps1 -Mode New -AnswersFile re-validates everything, so a mismatch fails there rather than deploying.
import sizingProfiles from '../../contracts/sizing-profiles.json';
import type { ComputeSku, Usage } from './arm';

export type Hosting = 'Shared' | 'Dedicated';
export type PersonaId = 'Frontline' | 'Standard' | 'Heavy';

export const personas = (['Frontline', 'Standard', 'Heavy'] as const).map((id) => ({ id, ...sizingProfiles.personas[id] }));

export interface Recommendation {
  hostPoolType: 'Pooled' | 'Personal';
  maxSessionLimit?: number;
  count: number;
  vmSize: string;
  explanation: string[];
}

const maximumHosts = 100;

// Get-AvdSizingRecommendation (lib/AvdSizing.psm1).
export function recommend(hosting: Hosting, personaId: PersonaId, users: number, peakConcurrencyPct: number): Recommendation {
  const persona = sizingProfiles.personas[personaId];
  if (hosting === 'Dedicated') {
    if (users > maximumHosts) throw new Error(`Dedicated hosting needs one VM per user; ${users} users exceeds the maximum of ${maximumHosts} session hosts per pool.`);
    return {
      hostPoolType: 'Personal',
      count: users,
      vmSize: persona.dedicatedVmSize,
      explanation: [
        `Dedicated: one personal VM per user (${users} users = ${users} hosts), assigned to named users with -Mode AddUser.`,
        `${persona.label} (${persona.microsoftWorkload} workload): ${persona.dedicatedVmSize} per user.`,
      ],
    };
  }
  const { shared } = sizingProfiles;
  const usersPerHost = Math.trunc(shared.vcpus * persona.usersPerVcpu);
  const peakUsers = Math.max(1, Math.ceil((users * peakConcurrencyPct) / 100));
  const capacityHosts = Math.ceil(peakUsers / usersPerHost);
  const count = capacityHosts + shared.spareHosts;
  if (count > maximumHosts) throw new Error(`Shared sizing needs ${count} session hosts, which exceeds the maximum of ${maximumHosts} per pool. Split users across pools.`);
  return {
    hostPoolType: 'Pooled',
    maxSessionLimit: usersPerHost,
    count,
    vmSize: shared.vmSize,
    explanation: [
      `Shared: ${users} users at ${peakConcurrencyPct}% peak = ${peakUsers} concurrent sessions.`,
      `${persona.label} (${persona.microsoftWorkload} workload): ${persona.usersPerVcpu} users/vCPU x ${shared.vcpus} vCPU ${shared.vmSize} = ${usersPerHost} sessions per host.`,
      `${capacityHosts} host(s) for capacity + ${shared.spareHosts} spare = ${count} host(s).`,
    ],
  };
}

// Get-AvdImageOptions (lib/AvdDeployment.psm1).
export function imageOptions(hostPoolType: 'Pooled' | 'Personal'): { sku: string; label: string }[] {
  return hostPoolType === 'Personal'
    ? [{ sku: 'win11-24h2-ent', label: 'Windows 11 Enterprise 24H2 (single-session; install Apps through Intune)' }]
    : [
        { sku: 'win11-24h2-avd-m365', label: 'Windows 11 Enterprise 24H2 multi-session with Microsoft 365 Apps' },
        { sku: 'win11-24h2-avd', label: 'Windows 11 Enterprise 24H2 multi-session (without Microsoft 365 Apps)' },
      ];
}

export function cidrRange(cidr: string): { start: number; end: number; aligned: boolean; bits: number } | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr.trim());
  if (!m || [1, 2, 3, 4].some((i) => +m[i] > 255) || +m[5] > 32) return null;
  const ip = +m[1] * 2 ** 24 + +m[2] * 2 ** 16 + +m[3] * 2 ** 8 + +m[4];
  const size = 2 ** (32 - +m[5]);
  return { start: ip, end: ip + size - 1, aligned: ip % size === 0, bits: +m[5] };
}

function overlaps(a: string, b: string): boolean {
  const x = cidrRange(a);
  const y = cidrRange(b);
  if (!x || !y) return false;
  const xs = x.start - (x.start % (x.end - x.start + 1));
  const ys = y.start - (y.start % (y.end - y.start + 1));
  return xs <= ys + (y.end - y.start) && ys <= xs + (x.end - x.start);
}

export function overlappingPrefixes(cidr: string, existing: string[]): string[] {
  return existing.filter((p) => overlaps(cidr, p));
}

// Get-AvdFreeAddressSpace (lib/AvdDiscovery.psm1).
export function proposeAddressSpace(existing: string[]): string {
  for (let second = 200; second <= 250; second++) {
    const candidate = `10.${second}.0.0/24`;
    if (overlappingPrefixes(candidate, existing).length === 0) return candidate;
  }
  return '';
}

export interface CapacityResult {
  ok: boolean;
  blockers: string[];
  alternatives: string[];
}

// Get-AvdComputeCapacity (lib/AvdDeployment.psm1) for a new estate, where every host is new.
export function evaluateCapacity(skus: ComputeSku[], usages: Usage[], location: string, size: string, newHosts: number): CapacityResult {
  const blockers: string[] = [];
  const capability = (s: ComputeSku, name: string) => s.capabilities?.find((c) => c.name === name)?.value;
  const freeQuota = (key: string | undefined) => {
    const u = usages.find((x) => x.name.value === key);
    return u ? u.limit - u.currentValue : null;
  };
  const restricted = (s: ComputeSku) => (s.restrictions ?? []).some((r) => r.type === 'Location' && r.reasonCode === 'NotAvailableForSubscription');
  const sku = skus.find((s) => s.name === size);
  const targetVcpus = sku ? Number(capability(sku, 'vCPUs')) : Number(/^Standard_[A-Z]+(\d+)/.exec(size)?.[1] ?? 0);
  const need = newHosts * targetVcpus;

  // Alternatives must suit the template: general-purpose D-series, Gen2, Trusted Launch, premium disks, unrestricted, with quota.
  const total = freeQuota('cores');
  const alternatives = [
    ...new Set(
      skus
        .filter((s) =>
          s.name !== size &&
          /^Standard_D\d+[a-z]*s_v\d+$/.test(s.name) &&
          Number(capability(s, 'vCPUs')) === targetVcpus &&
          /V2/.test(capability(s, 'HyperVGenerations') ?? '') &&
          capability(s, 'TrustedLaunchDisabled') !== 'True' &&
          capability(s, 'PremiumIO') === 'True' &&
          !restricted(s))
        .filter((s) => {
          const family = freeQuota(s.family);
          return (family === null || family >= need) && (total === null || total >= need);
        })
        .sort((a, b) => Number(/_v(\d+)$/.exec(b.name)?.[1]) - Number(/_v(\d+)$/.exec(a.name)?.[1]))
        .map((s) => s.name),
    ),
  ].slice(0, 5);

  if (!sku) {
    blockers.push(`VM size ${size} is not offered in ${location}.`);
  } else if (restricted(sku)) {
    blockers.push(`VM size ${size} is restricted for this subscription in ${location}.`);
  } else if (need > 0) {
    for (const [key, label] of [[sku.family, `${sku.family} vCPUs`], ['cores', 'Total regional vCPUs']] as const) {
      const usage = usages.find((u) => u.name.value === key);
      if (usage && usage.limit - usage.currentValue < need) {
        blockers.push(`Not enough quota for ${newHosts} x ${size} in ${location}: ${label} needs ${need}, ${usage.limit - usage.currentValue} free (limit ${usage.limit}).`);
      }
    }
  }
  return { ok: blockers.length === 0, blockers, alternatives };
}

// Get-SuggestedTimeZone (avd.ps1).
const regionZones: Record<string, string> = {
  uksouth: 'GMT Standard Time', ukwest: 'GMT Standard Time', northeurope: 'GMT Standard Time', westeurope: 'W. Europe Standard Time',
  eastus: 'Eastern Standard Time', eastus2: 'Eastern Standard Time', canadacentral: 'Eastern Standard Time', canadaeast: 'Eastern Standard Time',
  centralus: 'Central Standard Time', northcentralus: 'Central Standard Time', southcentralus: 'Central Standard Time', westcentralus: 'Mountain Standard Time',
  westus: 'Pacific Standard Time', westus2: 'Pacific Standard Time', westus3: 'US Mountain Standard Time',
  australiaeast: 'AUS Eastern Standard Time', japaneast: 'Tokyo Standard Time', japanwest: 'Tokyo Standard Time', koreacentral: 'Korea Standard Time',
  eastasia: 'China Standard Time', southeastasia: 'Singapore Standard Time', centralindia: 'India Standard Time', southafricanorth: 'South Africa Standard Time',
};

export function suggestedTimeZone(region: string): string {
  return regionZones[region] ?? 'GMT Standard Time';
}

// Windows time zone IDs (the scaling plan needs Windows IDs, not IANA names). Generation re-checks the ID.
export const timeZones: [id: string, label: string][] = [
  ['UTC', '(UTC) Coordinated Universal Time'],
  ['GMT Standard Time', '(UTC+00:00) Dublin, Edinburgh, Lisbon, London'],
  ['W. Europe Standard Time', '(UTC+01:00) Amsterdam, Berlin, Bern, Rome, Stockholm, Vienna'],
  ['Romance Standard Time', '(UTC+01:00) Brussels, Copenhagen, Madrid, Paris'],
  ['Central Europe Standard Time', '(UTC+01:00) Belgrade, Bratislava, Budapest, Ljubljana, Prague'],
  ['Central European Standard Time', '(UTC+01:00) Sarajevo, Skopje, Warsaw, Zagreb'],
  ['GTB Standard Time', '(UTC+02:00) Athens, Bucharest'],
  ['FLE Standard Time', '(UTC+02:00) Helsinki, Kyiv, Riga, Sofia, Tallinn, Vilnius'],
  ['South Africa Standard Time', '(UTC+02:00) Harare, Pretoria'],
  ['Israel Standard Time', '(UTC+02:00) Jerusalem'],
  ['Turkey Standard Time', '(UTC+03:00) Istanbul'],
  ['Arab Standard Time', '(UTC+03:00) Kuwait, Riyadh'],
  ['Arabian Standard Time', '(UTC+04:00) Abu Dhabi, Muscat'],
  ['India Standard Time', '(UTC+05:30) Chennai, Kolkata, Mumbai, New Delhi'],
  ['SE Asia Standard Time', '(UTC+07:00) Bangkok, Hanoi, Jakarta'],
  ['China Standard Time', '(UTC+08:00) Beijing, Chongqing, Hong Kong, Urumqi'],
  ['Singapore Standard Time', '(UTC+08:00) Kuala Lumpur, Singapore'],
  ['W. Australia Standard Time', '(UTC+08:00) Perth'],
  ['Tokyo Standard Time', '(UTC+09:00) Osaka, Sapporo, Tokyo'],
  ['Korea Standard Time', '(UTC+09:00) Seoul'],
  ['Cen. Australia Standard Time', '(UTC+09:30) Adelaide'],
  ['E. Australia Standard Time', '(UTC+10:00) Brisbane'],
  ['AUS Eastern Standard Time', '(UTC+10:00) Canberra, Melbourne, Sydney'],
  ['New Zealand Standard Time', '(UTC+12:00) Auckland, Wellington'],
  ['Azores Standard Time', '(UTC-01:00) Azores'],
  ['E. South America Standard Time', '(UTC-03:00) Brasilia'],
  ['Atlantic Standard Time', '(UTC-04:00) Atlantic Time (Canada)'],
  ['Eastern Standard Time', '(UTC-05:00) Eastern Time (US & Canada)'],
  ['Central Standard Time', '(UTC-06:00) Central Time (US & Canada)'],
  ['Mountain Standard Time', '(UTC-07:00) Mountain Time (US & Canada)'],
  ['US Mountain Standard Time', '(UTC-07:00) Arizona'],
  ['Pacific Standard Time', '(UTC-08:00) Pacific Time (US & Canada)'],
  ['Alaskan Standard Time', '(UTC-09:00) Alaska'],
  ['Hawaiian Standard Time', '(UTC-10:00) Hawaii'],
];

export const dayTimes = Array.from({ length: 43 }, (_, i) => {
  const minutes = 60 + i * 30;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${minutes % 60 ? '30' : '00'}`;
});
