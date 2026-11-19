import type { DatabaseSync } from 'node:sqlite';
import type { AuditAction, AuditLog } from '../../src/types.ts';

export function recordAuditLog(
  db: DatabaseSync,
  params: {
    action: AuditAction;
    entityType: AuditLog['entityType'];
    entityId: string;
    actorUserId?: string | null;
    actor: string;
    summary: string;
  }
): void {
  const id = `aud-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const createdAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO audit_logs (id, action, entity_type, entity_id, actor_user_id, actor, summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.action,
    params.entityType,
    params.entityId,
    params.actorUserId ?? null,
    params.actor,
    params.summary,
    createdAt
  );
}

export function listAuditLogs(db: DatabaseSync, limit = 300): AuditLog[] {
  const rows = db
    .prepare(`
      SELECT id, action, entity_type, entity_id, actor_user_id, actor, summary, created_at
      FROM audit_logs
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(limit) as Array<{
    id: string;
    action: AuditAction;
    entity_type: AuditLog['entityType'];
    entity_id: string;
    actor_user_id: string | null;
    actor: string;
    summary: string;
    created_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    actorUserId: r.actor_user_id,
    actor: r.actor,
    summary: r.summary,
    createdAt: r.created_at,
  }));
}
