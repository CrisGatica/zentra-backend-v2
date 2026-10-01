# Concurrencia global: cierre local de las tres brechas

Estado al 30 de septiembre de 2026: cambios SOLO locales, sobre el trabajo previo. No commit, push, deploy, paquetes ni migraciones de produccion. Se preservaron los cambios pendientes de auth/billing/CORS; no se incluyeron nuevas modificaciones de esos bloques.

## Causas y correcciones

1. El lease vencido permitia tomar una ejecucion cuyo proveedor seguia activo. SQL rechazaba el commit antiguo, pero el wrapper JSON ignoraba ese rechazo y entregaba contenido. Se persiste provider_started_at antes de contactar al proveedor, se impide takeover automatico tras ese punto y se condiciona entrega/finalizacion al token vigente. Un fallo de transporte no habilita fallback/regeneracion del mismo worker.
2. La busqueda competitiva tenia cache/pending solo en Maps por instancia. Ahora tiene una fila durable por usuario/producto, Audit y hash de consultas/scope/dominio, sin otro descuento. Las Maps siguen siendo optimizaciones, no autoridad. Participar en una busqueda externa ya en curso tambien se marca antes de esperarla.
3. El generador leia la portada y el pipeline leia internas antes de reservar en seo_analysis. Ahora /api/audit/reserve valida Auth y reserva el recibo atomicamente antes de collectPageData/readAuditPrimaryPage/analyzeSEO. El token de adquisicion se valida dentro de la misma transaccion que admite la generacion; no hay una ventana entre validacion y handoff.

## Maquina de estados

| Evidencia persistida | Accion permitida |
| --- | --- |
| running, sin proveedor, lease vigente | Esperar; no ejecutar en otro worker |
| running, sin proveedor, lease vencido | Recuperacion segura con token nuevo; refund/re-reserva netos segun recibo original |
| running, proveedor iniciado, lease vigente | Seguir/consultar la ejecucion existente; no segunda admision |
| running, proveedor iniciado, lease vencido | execution_uncertain; mantener recibo y ownership; no takeover, refund ni proveedor automaticos |
| done con respuesta persistida | Replay de esa respuesta, sin proveedor ni nuevo descuento |
| contenido util checkpointed, fallo confirmado posterior | Conservar/cachear contenido, done, sin refund |
| contenido util checkpointed, resultado posterior externo incierto | Mantener running/incierto y checkpoint; no refund ni repeticion automatica |
| failed confirmado sin contenido util ni hermanos activos/utiles | Refund maximo una vez; retry seguro segun limite existente |

No se agrego un enum terminal ficticio: la incertidumbre se deriva de running + provider_started_at + lease vencido. Durante un fallo de transporte el worker devuelve execution_uncertain y no finaliza la fila. Si el lease todavia sigue vigente, otro cliente puede observar in_progress antes de que pase a incierto; esto tampoco autoriza otro proveedor.

El marker se escribe inmediatamente antes del envio externo, de forma conservadora. Una caida entre ese marker y el envio puede dejar pendiente una peticion que nunca llego al proveedor. Es preferible a duplicar automaticamente una peticion que SI llego. No se afirma exactly-once externo.

## Ownership, entrega y renovacion

- Se reutiliza lease_token UUID: todo start, checkpoint, renewal y finish exige usuario, operacion, hash y token actual. Un token reemplazado no puede iniciar, finalizar, refundear ni entregar resultado terminal.
- La propiedad original NO se reemplaza en un caso incierto. Si su worker sigue vivo y consigue una respuesta tardia, puede persistirla con ese mismo token, incluso tras vencer el TTL. Esto es reconciliacion del resultado, no una nueva generacion.
- JSON se entrega solo despues de persistencia aceptada. Un commit rechazado produce un error controlado, no un 200 con contenido no registrado.
- Streaming guarda el texto util antes de emitir cada capa. useful_response y el checkpoint impiden refund tras una caida; cerrar el popup no devuelve el consumo ni autoriza un proveedor paralelo.
- Ejecucion y busqueda: TTL de 5 minutos y heartbeat de servidor cada 30 segundos, condicional en PostgreSQL. Los timers se limpian al finalizar/cerrar la respuesta; nunca constituyen el lock.
- Adquisicion previa al crawl: TTL de 30 segundos y renovacion del cliente cada 10 segundos. Antes de IA, una adquisicion abandonada sin ninguna generacion se devuelve al intentar reservar otra; se conserva el recibo original y la devolucion es idempotente. El handoff invalida al holder antiguo.
- Las fases de Audit, refinamientos y la unica recuperacion JSON interna siguen autorizadas por contexto original. Un resultado conocido recuperable admite la recuperacion existente; una excepcion de transporte incierta NO la admite.

## Resume y alcance preservado

Resume normal de Chat no fue editado. Audit sigue retomando el mismo operationId, y COMPLETED/PDF_READY sigue terminal antes de Save As. El cliente solo propaga execution_uncertain/execution_pending para no fabricar un fallback PDF ni borrar un job aun activo por el vencimiento del polling existente. No se aumento el polling ni se agregaron loops de generacion.

