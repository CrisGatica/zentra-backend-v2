export const demoConversations = [
  {
    id: "conv_01",
    tenantId: "tenant_zentra",
    channel: "whatsapp",
    customerName: "Masajes El Dorado Wellness Center",
    subject: "Pedido multiarea con varias gestiones",
    status: "open",
    department: "soporte-web",
    frontOwner: "Cristian",
    unreadCount: 1,
    readinessScore: 82
  },
  {
    id: "conv_02",
    tenantId: "tenant_zentra",
    channel: "webchat",
    customerName: "LM Ibiza Homes",
    subject: "Landing no convierte",
    status: "open",
    department: "crecimiento-publicidad",
    frontOwner: "Astra IA",
    unreadCount: 0,
    readinessScore: 86
  }
] as const;

export const demoIntakeSessions = [
  {
    id: "intake_01",
    conversationId: "conv_01",
    tenantId: "tenant_zentra",
    status: "collecting_context",
    intent: "nuevo_servicio_web_y_promo_ads",
    department: "soporte-web",
    priority: "high",
    urgency: "medium",
    sentiment: "confused",
    readinessScore: 82,
    requiresHumanReview: true,
    missingFields: ["precio_o_duracion", "recurso_visual"]
  },
  {
    id: "intake_02",
    conversationId: "conv_02",
    tenantId: "tenant_zentra",
    status: "ready_for_ticket",
    intent: "landing_no_convierte",
    department: "crecimiento-publicidad",
    priority: "high",
    urgency: "high",
    sentiment: "frustrated",
    readinessScore: 86,
    requiresHumanReview: true,
    missingFields: ["captura_anuncio"]
  }
] as const;

export const demoWorkItems = [
  {
    id: "work_01",
    intakeSessionId: "intake_01",
    conversationId: "conv_01",
    title: "Agregar nuevo servicio Masaje Sueco",
    department: "soporte-web",
    status: "ready_to_send",
    ownerType: "department",
    externalTicketId: "ZD-56398"
  },
  {
    id: "work_02",
    intakeSessionId: "intake_01",
    conversationId: "conv_01",
    title: "Corregir publicación de redes",
    department: "redes-sociales",
    status: "ticket_sent",
    ownerType: "department",
    externalTicketId: "ZD-56361"
  },
  {
    id: "work_03",
    intakeSessionId: "intake_01",
    conversationId: "conv_01",
    title: "Definir nueva promo para ads",
    department: "publicidad-paga",
    status: "assigned",
    ownerType: "department",
    externalTicketId: null
  }
] as const;

export const demoTickets = [
  {
    id: "ticket_01",
    workItemId: "work_01",
    conversationId: "conv_01",
    externalId: "ZD-56398",
    provider: "zoho_desk",
    department: "soporte-web",
    status: "waiting_customer",
    priority: "high",
    owner: "Cristian"
  },
  {
    id: "ticket_02",
    workItemId: "work_02",
    conversationId: "conv_01",
    externalId: "ZD-56361",
    provider: "zoho_desk",
    department: "redes-sociales",
    status: "in_progress",
    priority: "high",
    owner: "Equipo Redes"
  }
] as const;
