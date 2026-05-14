import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  ConversationListItem,
  ConversationRepository,
  InboxRepositories,
  IntakeSessionListItem,
  IntakeSessionRepository,
  ListParams,
  TicketListItem,
  TicketRepository,
  WorkItemListItem,
  WorkItemRepository
} from "./types.js";

type RowRecord = Record<string, unknown>;

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

class SupabaseConversationRepository implements ConversationRepository {
  constructor(private readonly client: SupabaseClient) {}

  async list(params?: ListParams): Promise<ConversationListItem[]> {
    let query = this.client
      .from("conversations")
      .select(
        "id, tenant_id, channel, customer_name, subject, status, department, front_owner, unread_count, readiness_score"
      )
      .order("created_at", { ascending: false });

    if (params?.tenantId) {
      query = query.eq("tenant_id", params.tenantId);
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    return (data ?? []).map((row) => mapConversationRow(row as RowRecord));
  }
}

class SupabaseIntakeSessionRepository implements IntakeSessionRepository {
  constructor(private readonly client: SupabaseClient) {}

  async list(params?: ListParams): Promise<IntakeSessionListItem[]> {
    let query = this.client
      .from("intake_sessions")
      .select(
        "id, conversation_id, tenant_id, status, intent, department, priority, urgency, sentiment, readiness_score, requires_human_review, context_packets(missing_fields, created_at)"
      )
      .order("created_at", { ascending: false });

    if (params?.tenantId) {
      query = query.eq("tenant_id", params.tenantId);
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    return (data ?? []).map((row) => mapIntakeRow(row as RowRecord));
  }
}

class SupabaseWorkItemRepository implements WorkItemRepository {
  constructor(private readonly client: SupabaseClient) {}

  async list(params?: ListParams): Promise<WorkItemListItem[]> {
    let query = this.client
      .from("work_items")
      .select(
        "id, intake_session_id, conversation_id, title, assigned_department, status, owner_type, external_ticket_id"
      )
      .order("created_at", { ascending: false });

    if (params?.tenantId) {
      query = query.eq("tenant_id", params.tenantId);
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    return (data ?? []).map((row) => mapWorkItemRow(row as RowRecord));
  }
}

class SupabaseTicketRepository implements TicketRepository {
  constructor(private readonly client: SupabaseClient) {}

  async list(params?: ListParams): Promise<TicketListItem[]> {
    let query = this.client
      .from("tickets")
      .select(
        "id, work_item_id, conversation_id, external_id, provider, department, status, priority, owner"
      )
      .order("created_at", { ascending: false });

    if (params?.tenantId) {
      query = query.eq("tenant_id", params.tenantId);
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    return (data ?? []).map((row) => mapTicketRow(row as RowRecord));
  }
}

export function createSupabaseRepositories(client: SupabaseClient): InboxRepositories {
  return {
    conversations: new SupabaseConversationRepository(client),
    intakeSessions: new SupabaseIntakeSessionRepository(client),
    workItems: new SupabaseWorkItemRepository(client),
    tickets: new SupabaseTicketRepository(client)
  };
}

function mapConversationRow(row: RowRecord): ConversationListItem {
  return {
    id: String(row.id),
    tenantId: asString(row.tenant_id),
    channel: String(row.channel),
    customerName: asString(row.customer_name),
    subject: asString(row.subject),
    status: String(row.status),
    department: asString(row.department),
    frontOwner: asString(row.front_owner),
    unreadCount: asNumber(row.unread_count),
    readinessScore: asNumber(row.readiness_score)
  };
}

function mapIntakeRow(row: RowRecord): IntakeSessionListItem {
  const contextPackets = Array.isArray(row.context_packets) ? (row.context_packets as RowRecord[]) : [];
  const latestContext = contextPackets[0] ?? null;

  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    tenantId: asString(row.tenant_id),
    status: String(row.status),
    intent: asString(row.intent),
    department: asString(row.department),
    priority: asString(row.priority),
    urgency: asString(row.urgency),
    sentiment: asString(row.sentiment),
    readinessScore: asNumber(row.readiness_score),
    requiresHumanReview: asBoolean(row.requires_human_review, true),
    missingFields: latestContext ? asStringArray(latestContext.missing_fields) : []
  };
}

function mapWorkItemRow(row: RowRecord): WorkItemListItem {
  return {
    id: String(row.id),
    intakeSessionId: String(row.intake_session_id),
    conversationId: asString(row.conversation_id),
    title: String(row.title),
    department: asString(row.assigned_department),
    status: String(row.status),
    ownerType: String(row.owner_type),
    externalTicketId: asString(row.external_ticket_id)
  };
}

function mapTicketRow(row: RowRecord): TicketListItem {
  return {
    id: String(row.id),
    workItemId: String(row.work_item_id),
    conversationId: asString(row.conversation_id),
    externalId: asString(row.external_id),
    provider: asString(row.provider),
    department: asString(row.department),
    status: String(row.status),
    priority: asString(row.priority),
    owner: asString(row.owner)
  };
}
