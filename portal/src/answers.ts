// The answers file contract: contracts/avd-answers.schema.json. Property names match the avd.ps1 parameters.
export interface Answers {
  answersVersion: '1.0.0';
  SubscriptionId: string;
  Location: string;
  Prefix: string;
  ResourceGroupName: string;
  NetworkMode: 'New' | 'Existing';
  AddressSpace?: string;
  VirtualNetworkName?: string;
  SessionHostSubnet?: string;
  PrivateEndpointSubnet?: string;
  UsersGroup?: string;
  AdminsGroup?: string;
  NewUsersGroup?: string;
  NewAdminsGroup?: string;
  AddMeToUsersGroup?: boolean;
  Hosting: 'Shared' | 'Dedicated';
  Persona: 'Frontline' | 'Standard' | 'Heavy';
  Users: number;
  PeakConcurrencyPct?: number;
  ImageSku: string;
  VmSize: string;
  UserIdentity?: 'Hybrid' | 'CloudOnly';
  KerberosDomainName?: string;
  KerberosDomainGuid?: string;
  ProfileFailureAction?: 'TempProfile' | 'Block';
  ScalingPreset: 'BusinessHours' | 'None';
  TimeZone?: string;
  WorkdayStart?: string;
  WorkdayEnd?: string;
  WorkspaceName: string;
  DesktopName: string;
}

export const patterns = {
  prefix: /^[A-Za-z][A-Za-z0-9-]{0,9}$/,
  resourceGroup: /^[A-Za-z0-9._()-]{1,90}$/,
  groupName: /^[^@"\\/[\]:|<>+=;,?*]{1,120}$/,
  domainName: /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/,
  guid: /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/,
  displayName: /^[^\u0000-\u001f<>]{1,64}$/,
};

export function downloadAnswers(answers: Answers): string {
  const fileName = `avd-answers-${answers.Prefix.toLowerCase()}.json`;
  const url = URL.createObjectURL(new Blob([JSON.stringify(answers, null, 2) + '\n'], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
  return fileName;
}
