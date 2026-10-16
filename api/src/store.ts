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

export interface Store {
  getOrganisation(orgId: string): Promise<OrganisationRecord | null>;
  /** Fails with 409 if a record already exists. */
  createOrganisation(record: OrganisationRecord): Promise<void>;
  listOrganisations(status?: OrganisationStatus): Promise<OrganisationRecord[]>;
  /** Moves a pending organisation to approved or declined; fails with 409 if it was decided meanwhile. */
  decideOrganisation(orgId: string, status: 'approved' | 'declined', by: string, at: string): Promise<OrganisationRecord>;
  getMemberRoles(orgId: string, userId: string): Promise<MemberRoleRecord | null>;
  putMemberRoles(record: MemberRoleRecord): Promise<void>;
}

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
}

// Organisations: PartitionKey = Clerk org ID, RowKey = 'organisation'. Member roles: PartitionKey = org ID, RowKey = user ID.
export class TableStore implements Store {
  private organisations: TableClient;
  private memberRoles: TableClient;

  private constructor(organisations: TableClient, memberRoles: TableClient) {
    this.organisations = organisations;
    this.memberRoles = memberRoles;
  }

  static async create(storage: Exclude<Config['storage'], { kind: 'memory' }>): Promise<TableStore> {
    const client = (table: string) =>
      storage.kind === 'connection-string'
        ? TableClient.fromConnectionString(storage.connectionString, table, { allowInsecureConnection: storage.connectionString.includes('127.0.0.1') })
        : new TableClient(`https://${storage.accountName}.table.core.windows.net`, table, new DefaultAzureCredential());
    const store = new TableStore(client('organisations'), client('memberroles'));
    for (const table of [store.organisations, store.memberRoles]) {
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
}
