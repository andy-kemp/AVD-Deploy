// Control-plane records (docs/hosted-service.md, data model). Memory for local runs and tests; Azure Table Storage,
// reached with the API's managed identity, when hosted.
import { RestError, TableClient } from '@azure/data-tables';
import { DefaultAzureCredential } from '@azure/identity';
import { HttpError } from './auth.ts';
import { isAvdRole, type AvdRole } from './roles.ts';
import type { Config } from './config.ts';

export type OrganisationStatus = 'pending' | 'approved' | 'declined' | 'suspended';

export interface OrganisationRecord {
  orgId: string;
  name: string;
  status: OrganisationStatus;
  requestedBy: string;
  /** As reported by the requester's browser; shown to AKC for context only. */
  requesterName: string;
  requesterEmail: string;
  requestedAt: string;
  decidedBy?: string;
  decidedAt?: string;
}

export interface MemberRoleRecord {
  orgId: string;
  userId: string;
  roles: AvdRole[];
  grantedBy: string;
  grantedAt: string;
}

/** One Connect tenant attempt, bound to the Clerk user and organisation that started it. Short-lived and single-use. */
export interface ConnectState {
  state: string;
  orgId: string;
  userId: string;
  stage: 'consent' | 'verify' | 'link';
  tenantId?: string;
  codeVerifier?: string;
  nonce?: string;
  expiresAt: string;
}

export interface TenantConnection {
  orgId: string;
  tenantId: string;
  tenantName: string;
  connectedBy: string;
  consentedByObjectId: string;
  consentedByUsername: string;
  connectedAt: string;
}

/** An operator's own Microsoft account in the organisation's connected tenant (one per organisation and user). */
export interface AccountLink {
  orgId: string;
  userId: string;
  tenantId: string;
  objectId: string;
  username: string;
  mfa: boolean;
  /** Refresh token sealed with the Key Vault key (sealer.ts). Never returned by the API. */
  sealedRefreshToken: string;
  linkedAt: string;
}

export interface Store {
  getOrganisation(orgId: string): Promise<OrganisationRecord | null>;
  /** Fails with 409 if a record already exists. */
  createOrganisation(record: OrganisationRecord): Promise<void>;
  listOrganisations(status?: OrganisationStatus): Promise<OrganisationRecord[]>;
  /** Moves a pending organisation to approved or declined; fails with 409 if it was decided meanwhile. */
  decideOrganisation(orgId: string, status: 'approved' | 'declined', by: string, at: string): Promise<OrganisationRecord>;
  getMemberRoles(orgId: string, userId: string): Promise<MemberRoleRecord | null>;
  putMemberRoles(record: MemberRoleRecord): Promise<void>;
  putConnectState(record: ConnectState): Promise<void>;
  /** Returns and deletes the state, so each one is used once. */
  takeConnectState(state: string): Promise<ConnectState | null>;
  getTenantConnection(orgId: string): Promise<TenantConnection | null>;
  /** Records the connection; fails with 409 if another organisation already owns the tenant. */
  connectTenant(record: TenantConnection): Promise<void>;
  getAccountLink(orgId: string, userId: string): Promise<AccountLink | null>;
  putAccountLink(record: AccountLink): Promise<void>;
  deleteAccountLink(orgId: string, userId: string): Promise<void>;
}

const tenantTaken = () => new HttpError(409, 'tenant-taken', 'This Microsoft tenant is already connected to another organisation. Contact hello@andykemp.com.');

const conflict = (message: string) => new HttpError(409, 'conflict', message);

export class MemoryStore implements Store {
  private organisations = new Map<string, OrganisationRecord>();
  private roles = new Map<string, MemberRoleRecord>();

  async getOrganisation(orgId: string) {
    const record = this.organisations.get(orgId);
    return record ? { ...record } : null;
  }

  async createOrganisation(record: OrganisationRecord) {
    if (this.organisations.has(record.orgId)) throw conflict('This organisation has already requested AVD.');
    this.organisations.set(record.orgId, { ...record });
  }

  async listOrganisations(status?: OrganisationStatus) {
    return [...this.organisations.values()].filter((o) => !status || o.status === status).map((o) => ({ ...o }));
  }

  async decideOrganisation(orgId: string, status: 'approved' | 'declined', by: string, at: string) {
    const record = this.organisations.get(orgId);
    if (!record) throw new HttpError(404, 'not-found', 'No AVD request for this organisation.');
    if (record.status !== 'pending') throw conflict(`This request was already ${record.status}.`);
    Object.assign(record, { status, decidedBy: by, decidedAt: at });
    return { ...record };
  }

  async getMemberRoles(orgId: string, userId: string) {
    const record = this.roles.get(`${orgId}/${userId}`);
    return record ? { ...record, roles: [...record.roles] } : null;
  }

  async putMemberRoles(record: MemberRoleRecord) {
    this.roles.set(`${record.orgId}/${record.userId}`, { ...record, roles: [...record.roles] });
  }