Se conserva la expiracion local previa de jobs antiguos; PostgreSQL conserva la operacion incierta y su recibo incluso si el popup deja de mostrar ese job. No se construyo una interfaz ni endpoint nuevo de reconciliacion manual. El operador debe conservar el ID de la operacion y comprobar el resultado externo antes de decidir su cierre; no se invento una politica comercial para liberar resultados desconocidos.

No se cambiaron algoritmo SEO, keywords, scope competitivo, Schema, Legal, score, coverage, recovery JSON, visual PDF, animaciones, CTA, scroll, Desktop, audio gate, planes/precios, Lemon Squeezy, CORS o rate limiting. El cambio de release-security.js solo protege los dos nuevos endpoints de reserva/devolucion.

## Archivos de producto

Base absoluta: `/Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES`.

Backend, bajo `zentra-backend/`:

- `server.js`: marker de proveedor, excepcion de transporte, checkpoint antes de streaming, endpoints de adquisicion.
- `release-operations.js`: ownership/start/checkpoint, errores de persistencia controlados y heartbeat.
- `release-audit-steps.js`: busqueda durable, heartbeat y omision de metadata privada de adquisicion en el cuerpo congelado.
- `release-competitive-search.js`: inicio persistido antes del proveedor/participacion; distingue fallo confirmado de resultado incierto. Prompt, queries, limites y criterios de competidores intactos.
- `release-security.js`: auth de `/api/audit/reserve` y `/api/audit/release`.
- `supabase-release-guard.sql`: marker/checkpoint columns, fencing/uncertain/refund, handoff atomico.
- `trusted-audit-builders.js`: solo propagacion de errores de ejecucion; no cambios de SEO/prompts.
- NUEVO `release-audit-acquisition.js`: contrato autenticado de reserva/release, override ilimitado solo por correo verificado del servidor.
- NUEVO `supabase-execution-guard.sql`: funciones y tablas de ejecucion/search/adquisicion.

Las mismas tres modificaciones de transporte/lifecycle en cada una de estas carpetas:

- `publicacion/chrome-store/zentra-ai-chrome-store-clean/`: `zentra-api-client.js`, `claude-pdf-generator.js`, `claude-integration.js`.
- `ZENTRA IA/ZENTRA_AI_v1.0.1_env_phase1_lab/`: los mismos tres archivos.
- `ZENTRA AUDIT/ZENTRA_AUDIT_v1.0.0/`: los mismos tres archivos, conservando diferencias propias del producto.

Son 18 archivos de producto modificados/nuevos en esta pasada; no se modificaron los otros pendientes preexistentes. Los cambios de claude-integration/trusted son unicamente dos salidas excepcionales, no una nueva logica SEO ni cambios del chat normal.

## Esquema y migracion local

Orden reproducible: `supabase-users.sql` -> `supabase-release-guard.sql` -> `supabase-execution-guard.sql`. El primer archivo ya existia y no fue editado aqui.

- `zentra_requests`: provider_started_at nullable, useful_response boolean default false; mantiene PK, token, lease, attempts y enum originales.
- `zentra_search_requests`: PK(user_id, operation_key, request_hash), estados running/done/failed, token/TTL/attempts, marker y respuesta persistida. user_id ya distingue los productos.
- `zentra_audit_acquisitions`: PK(user_id, operation_key), URL fuente, estado, token y lease. El recibo sigue siendo zentra_usage_receipts; NO nueva cuota.
- RPC de proveedor: start/checkpoint; busqueda: begin/start/renew/finish; adquisicion: acquire/handoff/release.
- zentra_begin_request agrega p_acquisition opcional y elimina su antigua sobrecarga de ocho parametros, para no dejar un camino alternativo sin fencing. Acquire incorpora override server-only; nunca toma unlimited/plan del body.
- Todas las tablas nuevas tienen RLS; anon/authenticated/PUBLIC no tienen permisos de tablas ni ejecucion de RPC; service_role conserva el acceso. Migraciones aplicadas y repetidas solo en PostgreSQL efimero local.

## Pruebas y resultados

Auth y proveedores fueron simulados. PostgreSQL, SQL/RPC, Express, procesos separados, SIGKILL y generador/transporte de Chrome fueron reales locales. No hubo llamadas facturables, Auth real, produccion, PDFs nuevos o dialogo Save As nativo.

