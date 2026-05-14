# Zentra Inbox API

Servicio nuevo e independiente dentro del monorepo para `Zentra Inbox / Zentra Agency OS`.

## Estado actual

Este servicio ya esta:

- separado del backend actual del SaaS/Audit
- desplegado por separado en Render
- montado con `Fastify + TypeScript`
- expuesto con rutas base demo para empezar a desarrollar el core operacional

## Endpoints actuales

- `GET /`
- `GET /health`
- `GET /v1/conversations`
- `GET /v1/intake-sessions`
- `GET /v1/work-items`
- `GET /v1/tickets`

## Variables de entorno

Para leer datos reales desde Supabase, este servicio espera:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_SCHEMA` (opcional, default: `inbox`)

## Comportamiento actual de datos

Hoy el servicio ya soporta dos modos:

- `supabase`: si las variables de entorno existen y son validas
- `demo`: si faltan variables o todavia no queremos bloquear el desarrollo

Las rutas `GET /v1/*` devuelven:

- `source`
- `issues`
- `items`
- `total`

Eso permite saber facilmente si el servicio esta leyendo:

- datos reales
- o datos demo

## Filosofia de modelado ya fijada

- la entidad central es `intake_session`
- el ticket es el resultado del contexto
- una conversacion puede producir:
  - `1 conversation`
  - `1 intake_session`
  - `N work_items`
  - `N tickets`

## Decisiones intencionalmente postergadas

Estas decisiones no estan olvidadas. Se dejaron asi a proposito para no frenar el arranque del core:

### `tenant_id`

Importante:

Por ahora `tenant_id` queda `nullable` a proposito, para no frenarnos.

Cuando conectemos `auth / tenant model` real, ahi lo endurecemos a `not null`.

### Auth

Todavia no hay auth ni permisos reales en este servicio nuevo.

Mas adelante:

- auth de usuario/agente
- resolucion real de tenant
- ownership por departamento
- permisos por rol

### Persistencia

Hoy las rutas principales usan datos demo.

Lo siguiente es:

- conectar Supabase/Postgres real
- crear repositories reales
- persistir:
  - conversations
  - messages
  - intake_sessions
  - context_packets
  - work_items
  - tickets
  - customer_memory_facts
  - domain_events
  - outbox_jobs

### Integraciones

Todavia no estan conectadas en este servicio:

- Zoho Desk
- Slack
- HubSpot
- Webhooks

Se van a montar despues sobre:

- outbox pattern
- idempotency
- retries
- dead-letter handling

## Siguiente objetivo tecnico

Pasar de rutas demo a core persistente real:

1. cliente DB para Supabase/Postgres
2. repositories reales
3. DTOs/schemas
4. event persistence
5. outbox jobs
6. context engine real
