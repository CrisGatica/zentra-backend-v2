export type ListParams = {
  tenantId?: string;
};

export type ConversationListItem = {
  id: string;
  tenantId: string | null;
  channel: string;
  customerName: string | null;
  subject: string | null;
  status: string;
  department: string | null;
  frontOwner: string | null;
  unreadCount: number;
  readinessScore: number;
};

export type IntakeSessionListItem = {
  id: string;
  conversationId: string;
  tenantId: string | null;
  status: string;
  intent: string | null;
  department: string | null;
  priority: string | null;
  urgency: string | null;
  sentiment: string | null;
  readinessScore: number;
  requiresHumanReview: boolean;
  missingFields: string[];
};

export type WorkItemListItem = {
  id: string;
  intakeSessionId: string;
  conversationId: string | null;
  title: string;
  department: string | null;
  status: string;
  ownerType: string;
  externalTicketId: string | null;
};

export type TicketListItem = {
  id: string;
  workItemId: string;
  conversationId: string | null;
  externalId: string | null;
  provider: string | null;
  department: string | null;
  status: string;
  priority: string | null;
  owner: string | null;
};

export interface ConversationRepository {
  list(params?: ListParams): Promise<ConversationListItem[]>;
}

export interface IntakeSessionRepository {
  list(params?: ListParams): Promise<IntakeSessionListItem[]>;
}

export interface WorkItemRepository {
  list(params?: ListParams): Promise<WorkItemListItem[]>;
}

export interface TicketRepository {
  list(params?: ListParams): Promise<TicketListItem[]>;
}

export type InboxRepositories = {
  conversations: ConversationRepository;
  intakeSessions: IntakeSessionRepository;
  workItems: WorkItemRepository;
  tickets: TicketRepository;
};