| Suite | Resultado final |
| --- | --- |
| quota-multiprocess.test.mjs | 28 grupos PASS, escenarios A-L |
| quota.test.mjs | 53 grupos PASS; ahora tambien verifica auth en reserve/release (11 rutas sensibles) |
| backend-auth-boundaries.test.mjs | 14 grupos PASS, incluidos transporte pendiente/incierto, extraccion de body y bloqueo de fallback tras fallo de red |
| audit-steps.test.mjs | 21 salidas PASS; prompts/opciones/fases y evidencia intactos |
| refinements.test.mjs | 11 salidas PASS, incluido OCR |
| audit-json-recovery.test.mjs | 23 checks consultivos + 6 de parser/presupuesto PASS; un retry conocido, mismo crawl/consumo |
| audit-wait-diagnostic.test.mjs | 9 escenarios PASS; RUNNING/resume y PDF_READY, incluido estado incierto sin PDF falso |
| audit-download.test.mjs | 9 escenarios PASS |
| audit-loader.test.mjs | 9 salidas PASS; progreso/cleanup/resume y baseline SEO comprobado por SHA |
| audio-gate.test.mjs | 6 grupos PASS; gate/dictado sin cambios |
| chat-structured-response.test.mjs | PASS |
| release-competitive-search.test.js | 9 tests PASS |
| audit-evidence / small-site-topics / Schema / domain-criteria / competitive | 22 / 6 / 14 / 2 / 23 salidas PASS |
| sintaxis de las cuatro copias | 67 JS PASS: backend 12, clean 22, Lab 23, Audit 10 |
| git diff --check | PASS |

Multiproceso: cuatro planes al ultimo cupo; 20 requests/10 acciones; replay/OCR/refinamientos; doble refund; independencia entre cuentas; pago unico; una busqueda entre procesos y replay persistido; SIGKILL durante search sin takeover; expiracion posterior a provider_started; token viejo incapaz de refund/commit/delivery; checkpoint util sin refund; heartbeat real de 30 segundos; SIGKILL antes/despues de proveedor; reserva/handoff; generador real perdedor con 0 crawl/lectura/IA/search; adquisicion abandonada y RPC privadas.

Tambien se ejecuta el wrapper real de proveedor con perdida de transporte: responde 503 incierto sin convertir la fila a failed/refund; un segundo proceso recibe 425 o 409 tras expiracion, siempre con una sola llamada. Los contadores se restablecen entre fixtures; no se presenta la suma historica de todos los recibos de prueba como contabilidad de un usuario real.

La suite antigua de cuotas esperaba dos busquedas HTTP 200 simultaneas. Se adapto al contrato durable correcto: 200/425 en curso y luego 200 cacheado, siempre una llamada. Los fixtures de progreso ahora simulan reserve/release, sin relajar sus asserts.

La primera ejecucion de audit-loader fallo contra un snapshot viejo anterior a los criterios SEO ya aprobados. Se reemplazo solo ese baseline de prueba por el SHA capturado antes de ESTA pasada y una version que excluye las dos salidas excepcionales nuevas: el hash coincide exactamente. Luego todos sus asserts pasaron.

Una comprobacion adicional del test historico chat-send-animation fallo en su comparacion inicial contra otro snapshot obsoleto, antes de ejecutar sus escenarios visuales. No se altero ese test ni el chat para forzar el resultado; no se afirma que esa suite visual haya pasado. Se verificaron hashes: chatbot, animacion, popup, CSS y Desktop son identicos al baseline anterior. El test de CTA dentro del mismo comando no llego a ejecutarse tras ese fallo. No son cambios funcionales introducidos por esta pasada.

Las comprobaciones de hash cubren 83 archivos anteriores: 67 sin cambios y 16 modificados autorizados, mas los dos archivos nuevos. Quitando las dos salidas execution_uncertain/execution_pending, claude-integration vuelve exactamente al SHA anterior `36518ada5c0af663caef3b68d2157a403768b68acced4e49adbe3087517620c2`.

Pruebas/QA modificadas en el runtime existente: quota.test.mjs, quota-multiprocess.test.mjs, quota-multiprocess-worker.mjs, backend-auth-boundaries.test.mjs, audit-wait-diagnostic.test.mjs, audit-loader.test.mjs, audit-fixtures.mjs, validate-sources.mjs. Documento nuevo: este informe. Se actualizan encabezados/nota final de los dos informes anteriores para distinguir el estado actual de la caracterizacion historica.

## Riesgos y siguiente validacion

- At-most-once AUTOMATICO en resultado incierto, NO exactly-once fisico universal. Fases legitimas y recuperacion tras respuesta confirmada conservan su comportamiento acotado.
- No hay comprobacion automatica del resultado externo de un proceso muerto ni UI de reconciliacion. No liberar su saldo a ciegas. El coste externo puede haberse incurrido sin tener contenido entregable.
- La tabla de adquisicion impide iniciar trabajo sin cupo y fencea el handoff, pero no puede cancelar fisicamente un fetch de crawl que un popup antiguo ya envio antes de perder su lease.
- Antes de desplegar: validar Supabase Auth/PostgREST real y staging, aplicar migraciones coordinadas, y drenar workers antiguos que no escriben provider_started_at. Un rolling deploy mezclando ejecutores viejos/nuevos no tiene la garantia completa.
- Los cambios locales de billing/CORS/rate limiting siguen pendientes e independientes. No desplegar toda la carpeta sucia como un fix aislado. Desktop/audio comercial siguen postergados; no habilitar el audio gate.
- Un test visual historico requiere renovar su baseline antes de usarlo como gate de publicacion; no se empaqueto ni publico nada para sortearlo.

Conclusion: las tres brechas quedan corregidas y verificadas LOCALMENTE bajo la politica autorizada. No se da por validada produccion ni por cerrado el lanzamiento completo de Zentra.
