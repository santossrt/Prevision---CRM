export type AuditValue = string | number | boolean | null | AuditValue[] | { [key: string]: AuditValue };
export interface AuditSnapshotDTO {
  values: AuditValue;
  omitted: boolean;
  truncated: boolean;
}
export interface AuditEventSummaryDTO {
  id: string;
  actor: { id: string; name: string | null } | null;
  action: string;
  module: string;
  entityType: string;
  entityId: string | null;
  origin: string | null;
  operationId: string;
  createdAt: string;
}
export interface AuditEventDTO extends AuditEventSummaryDTO {
  previousValues: AuditSnapshotDTO | null;
  newValues: AuditSnapshotDTO | null;
}
export interface AuditList {
  items: AuditEventSummaryDTO[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
export interface AuditOption { value: string; label: string }
export interface AuditOptions {
  actors: { id: string; name: string | null }[];
  modules: AuditOption[];
  actions: AuditOption[];
  entityTypes: string[];
}
