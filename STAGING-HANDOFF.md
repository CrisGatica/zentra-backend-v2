# Handoff tecnico para Zentra backend staging

Fecha: 2026-10-01. Destino futuro: `zentra-backend-v2-staging`.
Este documento configura una instantanea aprobada, no autoriza desplegar, ejecutar SQL ni tocar produccion.

## Commit y alcance

Repositorio: `https://github.com/CrisGatica/zentra-backend-v2.git`.
La rama `staging` debe apuntar al commit de esta instantanea; obtener su SHA con `git rev-parse staging`. El SHA exacto y el resultado del push se entregan por separado para evitar la referencia circular de un documento que contiene su propio SHA.

Base local aprobada: `a8e5af81a5b15ec0734aa43e5f218e96e919dd78` en `main`. `main` remoto observado al preparar este handoff: `5adc7635f69042fe8cf343e756033c192f25bead`; contiene tres commits posteriores de Search/recovery. No se hace merge/rebase: la instantanea usa EXACTAMENTE el codigo local aprobado, con sus versiones actuales de esos fixes, incluyendo el validador confiable compartido. La genealogia de staging parte de la base local, no de main remoto.

Se incluyen todas las dependencias activas importadas por `server.js`, constructores confiables, cinco SQL, lockfile, ignore, test unitario de Search y los fixtures/reportes de validacion copiados sin alterar. `apps/inbox-api` permanece como estaba: es otro servicio, no el backend que arranca `npm start`. Se excluyen del cambio `.DS_Store`, node_modules, credenciales, archivos .env y CONFIGURAR-CLAUDE.md legacy no aprobado.

Chrome clean, Lab y Zentra Audit son directorios EXTERNOS a este repo. Sus fuentes aprobadas permanecen locales; no se empaquetan ni se trasladan como producto al repo del backend. `staging-handoff/source-manifest.json` registra sus hashes y los del backend para identificar exactamente que fuentes corresponden al handoff. No afirmar que el commit backend publica los clientes.

Los informes locales anteriores y sus pruebas se conservan en `staging-handoff/validation` y `staging-handoff/qa`. Los modulos de producto no se editan en esta tarea. Los dos modulos GPT-6 siguen siendo autoridad: `release-chat-routing.js` y `release-audit-routing.js`.

## A Variables ENV exactas del backend activo

Inventario obtenido de `server.js` y sus imports transitivos; incluye nombres dinamicos de rate limits. Son 44 nombres leidos. No se han consultado ni copiado secretos de Render. "Obligatoria" significa necesaria para el flujo completo que se validara, no necesariamente para que /health devuelva 200.

