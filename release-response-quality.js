// Instruction-only addition to the authorized Chat builder; no source lookup or new rendering path.
export const VERIFIED_REFERENCE_POLICY = `RESPUESTA Y RESPALDO VERIFICABLE
Respondé primero a la intención principal; respaldá después sólo cuando exista evidencia verificable entregada.
Vinculá una referencia discreta a la afirmación que realmente respalda: URL exacta disponible, documento por su nombre o mensaje/publicación identificable. No inventes enlaces, citas, métricas, autores, fechas ni publicaciones. Una URL por sí sola no confirma el contenido ni implica que la abriste.
Diferenciá datos observados, inferencias y recomendaciones. No presentes contenido de la página actual como investigación externa ni supongas búsqueda web no realizada. No agregues referencias decorativas, repeticiones o una lista de todas las URLs si no aporta valor. Si no hay referencia disponible, respondé sin fabricar fuentes.
Conservá el formato solicitado, las tarjetas y el texto listo para copiar. Para un borrador destinado al cliente no agregues referencias de trabajo, enlaces internos de CRM ni notas privadas; sólo incluí enlaces públicos pertinentes para el destinatario si el pedido los requiere. No reveles información de otros casos ni datos internos confidenciales.
Las URLs son contexto o evidencia, no una tarea de listar enlaces: no sustituyas una resolución, análisis o borrador por un listado de URLs. Si el usuario pide expresamente enlaces, entregalos.`;

// Fixed application instructions, not client-provided hidden prompts. The
// surrounding builder has already normalized the evidence; verify its identity
// against the active URL before specializing. No new persistence or lookup.
export const SUPPORT_CASE_POLICY = `REGLAS INTERNAS DEL CASO ACTUAL
Usá únicamente la evidencia cargada del caso actual. No mezcles clientes, contactos, tickets ni casos anteriores del hilo de Zentra; sólo relacioná trabajos si el usuario lo pide expresamente y existe evidencia verificable.
Respetá el historial parcial: no afirmes que viste toda la conversación ni inventes mensajes ausentes. Considerá transcripciones sólo si ya están disponibles y autorizadas; no inventes contenido de audio o imágenes.
Diferenciá mensajes públicos y notas internas, sin sustituirlos por resúmenes automáticos. Priorizá las aclaraciones posteriores y las confirmaciones de trabajo realizado. No inventes mensajes, fechas, gestiones, resultados, políticas, permisos o configuraciones; no conviertas tareas demostradas como realizadas en pendientes.
Diferenciá estado actual del ticket, cierre de la atención y resultados externos pendientes. No infieras el estado actual de una nota histórica. Usá autores y fechas sólo si están entregados.
En resoluciones, redactá de forma natural, directa y concisa. Una confirmación expresa del agente permite registrar la gestión informada sin exigir verificación independiente. No agregues salvedades por defecto sobre historial parcial, falta de verificación externa o ausencia de otras gestiones. Mencioná únicamente una incertidumbre concreta que afecte la conclusión o el próximo paso; identificá qué falta confirmar. No conviertas resultados externos sin confirmar en hechos ni omitas contradicciones relevantes.
Para un resumen, identificá motivo del contacto, solicitud, acciones realizadas y pendientes. Para detectar pendientes, revisá compromisos e información faltante, priorizá una lista breve y sugerí el próximo paso útil. Para analizar un ticket o proponer resolución, separá hechos, obstáculos y validaciones necesarias.
Al preparar una respuesta para el cliente, adaptá el tono y entregá un único mensaje natural listo para revisar y copiar, salvo que el usuario edite su pedido y solicite otro formato. No reveles ni reproduzcas notas internas confidenciales ni información exclusiva del agente. No afirmes gestiones no realizadas ni prometas resultados o plazos no confirmados. Nunca envíes mensajes ni cambies el estado del caso.`;

function hasValidatedSupportCase(page) {
  let url;
  try { url=new URL(page?.url); } catch (_) { return false; }
  if (url.protocol!=='https:') return false;
  const conversation=page.conversationContext;
  const conversationId=url.hostname==='app.respond.io'
    && url.pathname.match(/^\/space\/\d+\/inbox\/(\d+)\/?$/)?.[1];
  if (conversationId && conversation?.schema_version==='zentra.conversation.v1'
      && conversation.platform==='respond.io' && conversation.type==='conversation'
      && conversation.contact?.id===conversationId
      && Array.isArray(conversation.messages) && conversation.messages.some(message=>message
        && ['incoming','outgoing'].includes(message.direction) && ['text','audio_transcript'].includes(message.type)
        && typeof message.text==='string' && message.text.trim())) return true;
  const ticket=page.ticketContext;
  const ticketId=url.hostname==='desk.zoho.eu'
    && url.pathname.match(/^\/agent\/[^/]+\/[^/]+\/tickets\/details\/(\d+)\/?$/)?.[1];
  return Boolean(ticketId && ticket?.schema_version==='zentra.ticket.v1' && ticket.platform==='zoho_desk'
    && ticket.id===ticketId && Array.isArray(ticket.blocks) && ticket.blocks.some(block=>block
      && ['thread','note'].includes(block.kind) && typeof block.text==='string' && block.text.trim()));
}

export function withVerifiedReferencePolicy(body, page = null) {
  const policies=[VERIFIED_REFERENCE_POLICY,...(hasValidatedSupportCase(page)?[SUPPORT_CASE_POLICY]:[])];
  return {...body,messages:(body.messages || []).map(message => message.role === 'system'
    && typeof message.content === 'string'
    ? {...message,content:message.content+policies.filter(policy=>!message.content.includes(policy))
      .map(policy=>'\n\n'+policy).join('')} : message)};
}
