import {
  demoConversations,
  demoIntakeSessions,
  demoTickets,
  demoWorkItems
} from "../data/demo-store.js";
import type {
  ConversationRepository,
  InboxRepositories,
  IntakeSessionRepository,
  ListParams,
  TicketRepository,
  WorkItemRepository
} from "./types.js";

class DemoConversationRepository implements ConversationRepository {
  async list(params?: ListParams) {
    return demoConversations.filter((item) =>
      params?.tenantId ? item.tenantId === params.tenantId : true
    );
  }
}

class DemoIntakeSessionRepository implements IntakeSessionRepository {
  async list(params?: ListParams) {
    return demoIntakeSessions.filter((item) =>
      params?.tenantId ? item.tenantId === params.tenantId : true
    );
  }
}

class DemoWorkItemRepository implements WorkItemRepository {
  async list(params?: ListParams) {
    return demoWorkItems.filter((item) =>
      params?.tenantId
        ? demoIntakeSessions.some(
            (intake) => intake.id === item.intakeSessionId && intake.tenantId === params.tenantId
          )
        : true
    );
  }
}

class DemoTicketRepository implements TicketRepository {
  async list(params?: ListParams) {
    return demoTickets.filter((item) =>
      params?.tenantId
        ? demoConversations.some(
            (conversation) =>
              conversation.id === item.conversationId && conversation.tenantId === params.tenantId
          )
        : true
    );
  }
}

export function createDemoRepositories(): InboxRepositories {
  return {
    conversations: new DemoConversationRepository(),
    intakeSessions: new DemoIntakeSessionRepository(),
    workItems: new DemoWorkItemRepository(),
    tickets: new DemoTicketRepository()
  };
}