| Variable | Clasificacion | Valor/configuracion para staging |
| --- | --- | --- |
| SUPABASE_URL | Obligatoria | URL DEL PROYECTO SUPABASE STAGING, no produccion |
| SUPABASE_SERVICE_ROLE_KEY | Obligatoria, secreta | Service-role exclusivamente del MISMO Supabase staging; solo backend |
| OPENAI_API_KEY | Obligatoria, secreta | Clave autorizada para Luna/Sol; preferir proyecto de pruebas con limite de gasto |
| OPENAI_SEARCH_API_KEY | Opcional, secreta | Clave separada para Search; si se omite usa OPENAI_API_KEY |
| NODE_ENV | Obligatoria operativa | production recomendado tambien en staging para reproducir guards y no habilitar debug por accidente |
| PORT | Opcional, gestionada por Render | No fijarla; Render proporciona PORT; default local 3000 |
| USER_ACCESS_HAS_AUTH_USER_ID | Opcional tecnica, establecer en staging | true; la migracion users crea auth_user_id y permite consulta directa por identidad verificada |
| ZENTRA_ALLOWED_ORIGINS | Obligatoria para clientes de navegador | Lista separada por comas de origenes HTTPS de pruebas y chrome-extension://ID reales autorizados; sin comodines ni paths. No incluir automaticamente todas las webs auditadas |
| ZENTRA_AUDIO_TRANSCRIPTION_ENABLED | Opcional, fijada para este staging | false; Desktop/audio no se habilita |
| LEMON_SQUEEZY_STORE_ID | Obligatoria para probar billing/checkout | ID real del store de pruebas autorizado, comprobado manualmente con el catalogo; no inventado |
| LEMON_SQUEEZY_WEBHOOK_SECRET | Obligatoria para probar webhook, secreta | Secreto independiente del webhook STAGING; no reutilizar el de produccion |
| LEMON_SQUEEZY_API_KEY | Obligatoria para reconciliation/invoices, secreta | Credencial Lemon test autorizada; no necesaria para construir el link de checkout, si para sync del proveedor |
| LEMON_ALLOW_TEST_WEBHOOKS | Opcional, solo staging/test | true para admitir eventos test. En produccion omitir/false. NO obliga a que todos los eventos sean test ni convierte links live |
| ZENTRA_AUDIT_JSON_DEBUG | Opcional, solo staging/test | false normalmente. true solo produce diagnostico JSON si NODE_ENV != production; telemetry de coste funciona sin este flag |
| ZENTRA_EXECUTIVE_REFINER_MAX_TOKENS | Opcional, vigente | 900 para medir el contrato aprobado; minimo 256. No aumentarlo sin validar |
| ZENTRA_CHAT_REASONING_MAX_TOKENS | Opcional, vigente | 1800 default, minimo 512 |
| ZENTRA_CHAT_EXECUTIVE_ENABLED | Opcional, vigente | false default. Preservar el valor comercial/operativo aprobado; controla la pasada opcional de Chat, no Audit |
| ZENTRA_CHAT_EXECUTIVE_MAX_TOKENS | Opcional, vigente | 1200 default, minimo 256 |
| ZENTRA_TRUSTED_PROXY_CIDRS | Opcional, vigente | Lista de IPs/CIDRs del proxy realmente verificados. Omitir es fail-safe trust proxy=false; no inventar CIDRs ni usar true/*. Puede agrupar trafico por IP de proxy y requiere comprobarlo en staging |
| ZENTRA_RATE_AUTH_IP | Opcional | 240/min por IP, pre-auth |
| ZENTRA_RATE_USER_LOCAL | Opcional | 120/min por usuario y proceso |
| ZENTRA_RATE_HEALTH_IP | Opcional | 600/min por IP y proceso |
| ZENTRA_RATE_WEBHOOK_IP | Opcional | 600/min por IP y proceso |
| ZENTRA_RATE_PUBLIC_IP | Opcional | 120/min por IP y proceso |
| ZENTRA_RATE_GENERATION_USER | Opcional | 60/min por usuario, PostgreSQL compartido |
| ZENTRA_RATE_AUDIO_USER | Opcional | 12/min por usuario, PostgreSQL compartido; audio sigue deshabilitado |
| ZENTRA_RATE_SEARCH_USER | Opcional | 30/min por usuario, PostgreSQL compartido; NO sustituye maximo 3 por Audit |
| ZENTRA_RATE_AUDIT_USER | Opcional | 120/min por usuario, PostgreSQL compartido |
| ZENTRA_RATE_CONSUME_USER | Opcional | 60/min por usuario, PostgreSQL compartido |
| ZENTRA_RATE_READ_USER | Opcional | 180/min por usuario, PostgreSQL compartido |
| ZENTRA_DESKTOP_TRANSCRIPTION_MODEL | Opcional, solo Desktop excluido | Default gpt-4o-mini-transcribe; omitir con audio false |
| ANTHROPIC_API_KEY | Legacy/opcional, no requerida para GPT-6 | Omitir; adaptador generico permanece pero Chat/Audit nuevos fijan OpenAI |
| ANTHROPIC_API_VERSION | Legacy/opcional | Omitir; default 2023-06-01, sin uso en las rutas GPT-6 |
| ZENTRA_BASE_PROVIDER | Legacy, omitir | Fallback/config generica aun lee el nombre; default openai. No determina el tier GPT-6 final |
| ZENTRA_BASE_MODEL | Legacy, omitir | Default legacy gpt-5-mini en referencias genericas; no configura Chat/Audit GPT-6 efectivos |
| ZENTRA_PREMIUM_PROVIDER | Legacy/obsoleta para rutas activas | Omitir; ya no configura el router GPT-6 |
| ZENTRA_PREMIUM_MODEL | Legacy/obsoleta para rutas activas | Omitir; NO poner Luna aqui para habilitar la capa premium |
| ZENTRA_PREMIUM_FINAL_PROVIDER | Legacy/obsoleta para rutas activas | Omitir; ya no configura el router GPT-6 |
| ZENTRA_PREMIUM_FINAL_MODEL | Legacy/obsoleta para rutas activas | Omitir; NO poner Sol aqui para habilitar el ejecutivo |
| ZENTRA_EXECUTIVE_REFINER_ENABLED | Obsoleta en backend actual | Solo declarada, no gobierna el flujo Audit actual; omitir |
| ZENTRA_EXECUTIVE_REFINER_PROVIDER | Obsoleta en backend actual | Solo declarada; omitir |
| ZENTRA_EXECUTIVE_REFINER_MODEL | Obsoleta en backend actual | Solo declarada; omitir |
| ZENTRA_EXECUTIVE_REFINER_TEMPERATURE | Obsoleta en backend actual | Solo declarada; Responses reasoning omite temperature; omitir |
| ZENTRA_AGENCY_CAPACITY_PACKS_JSON | Legacy/inactiva con catalogo actual | Los packs codificados no estan vacios y prevalecen; esta ENV solo se lee si no hay packs por defecto. Omitir; no modifica el catalogo seguro Lemon |

Los rates aceptan enteros 1..100000; configuraciones invalidas fallan al arrancar. Se dejan sus defaults, no se elevan para ocultar problemas de concurrencia.

### Variables de modelos antiguas que YA NO SE LEEN

`ZENTRA_CHAT_REASONING_MODEL`, `ZENTRA_CHAT_EXECUTIVE_MODEL`, `ZENTRA_CHAT_FAST_MODEL`, `ZENTRA_CHAT_FAST_PROVIDER`, `ZENTRA_CHAT_REASONING_PROVIDER`, `ZENTRA_CHAT_EXECUTIVE_PROVIDER`, `ZENTRA_CHAT_REASONING_TEMPERATURE`, `ZENTRA_CHAT_EXECUTIVE_TEMPERATURE`: no hay lectura ENV en el backend actual. Pueden omitirse/eliminarse de la configuracion del NUEVO staging; algunas tienen constantes de nombre parecido, pero no reciben su valor de ENV. No se modificaron las ENV de produccion.

### Routing GPT-6 definitivo

NO hay ENV nueva de modelo o reasoning que configurar. Se fija en codigo y resuelve la autorizacion en servidor:

| Feature | Modelo | Effort |
| --- | --- | --- |
| Chat normal | gpt-6-luna | medium |
| Chat avanzado con cupo | gpt-6.1-sol | medium |
| Chat avanzado sin cupo | gpt-6-luna | high |
| Audit base/seo_analysis/recovery | gpt-6-luna | medium |
| Audit premium autorizado/summary/polish | gpt-6-luna | high |
| Competencia web_search | gpt-6-luna | high |
| executive_refiner_pdf autorizado | gpt-6.1-sol | xhigh |

No max; no ENV de Search budget; maximo 3 esta en SQL/handler. Telemetry no necesita ENV nueva ni migracion propia. No hay variables exclusivamente de produccion que haya que copiar a staging. Las credenciales/origenes deben ser distintas aunque NODE_ENV sea production.

### Extras del repo que NO configurar en este servicio

`NODE_VERSION=24.16.0` es una ENV de Render, no de la app; fija la version local usada para validar. El Supabase SDK bloqueado requiere Node >=22. La app no carga .env automaticamente: Render debe inyectar ENV al proceso.

`SUPABASE_SCHEMA` pertenece solo a apps/inbox-api (default inbox), no a server.js; no crear esquema inbox ni desplegar ese subproyecto aqui. Tampoco se requieren DATABASE_URL, SUPABASE_ANON_KEY, STRIPE_*, REDIS_URL ni JWT_SECRET para este backend. La clave anon/publicable y el login del cliente deben proceder del Supabase staging en un cliente de pruebas separado.

Las ENV ZENTRA_BASE, ZENTRA_BACKEND_DIR, ZENTRA_TEST_PG_MODULE, ZENTRA_TEST_PG_CONFIG y ZENTRA_TEST_HTTP_RATE pertenecen solo al arnes QA local; no a Render. No configurar NODE_ENV=test ni credenciales mock en el servicio.

## B Migraciones exactas para Supabase staging vacio

NO ejecutadas durante este handoff. Prerrequisitos: proyecto Supabase distinto y vacio, public schema, roles anon/authenticated/service_role provistos por Supabase, gen_random_uuid() disponible (PostgreSQL moderno/Supabase). No copiar usuarios Auth, suscripciones o recibos de produccion.

Orden exacto del conjunto completo probado localmente:

1. `supabase-users.sql`: users, identidad/auth_user_id, limites/creditos, indices por producto y payment_activation_logs. Base para todas las demas tablas.
2. `supabase-release-guard.sql`: billing columns, receipts, requests, cuotas atomicas, reset, devoluciones, lease tokens, fases congeladas Chat/Audit y RLS/grants servidor.
3. `supabase-execution-guard.sql`: provider_started/checkpoints, Search leases/fencing, adquisicion/reserva previa al crawl y presupuesto global Search.
4. `supabase-http-rate.sql`: buckets y rate limiting por usuario compartido entre procesos. Independiente del consumo, aplicado aqui antes del billing final.
5. `supabase-lemon.sql`: catalog binding/checkouts, customers/subscriptions/events, reconciliacion, fechas/acceso, refunds e idempotencia. DEBE ir despues de release/execution porque envuelve zentra_access y bloquea el apply_payment legacy; contiene notify pgrst, 'reload schema'.

No volver a aplicar release-guard despues de Lemon sin un procedimiento especifico: podria reemplazar el wrapper final de zentra_access. Usar el orden completo, guardar cada resultado y detenerse si un archivo falla. No hay una sexta migracion de telemetry: coste/tokens se registran en logs, no en una tabla nueva. No hay runner automatico ni npm script de migrations.

RPCs principales por archivo:

| Archivo | Funciones/dependencias |
| --- | --- |
| release-guard | zentra_access, zentra_consume, zentra_consume_generation, zentra_begin_request, zentra_finish_request, zentra_renew_request, zentra_refund_failed, zentra_apply_payment, zentra_read_chat_steps, zentra_register_chat_step, zentra_read_audit_steps, zentra_register_audit_step |
| execution-guard | zentra_start_provider, zentra_checkpoint_response, zentra_begin_search, zentra_start_search, zentra_finish_search, zentra_renew_search, zentra_acquire_audit, zentra_handoff_audit, zentra_release_audit, zentra_reserve_search_budget, zentra_settle_search_budget |
| http-rate | zentra_http_rate_limit |
| lemon | zentra_lemon_checkout, zentra_lemon_event, zentra_lemon_event_seen, zentra_lemon_sync_claim, zentra_lemon_sync_finish; wrappers zentra_access/zentra_apply_payment y versiones *_before_lemon restringidas |

Verificar que users/requests/receipts/steps/search/budget/rate/Lemon tengan los grants/RLS definidos por SQL. anon/authenticated no deben poder consumir, devolver, alterar ownership ni ejecutar RPCs servidor. SQL migration usa rol administrador solo del proyecto staging; runtime usa service-role solo staging. No exponer esa clave al navegador.

## C Render para el servicio nuevo

| Campo | Configuracion |
| --- | --- |
| Name | zentra-backend-v2-staging |
| Tipo/runtime | Web Service / Node |
| Repo/branch | CrisGatica/zentra-backend-v2 / staging |
| Root directory | Raiz del repo, no apps/inbox-api |
| Version | NODE_VERSION=24.16.0, como las validaciones locales |
| Build command | npm ci |
| Start command | npm start (node server.js) |
| Health check path | /health (tambien existe /api/health) |
| Auto deploy | Desactivado/manual para controlar el SHA probado |
| Pre-deploy command | Vacio; NO ejecutar SQL automaticamente |
| Puerto | PORT proporcionado por Render; app.listen(PORT) sin host limitado a localhost |
| Disco/worker adicional | No requerido; persistencia de operaciones/Search en Supabase |

package-lock.json se incluye; no hay build/transpilacion en package.json raiz. No usar npm run build ni arrancar el subproyecto Inbox. El lockfile requiere Node >=22 por el SDK; pin 24.16.0 evita cambios implicitos de runtime. [Node en Render](https://render.com/docs/node-version), [Web Services](https://render.com/docs/web-services).

Crear el Web Service en Render inicia un deploy inicial: NO se crea en esta tarea. Cuando se autorice, comprobar el SHA de staging antes de crear/manual deploy. No reutilizar el servicio production ni sus environment groups/secretos por herencia. Preferir instancia sin sleep para medir latencia y pruebas de resume, region cercana a Supabase staging; no se contrata plan aqui.

Diferencias respecto del servicio actual: rama staging, nombre/URL distintos, Supabase/Auth staging, origenes cliente de pruebas, webhook/clave Lemon test y credenciales OpenAI de pruebas. No se inspecciono ni modifico la configuracion real de produccion; no asumir que todas sus ENV actuales sean necesarias.

Proxy: el backend acepta solo CIDRs verificados; si no se configuran, usa trust proxy=false. Revisar req.ip y las respuestas 429 en staging antes de pruebas intensivas; no copiar trust proxy=true ni confiar arbitrariamente en X-Forwarded-For.

## D Checklist ordenada para la futura validacion staging

1. Identidad del entorno: Render Events apunta al SHA de staging; URL nueva; SUPABASE_URL/project ref y service-role corresponden SOLO staging; claves de pruebas; ningun cliente de produccion redirigido. Abrir un cliente de pruebas aislado o usar requests staging, nunca sesiones production.
2. Health: GET /health y /api/health -> 200 {ok:true}; headers no-store/nosniff. Health NO consulta Supabase ni proveedor, no acredita que las migraciones/credenciales esten bien.
3. Supabase y Auth: comprobar cinco SQL/RPCs finales y acceso service-role; crear usuarios Auth confirmados de prueba en staging; sin Bearer/token ajeno ->401, Origin ajeno ->403; identidad/email falsificados no cambian el usuario efectivo. Token emitido por produccion no sirve para staging.
4. Planes/Chat: usar Free/Starter/Pro/Agency de prueba sin override administrativo; normal Luna medium; avanzado autorizado Sol medium; agotado Luna high; 3/30/100/300 intactos; replay/idempotency sin segunda generacion/consumo. Confirmar tokens/model/effort reales en telemetry.
5. Audit: reserva antes de crawl; sin cupo cero crawl/IA/Search; Free 3, Starter 5, Pro 7, Agency 11 paginas maximas. Pro valida hasta 7 y Agency hasta 11 con premium reasoning Luna high y ejecutivo Sol xhigh; Free/Starter nunca Sol. Credito Zentra Audit separado de SaaS. Empezar con Free 3; despues Pro 7 y finalmente Agency 11 sobre un sitio de prueba con al menos 11 URLs distintas.
6. Search: GPT-6 Luna high + Web Search. Evidencia suficiente en primera llamada detiene; web+social/retry combinado <=3 tool calls globales persistentes por Audit; cache no suma; reinicio/segundo worker conserva budget; intento de cuarta usa evidencia disponible; uncertain/incomplete conserva reserva. Comprobar DB y output del proveedor, no solo numero de requests HTTP.
7. Concurrencia: dos solicitudes para ultimo cupo normal/avanzado/Audit, misma operacion concurrente, dos workers Search; no overshoot/doble devolucion. Probar 299/300 con dos solicitudes. Preservar fencing/checkpoint/useful response ante fallos.
8. Recovery/resume/PDF: JSON invalido -> maximo un recovery, mismo recibo y sin recrawl; fallback degradado no inventa competencia; cierre/reapertura RUNNING retoma; COMPLETED/PDF_READY/Save As no reinicia; PDF y descarga reales disponibles sin doble consumo.
9. Lemon test: SOLO tras verificar store/IDs/productos/enlaces en dashboard TEST; webhook firmado/duplicado/cancelado con ends_at/refund; binding pertenece al usuario Auth staging; compra individual no altera SaaS. No realizar compras live ni vincular suscripciones existentes.
10. Telemetry: [CHAT COST]/[AUDIT COST] internos, tokens/cached/reasoning reales, Search calls y total por Audit, sin mensajes/credenciales/email; datos faltantes -> coste null, no cero. Comparar con usage del proyecto OpenAI, registrar latencia y capa efectiva.
11. Sol xhigh con 900: probar una Audit pequena, Pro hasta 7 paginas y Agency hasta 11 con evidencia competitiva, repetir varias ejecuciones nuevas. En [AUDIT COST] stage=executive_refiner registrar status HTTP, provider_status, incomplete_details.reason, output_tokens, reasoning_tokens, modelo, reasoning_effort y operation_id seguro. Verificar JSON final valido y latencia. 900 incluye razonamiento y salida visible; si aparece incomplete/max_output_tokens o no quedan bloques finales utiles, NO aprobar suficiencia ni ocultarlo con retries. La variacion de tokens requeriria decision/cambio separado. [OpenAI Docs: razonamiento y presupuesto](https://developers.openai.com/api/docs/guides/reasoning).

## Pendientes y limites del handoff

- Los clientes actuales contienen URLs del backend production y su Supabase en codigo. Este commit NO los redirige: hace falta una configuracion/copia de pruebas aislada antes de una validacion Chrome end-to-end. No basta con crear Render staging; no editar ni cargar sobre la copia de uso real por accidente.
- Variantes SaaS pendientes de dashboard: Starter 1683122/1683117; Pro 1683111/1683097; Agency 1683071/1683081. Audit 1683161/1683159/1605502 y extras 1683224/1683227/1683228 tambien deben verificarse. No se certifican IDs test/live.
- Checkout actual devuelve enlaces de catalogo codificados y binding, NO crea checkout via API con test_mode. LEMON_ALLOW_TEST_WEBHOOKS=true no convierte esos enlaces ni rechaza todos los eventos live. Bloquea pruebas de compra reales hasta verificar el destino test; si el catalogo test difiere, necesitara un bloque separado, no un parche en este handoff.
- El override administrativo existente concede capacidad especial: no usar esa cuenta para validar limites comerciales.
- Cuenta OpenAI/acceso a modelos, calidad/latencia/Search y suficiencia de 900 aun no validados con API real; los fixtures no sustituyen esa prueba.
- Web publica de Framer y Desktop permanecen fuera del commit backend. Los checkouts web antiguos siguen pendientes del proyecto editable/login; no afirmar cierre global de publicacion.
- Telemetry es log interno, no ledger durable. Determinar retencion/acceso y cotejar factura antes de produccion.

Pruebas previas aprobadas: Chat GPT-6 24 grupos; Audit GPT-6 15; consumo 65; multiproceso 32; Search 13; Lemon 76, mas scope/crawl/recovery/Schema/Legal/PDF/resume/descarga. Reportes detallados en staging-handoff/validation. Durante este handoff se revisan sintaxis, imports, lockfile, hashes y tests SIN DB/proveedor; no se ejecutan migraciones, ni siquiera en staging.

Comprobaciones de este handoff: 26 archivos backend aprobados con hash intacto; 44 ENV documentadas; imports activos y sintaxis PASS; npm ci desde una copia aislada limpia PASS; arranque real sin credenciales y /health + /api/health PASS; /api/chat sin sesion ->401. Search unitario: 13 PASS. JSON recovery: 6 casos frontend + 23 comprobaciones PASS. Ninguna de estas comprobaciones conecto Supabase/OpenAI/Lemon real ni ejecuto SQL. El warning de dependencia node-domexception obsoleta es heredado del lockfile; no se actualizan dependencias aqui.

git diff --cached --check avisa espacios finales heredados en los constructores confiables y lineas vacias EOF en dos informes copiados. Se preservan sus bytes aprobados en vez de formatear producto/documentacion historica durante el handoff. El check del resto del staged pasa; no hay conflictos ni fallos de sintaxis. El arbol local conserva .DS_Store modificado y CONFIGURAR-CLAUDE.md no seguido, ambos excluidos del commit nuevo.

NO cambios adicionales de producto. NO merge a main. NO deploy Render. NO SQL remoto. NO packaging de extensiones. Solo commit local y push explicito de refs/heads/staging si hay acceso.