  private states = new Map<string, ConnectState>();
  private connections = new Map<string, TenantConnection>();
  private tenantOwners = new Map<string, string>();

  async putConnectState(record: ConnectState) {
    this.states.set(record.state, { ...record });
  }

  async takeConnectState(state: string) {
    const record = this.states.get(state);
    this.states.delete(state);
    return record ? { ...record } : null;
  }

  async getTenantConnection(orgId: string) {
    const record = this.connections.get(orgId);
    return record ? { ...record } : null;
  }

  async connectTenant(record: TenantConnection) {
    const owner = this.tenantOwners.get(record.tenantId);
    if (owner && owner !== record.orgId) throw tenantTaken();
    this.tenantOwners.set(record.tenantId, record.orgId);
    this.connections.set(record.orgId, { ...record });
  }

  private links = new Map<string, AccountLink>();

  async getAccountLink(orgId: string, userId: string) {
    const record = this.links.get(`${orgId}/${userId}`);
    return record ? { ...record } : null;
  }

  async putAccountLink(record: AccountLink) {
    this.links.set(`${record.orgId}/${record.userId}`, { ...record });
  }

  async deleteAccountLink(orgId: string, userId: string) {
    this.links.delete(`${orgId}/${userId}`);
  }
}

// Organisations: PartitionKey = Clerk org ID, RowKey = 'organisation'. Member roles: PartitionKey = org ID, RowKey = user ID.
// Connect states: PartitionKey = state, RowKey = 'state'. Tenant connections: PartitionKey = org ID, RowKey = 'tenant'.
// Tenant owners: PartitionKey = Entra tenant ID, RowKey = 'owner' (one organisation per tenant).
// Account links: PartitionKey = org ID, RowKey = user ID.
export class TableStore implements Store {
  private organisations: TableClient;
  private memberRoles: TableClient;
  private connectStates: TableClient;
  private tenantConnections: TableClient;
  private tenantOwners: TableClient;
  private accountLinks: TableClient;

  private constructor(client: (table: string) => TableClient) {
    this.organisations = client('organisations');
    this.memberRoles = client('memberroles');
    this.connectStates = client('connectstates');
    this.tenantConnections = client('tenantconnections');
    this.tenantOwners = client('tenantowners');
    this.accountLinks = client('accountlinks');
  }

  static async create(storage: Exclude<Config['storage'], { kind: 'memory' }>): Promise<TableStore> {
    const client = (table: string) =>
      storage.kind === 'connection-string'
        ? TableClient.fromConnectionString(storage.connectionString, table, { allowInsecureConnection: storage.connectionString.includes('127.0.0.1') })
        : new TableClient(`https://${storage.accountName}.table.core.windows.net`, table, new DefaultAzureCredential());
    const store = new TableStore(client);
    for (const table of [store.organisations, store.memberRoles, store.connectStates, store.tenantConnections, store.tenantOwners, store.accountLinks]) {
      try {
        await table.createTable();
      } catch (e) {
        if (!(e instanceof RestError && e.statusCode === 409)) throw e;
      }
    }
    return store;
  }

  private static toOrganisation(entity: Record<string, unknown>): OrganisationRecord {
    return {
      orgId: String(entity.partitionKey),
      name: String(entity.name),
      status: entity.status as OrganisationStatus,
      requestedBy: String(entity.requestedBy),
      requesterName: String(entity.requesterName ?? ''),
      requesterEmail: String(entity.requesterEmail ?? ''),
      requestedAt: String(entity.requestedAt),
      ...(entity.decidedBy ? { decidedBy: String(entity.decidedBy), decidedAt: String(entity.decidedAt) } : {}),
    };
  }

  async getOrganisation(orgId: string) {
    try {
      return TableStore.toOrganisation(await this.organisations.getEntity(orgId, 'organisation'));
    } catch (e) {
      if (e instanceof RestError && e.statusCode === 404) return null;
      throw e;
    }
  }

  async createOrganisation(record: OrganisationRecord) {
    const { orgId, ...rest } = record;
    try {
      await this.organisations.createEntity({ partitionKey: orgId, rowKey: 'organisation', ...rest });
    } catch (e) {
      if (e instanceof RestError && e.statusCode === 409) throw conflict('This organisation has already requested AVD.');
      throw e;
    }
  }

  async listOrganisations(status?: OrganisationStatus) {
    const filter = status ? `RowKey eq 'organisation' and status eq '${status}'` : `RowKey eq 'organisation'`;
    const records: OrganisationRecord[] = [];
    for await (const entity of this.organisations.listEntities({ queryOptions: { filter } })) records.push(TableStore.toOrganisation(entity));
    return records;
  }

  async decideOrganisation(orgId: string, status: 'approved' | 'declined', by: string, at: string) {
    let entity;
    try {
      entity = await this.organisations.getEntity(orgId, 'organisation');
    } catch (e) {
      if (e instanceof RestError && e.statusCode === 404) throw new HttpError(404, 'not-found', 'No AVD request for this organisation.');
      throw e;
    }
    if (entity.status !== 'pending') throw conflict(`This request was already ${String(entity.status)}.`);
    try {
      // The ETag makes two simultaneous decisions fail instead of both succeeding.
      await this.organisations.updateEntity({ partitionKey: orgId, rowKey: 'organisation', status, decidedBy: by, decidedAt: at }, 'Merge', { etag: entity.etag });
    } catch (e) {
      if (e instanceof RestError && e.statusCode === 412) throw conflict('This request was decided by someone else just now.');
      throw e;
    }
    return { ...TableStore.toOrganisation(entity), status, decidedBy: by, decidedAt: at };
  }

  async getMemberRoles(orgId: string, userId: string) {
    try {
      const entity = await this.memberRoles.getEntity<{ roles: string; grantedBy: string; grantedAt: string }>(orgId, userId);
      const roles = (JSON.parse(entity.roles) as unknown[]).filter(isAvdRole);
      return { orgId, userId, roles, grantedBy: entity.grantedBy, grantedAt: entity.grantedAt };
    } catch (e) {
      if (e instanceof RestError && e.statusCode === 404) return null;
      throw e;
    }
  }

  async putMemberRoles(record: MemberRoleRecord) {
    await this.memberRoles.upsertEntity(
      { partitionKey: record.orgId, rowKey: record.userId, roles: JSON.stringify(record.roles), grantedBy: record.grantedBy, grantedAt: record.grantedAt },
      'Replace',
    );
  }

  async putConnectState(record: ConnectState) {
    const { state, ...rest } = record;
    await this.connectStates.upsertEntity({ partitionKey: state, rowKey: 'state', ...rest }, 'Replace');
  }

  async takeConnectState(state: string) {
    let entity;
    try {
      entity = await this.connectStates.getEntity<Omit<ConnectState, 'state'>>(state, 'state');
    } catch (e) {
      if (e instanceof RestError && e.statusCode === 404) return null;
      throw e;
    }
    try {
      // Deleting with the ETag means only one caller can use the state.
      await this.connectStates.deleteEntity(state, 'state', { etag: entity.etag });
    } catch (e) {
      if (e instanceof RestError && (e.statusCode === 404 || e.statusCode === 412)) return null;
      throw e;
    }
    return {
      state,
      orgId: entity.orgId,
      userId: entity.userId,
      stage: entity.stage,
      expiresAt: entity.expiresAt,
      ...(entity.tenantId ? { tenantId: entity.tenantId } : {}),
      ...(entity.codeVerifier ? { codeVerifier: entity.codeVerifier } : {}),
      ...(entity.nonce ? { nonce: entity.nonce } : {}),
    };
  }

  async getTenantConnection(orgId: string) {
    try {
      const entity = await this.tenantConnections.getEntity<Omit<TenantConnection, 'orgId'>>(orgId, 'tenant');
      return {
        orgId,
        tenantId: entity.tenantId,
        tenantName: entity.tenantName,
        connectedBy: entity.connectedBy,
        consentedByObjectId: entity.consentedByObjectId,
        consentedByUsername: entity.consentedByUsername,
        connectedAt: entity.connectedAt,
      };
    } catch (e) {
      if (e instanceof RestError && e.statusCode === 404) return null;
      throw e;
    }
  }

  async connectTenant(record: TenantConnection) {
    try {
      await this.tenantOwners.createEntity({ partitionKey: record.tenantId, rowKey: 'owner', orgId: record.orgId, claimedAt: record.connectedAt });
    } catch (e) {
      if (!(e instanceof RestError && e.statusCode === 409)) throw e;
      const owner = await this.tenantOwners.getEntity<{ orgId: string }>(record.tenantId, 'owner');
      if (owner.orgId !== record.orgId) throw tenantTaken();
    }
    const { orgId, ...rest } = record;
    await this.tenantConnections.upsertEntity({ partitionKey: orgId, rowKey: 'tenant', ...rest }, 'Replace');
  }

  async getAccountLink(orgId: string, userId: string) {
    try {
      const e = await this.accountLinks.getEntity<Omit<AccountLink, 'orgId' | 'userId'>>(orgId, userId);
      return { orgId, userId, tenantId: e.tenantId, objectId: e.objectId, username: e.username, mfa: Boolean(e.mfa), sealedRefreshToken: e.sealedRefreshToken, linkedAt: e.linkedAt };
    } catch (e) {
      if (e instanceof RestError && e.statusCode === 404) return null;
      throw e;
    }
  }

  async putAccountLink(record: AccountLink) {
    const { orgId, userId, ...rest } = record;
    await this.accountLinks.upsertEntity({ partitionKey: orgId, rowKey: userId, ...rest }, 'Replace');
  }

  async deleteAccountLink(orgId: string, userId: string) {
    try {
      await this.accountLinks.deleteEntity(orgId, userId);
    } catch (e) {
      if (!(e instanceof RestError && e.statusCode === 404)) throw e;
    }
  }
}
