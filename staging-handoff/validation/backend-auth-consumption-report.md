# Autenticacion y consumo del backend de Zentra

**Estado local mas reciente:** las tres brechas de ejecucion/concurrencia identificadas despues de esta revision ya se corrigieron, con 28 grupos multiproceso y 53 grupos de cuotas PASS. Detalle actual en [execution-concurrency-report.md](/Users/cristiangatica/Documents/Codex/2026-06-29/po/outputs/release-test-runtime/execution-concurrency-report.md). Las secciones siguientes conservan el historial por pasada; no interpretar sus pendientes de concurrencia como el estado actual. Staging, CORS/rate limiting y billing siguen independientes. No hubo publicacion.

Revision focalizada del 29 de septiembre de 2026. Las correcciones estan SOLO en local. No hubo commit, push, deploy ni paquetes. Las secciones originales conservan el diagnostico de la primera pasada; el estado actualizado tras postergar Desktop y gatear audio esta al final, en "Cierre local para Chrome". La produccion indicada por el usuario aun usa las protecciones anteriores.

## Estado comparado

- GitHub origin/main confirmado mediante fetch: 5adc7635f69042fe8cf343e756033c192f25bead.
- Render LIVE en ese SHA es el estado informado por el usuario; no se consulto Render ni se ejecutaron llamadas facturables en produccion.
- HEAD del checkout local: a8e5af8. Ya existian cambios importantes sin publicar en server.js, SQL, autenticacion, operaciones, refinamientos, facturacion y builders confiables. Se conservaron.
- El helper consultivo local no es identico al publicado: usa el validador del builder confiable. Esa diferencia era preexistente; no se reemplazo ni modifico aqui.
- Esta pasada NO reimplemento las protecciones de autenticacion/SQL ya presentes en local. Las inspecciono y probo, y cerro dos defectos concretos de integracion.

## Mapa de endpoints

A: publico legitimo. B: autenticado sin consumo. C: autenticado con consumo. D: webhook. E: health. F: interno.

| Ruta | Clase local | Auth local | Consumo local | Estado publicado y riesgo |
| --- | --- | --- | --- | --- |
| GET /api/health | E | Publico | No | Publicado expone modelos/configuracion; pendiente del siguiente bloque |
| GET /api/user | B | Supabase getUser | No | Publicado confia en identidad del cliente |
| GET /api/subscription/usage | B | Supabase getUser | No | Publicado confia en identidad del cliente |
| GET /api/subscription/capacity/offers | B | Supabase getUser y plan servidor | No | Publicado confia en identidad del cliente; no cambiar ofertas ahora |
| POST /api/subscription/consume | B | Supabase getUser | Sin lease de generacion rechaza generation_required | Publicado consumo separado de la generacion |
| POST /api/audit/consume | B | Supabase getUser | Rechaza generation_required | Publicado consumo separado de la generacion |
| POST /api/chat | C | Supabase getUser | Reserva antes del proveedor | Publicado generacion no exige reserva base |
| POST /api/chat/stream | C | Supabase getUser | Misma reserva; resultado cacheado/refund condicionado | Publicado generacion no exige reserva base |
| POST /api/audit/competitive-search | C | Supabase getUser y auditoria propia completada | Incluida en reserva previa de Audit; sin segundo descuento | Publicado valida sesion, pero no reserva; corregido localmente |
| POST /api/audio/transcribe | B, insuficiente para su coste | Supabase getUser | NINGUNO | Publicado tampoco exige sesion; local sigue sin cuota/operacion |
| POST /api/lemon/webhook | D | HMAC SHA256 sobre rawBody | No es generacion de IA | Firma preservada; no middleware de usuario |

No hay otra ruta A ni un endpoint directo de refund. OCR, reescritura, analisis, generacion de contenido, SEO y refinamientos pasan por /api/chat o /api/chat/stream. Las funciones callAiProvider, callLayeredChatStep, transcribeDesktopAudio y las RPC de reserva/finalizacion son F, no endpoints HTTP independientes. La ultima transcripcion si es accesible mediante la ruta de audio indicada.

## Vulnerabilidades verificadas y causas

1. **Publicado: identidad no autenticada en rutas generales.** getIdentityFromRequest extrae email/userId del body, query o routing. Obtener un usuario por esos datos no prueba que el solicitante sea su titular. Esto tambien afecta las excepciones de consumo basadas en email.
2. **Publicado: generacion y consumo separados.** No hay middleware que reserve el cupo base antes de las rutas de chat. Omitir la llamada del cliente a consume no impide la generacion.
3. **Publicado: carrera en contador.** Se ejecuto la funcion consumeSubscriptionUsage del SHA publicado con dos lecturas sincronizadas de un contador 299/300: ambas autorizaron; ambas escribieron 300. Simulacion aislada, no ataque ni prueba contra produccion.
4. **Local, corregido: busqueda facturable sin auditoria reservada.** Tener sesion bastaba para llamar a OpenAI Search con consultas elegidas por el solicitante.
5. **Local, corregido: refund despues de entregar contenido util en streaming.** Una excepcion posterior a la capa fast llevaba al catch que llamaba failOperation sin considerar el texto ya generado. Reproducido con el handler real y PostgreSQL: el contador volvia a 0 tras entregar una respuesta.
6. **Local, pendiente: transcripcion facturable sin cuota.** Una sesion valida puede transcribir aunque haya agotado las acciones. No existe operationId ni reserva en ese contrato. No se altero audio por la restriccion explicita del encargo.

## Correcciones de esta pasada

**Busqueda competitiva:** se envia el ID/producto de la auditoria activa en el transporte de Chrome. El backend exige que exista una fase seo_analysis finalizada para ese usuario/producto/operacion. Reconstruye las consultas permitidas a partir del contexto y respuesta persistidos, sin red, proveedor ni crawl nuevo. Rechaza consultas ajenas, operaciones de otro usuario, fase inicial en curso, fallback consultivo degradado, evidencia tematica insuficiente y operaciones fuera de la ventana de 30 minutos ya usada por las fases posteriores.

La reconstruccion contempla web y el posible fallback social, pero no modifica la decision SEO del frontend. No significa que se haya persistido una validacion independiente de que cada fallback social era necesario.

Se comparte la llamada de busqueda en curso para solicitudes identicas del mismo usuario dentro de una instancia. Se conserva la cache existente y el retry posterior a un error del proveedor. No se cambio el rate limit ni el presupuesto de consultas.

**Streaming:** el ultimo texto util queda disponible para el cierre excepcional. Si una fase posterior falla, se finaliza/cachea ese texto y se conserva el consumo, en lugar de refundear una respuesta ya util. Sin texto util sigue el refund existente. El cierre del popup no invalida ese resultado conservado.

## Archivos modificados

Archivos de producto y pruebas del backend:

- [server.js](/Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/zentra-backend/server.js): middleware de autorizacion de busqueda y cierre excepcional de streaming.
- [release-audit-steps.js](/Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/zentra-backend/release-audit-steps.js): reconstruccion sin red y guard de busqueda.
- [release-competitive-search.js](/Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/zentra-backend/release-competitive-search.js): coalescencia de solicitudes identicas en curso.
- [release-competitive-search.test.js](/Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/zentra-backend/release-competitive-search.test.js): dos casos de concurrencia y fallo del proveedor.

Transporte identico en las tres copias, sin tocar UI o algoritmo SEO:

- [Chrome clean zentra-api-client.js](/Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/publicacion/chrome-store/zentra-ai-chrome-store-clean/zentra-api-client.js).
- [Lab zentra-api-client.js](/Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/ZENTRA IA/ZENTRA_AI_v1.0.1_env_phase1_lab/zentra-api-client.js).
- [Audit zentra-api-client.js](/Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/ZENTRA AUDIT/ZENTRA_AUDIT_v1.0.0/zentra-api-client.js).

Infraestructura de pruebas existente:

- [quota.test.mjs](/Users/cristiangatica/Documents/Codex/2026-06-29/po/outputs/release-test-runtime/quota.test.mjs).
- [audit-fixtures.mjs](/Users/cristiangatica/Documents/Codex/2026-06-29/po/outputs/release-test-runtime/audit-fixtures.mjs): parametro opcional de datos de pagina para probar una categoria respaldada.
- [backend-auth-boundaries.test.mjs](/Users/cristiangatica/Documents/Codex/2026-06-29/po/outputs/release-test-runtime/backend-auth-boundaries.test.mjs): pruebas focalizadas dentro del runtime existente.
- Este informe.

No se editaron release-security.js, release-operations.js, release-refinements.js, SQL, billing, JSON recovery, builders confiables, Schema, Legal, keywords, scope SEO, PDF, chat frontend, animaciones, scroll, CTA, resume ni Desktop.

## Cadena local validada

Bearer de Supabase desde el cliente
-> getUser(token) contra el proyecto Supabase configurado
-> identidad verificada y correo confirmado
-> contexto original/refinamiento validado
-> plan y acceso desde la fila de servidor
-> reserva RPC antes de generar
-> proveedor
-> resultado util persistido y cacheado, o fallo con refund vinculado a la reserva.

La libreria instalada confirma que getUser(jwt) consulta el endpoint /user de Auth; no es un decode local de un JWT enviado por el cliente. La validacion de firma, expiracion y pertenencia al proyecto se delega a Supabase Auth. No se agrego una validacion JWT paralela. Los tests de token invalido/expirado simulan la respuesta de rechazo de Auth, no sustituyen una prueba de configuracion real de ese proyecto.

userId, email, plan, tier, quota, remaining, role, permissions, isPro/isAgency y los campos equivalentes del body no conceden autoridad. El producto Audit/subscription selecciona el saldo a consultar; no acredita por si solo la compra ni el plan. La excepcion ilimitada existente utiliza el email verificado, no el email arbitrario del body.

## Operaciones y recuperacion

- operationId se vincula al usuario, producto, hash de raiz y hash de peticion. El source arbitrario del cliente no autoriza consultas nuevas gratuitas.
- Reintento exacto terminado: reproduce cache, sin proveedor ni consumo adicional.
- Misma peticion en curso: 425, sin segunda generacion normal. El transporte mantiene el ID.
- Un refinement se reconstruye desde builders fijados y contexto/respuesta guardados. Stage desconocido o raiz ajena: rechazo.
- Un usuario no puede leer/refinar/reproducir una operacion ajena. Usar el mismo UUID como raiz propia crea otra operacion propia y cobrada, no transfiere permisos.
- Refund solo interno, con usuario/operacion/hash/lease. Roles publicos no pueden ejecutar RPC de refund ni terminar reservas. Fallos simultaneos no devuelven dos unidades; fallar un refinamiento no devuelve una accion que ya produjo contenido util.
- seo_analysis conserva maximo una regeneracion interna: misma peticion, mismo lease, un descuento y cero crawl adicional. La reproduccion de cache no dispara recovery de nuevo.
- El fallback degradado sigue disponible y no habilita la busqueda competitiva como si fuera analisis consultivo completo.

## Pruebas ejecutadas

| Suite | Resultado |
| --- | --- |
| quota.test.mjs con PostgreSQL real local, dos conexiones y HTTP | 53 grupos PASS |
| backend-auth-boundaries.test.mjs | 9 grupos PASS |
| release-competitive-search.test.js | 9 tests PASS |
| audit-steps.test.mjs | 21 salidas PASS, fases/prompt/opciones iguales y evidencia ajena rechazada |
| audit-json-recovery.test.mjs | 23 comprobaciones consultivas PASS, mas 6 comprobaciones de parser/presupuesto |
| audit-small-site-topics.test.mjs | 6 grupos PASS |
| refinements.test.mjs | 11 salidas PASS |
| chat-structured-response.test.mjs | PASS |
| audit-wait-diagnostic.test.mjs | 8 escenarios PASS |
| audit-download.test.mjs | 9 escenarios PASS |
| node --check en los archivos funcionales modificados y git diff --check | PASS |

Se comprobo ausencia de modificaciones de filas de usuario y ausencia de llamadas al proveedor ante auth ausente/invalida/expirada en las nueve rutas sensibles. Se probaron plan Free agotado con campos Agency falsificados, identidad ajena, ultimo credito de Audit, refunds, retry, refinamientos y JSON recovery dentro de la misma accion.

El test de streaming fallo ANTES del fix mostrando 0 en lugar de 1 despues de una respuesta util; pasa tras el fix. Tambien pasa el fallo de la capa inicial sin contenido util, con refund de solo su propia reserva.

Se ajusto un fixture que no tenia temas suficientes para autorizar una busqueda: se agrego una categoria observada para la prueba positiva, manteniendo una prueba negativa con evidencia debil. No se debilito el filtro real de keywords.

Los proveedores y Supabase Auth se simularon; la base PostgreSQL, RPC y reservas fueron reales locales. El handler real de streaming se ejecuto con sus dependencias de proveedor/routing simuladas para provocar el fallo posterior. Las pruebas de middleware publico usan handlers probe; la firma webhook se probo con la funcion real sin ejecutar compras.

No se ejecutaron login real, proveedor real, webhook comercial real, navegador nativo/Save As ni multiples instancias de Render. Descarga y cierre/reapertura se validaron por simulacion DOM. No se ejecuto la suite general antigua que compara todo el chat contra backups, porque no corresponde a este cambio focalizado.

Dependencias de prueba hidratadas bajo /tmp/zentra-topic-check-runtime; no se alteraron dependencias de producto.

## Concurrencia y limites pendientes

**Local ya existente, probado:** el SQL con bloqueo de fila autoriza solo una peticion entre dos conexiones independientes al llegar a 299/300; el mismo operationId descuenta una sola vez. Tambien se probo mediante HTTP antes del proveedor.

**Publicado, NO corregido por un deploy:** el SHA 5adc763 conserva read/modify/write y la carrera reproducida. No se debe presentar el trabajo local como proteccion activa de produccion.

**No garantizado globalmente:** la cache/coalescencia de busquedas vive en memoria de una instancia. Dos instancias, un reinicio o un retry tras error pueden provocar nuevas llamadas externas. Resolver idempotencia/presupuesto durables de busqueda requiere el siguiente bloque, no un nuevo contador comercial improvisado.

Los leases locales impiden que un worker vencido finalice una reserva tomada por otro. No certifican exactamente una llamada fisica al proveedor en toda situacion de caida, perdida de heartbeat o particion de red.

## Decision pendiente de audio

El consumidor encontrado graba/transcribe en Desktop y deja el texto en el composer; NO envia el mensaje. El usuario puede descartarlo. Vincularlo automaticamente al consumo del chat sin cambiar Desktop no esta definido.

Alternativas:

1. Cupo tecnico independiente de transcripciones por usuario/periodo, definido explicitamente. Recomendado para separar el coste de borradores de los mensajes, pero requiere aprobar la politica y su implementacion.
2. Consumir una accion al transcribir y compartirla con un envio posterior. Requiere ajustar el contrato y lifecycle de Desktop para no cobrar doble ni reutilizar el ID con otros mensajes.
3. Transcripcion incluida sin limite de consumo: no recomendado, mantiene una superficie facturable explotable.

No se eligio ninguna politica ni se desactivo la funcionalidad. Esta ruta sigue siendo un blocker, no un cierre completado.

## Siguiente bloque y no desplegar todavia

- Resolver la politica y autorizacion/consumo de audio, con compatibilidad del consumidor.
- Revisar/aislar el trabajo local de auth/operaciones y sus migraciones antes de publicar. El diff acumulado contiene billing/planes/CORS ajenos; NO desplegar toda la carpeta como un fix aislado.
- CORS: comprobar allowlist de IDs reales de Chrome y orientes legitimos, preflight y entorno. Ya hay codigo local pendiente; no se cambio aqui.
- Rate limiting: distinguir limitacion de API y presupuesto de proveedores, revisar almacenamiento/coordinacion entre instancias y proxy/IP. No cambiar los limites por intuicion.
- Endpoints publicos: conservar webhook fuera de auth de usuario y comprobar firma/idempotencia por su flujo especifico.
- Health: publicado expone modelos/configuracion; local ya tiene payload minimo. Validar alcance de liveness/readiness sin publicar metadata interna.
- Validacion en staging con Auth real, DB/migraciones reales y llamadas controladas antes de considerar el bloqueo global cerrado.

Audit/PDF permanece cerrado. Los archivos y comportamiento RUNNING/PDF_READY, resume del chat, interfaz y animaciones no fueron modificados.

## Cierre local para Chrome

Decision posterior del usuario: lanzar primero Chrome y backend; Desktop queda postergado. El pendiente comercial y tecnico de transcripcion no se resuelve en esta pasada. Se conserva el analisis anterior como pendiente de **Desktop Beta AUDIO AUTH CONSUMO**, no como requisito para habilitar el microfono de Chrome.

Chrome usa SpeechRecognition del navegador para llenar el composer y solo reserva una accion de chat al enviar. El cliente compartido conserva transcribeAudio, pero su unico call site en el chatbot pertenece a la rama isDesktopShell. No se elimino ni modifico esa rama.

Se agrego ZENTRA_AUDIO_TRANSCRIPTION_ENABLED siguiendo la configuracion por variables de entorno ya usada en server.js. Sin variable, vacia, false o valor distinto de true, el endpoint queda deshabilitado. La comparacion normaliza espacios y mayusculas. Requiere reiniciar el proceso para cambiar el flag; el body no puede habilitarlo.

POST /api/audio/transcribe sigue detras del middleware de auth existente. Sin sesion o con sesion invalida/expirada devuelve 401 antes de generar. Con sesion valida y flag deshabilitado devuelve 503 con {"error":"Esta funcion no esta disponible."}; no llama a transcribeDesktopAudio, no llama al proveedor y no descuenta acciones. El codigo de transcripcion se conserva intacto.

**No configurar el flag en true para el lanzamiento Chrome.** Habilitarlo restaura el contrato autenticado anterior, que aun NO tiene cuota, ID compartido, replay ni deduplicacion del audio. No debe habilitarse en produccion antes de completar Desktop Beta. El rechazo deshabilitado es una medida de seguridad, no una implementacion de consumo de audio.

Archivos de esta pasada: server.js (declaracion del flag y gate al inicio del handler); outputs/release-test-runtime/audio-gate.test.mjs (pruebas focalizadas); este informe. Ningun archivo de Chrome, Lab, Audit o Desktop fue modificado en esta pasada. Tampoco SQL, operaciones, billing, JSON recovery, UI, CORS ni rate limiting.

Pruebas repetidas tras el gate:

| Suite | Resultado |
| --- | --- |
| audio-gate.test.mjs | 6 grupos PASS: default/valores, auth, spoof/concurrencia/replay bloqueados, opt-in, errores y dictado Chrome |
| quota.test.mjs | 53 grupos PASS con PostgreSQL real local y HTTP |
| backend-auth-boundaries.test.mjs | 9 grupos PASS |
| release-competitive-search.test.js | 9 tests PASS |
| audit-steps.test.mjs | 21 salidas PASS |
| audit-json-recovery.test.mjs | 23 comprobaciones consultivas y 6 de parser/presupuesto PASS |
| refinements.test.mjs | 11 salidas PASS, incluida preservacion de OCR y sus refinamientos |
| chat-structured-response.test.mjs | PASS |
| audit-wait-diagnostic.test.mjs | 8 escenarios PASS |
| audit-download.test.mjs | 9 escenarios PASS |
| node --check server.js y git diff --check | PASS |

Auth y proveedor se simularon; no se ejecutaron llamadas facturables ni login real. Audio se probo ejecutando la declaracion real del flag, el handler real y los middleware actuales con dependencias simuladas. No es una prueba HTTP contra Render. Las pruebas de cuotas usaron DB/RPC reales locales; las fases del proveedor y Auth se simularon. No se produjo un PDF real ni se uso el dialogo nativo de Chrome en esta pasada.

**AUTH y CONSUMO de Chrome: cerrado localmente dentro del alcance de este bloque.** Chat normal/streaming/OCR y refinamientos utilizan rutas autenticadas con reserva antes del proveedor. SEO/recuperacion consultiva y fases de Audit reutilizan su reserva; la busqueda exige una auditoria propia completada y consultas reconstruidas del contexto autorizado. Consumos legacy separados no autorizan generacion gratuita. No se encontro otro bypass en los flujos inspeccionados de Chrome bajo esta configuracion.

Esto NO equivale a seguridad validada en produccion ni a cierre global del producto. Siguen pendientes: aislar los cambios locales y migraciones antes de desplegar, staging con Auth real/DB real, atomicidad y disponibilidad global bajo multiples instancias/reinicios/leases vencidos, presupuesto/idempotencia durable de busqueda, validacion de CORS/rate limiting, y el bloque independiente de planes/Lemon Squeezy. Las carreras del backend publicado no se corrigieron mediante un deploy en esta tarea.

No hubo commit, push, deploy, empaquetado ni publicacion. Desktop/Electron/instaladores quedaron intactos.

## Validacion multiproceso posterior

La pasada siguiente confirma la atomicidad normal de reservas/refunds en dos procesos con PostgreSQL real, pero reproduce dos limites globales: busqueda duplicada entre instancias y entrega de un worker con lease vencido cuyo resultado no se persiste, permitiendo un refund indebido posterior. Ademas, Audit lee paginas antes de reservar. Esto limita expresamente el alcance del cierre local anterior: autenticacion y admision ordinaria estan protegidas; NO hay todavia cierre global de ejecucion/entrega/refunds bajo perdida de ownership. Detalle y reproducciones en [quota-concurrency-report.md](/Users/cristiangatica/Documents/Codex/2026-06-29/po/outputs/release-test-runtime/quota-concurrency-report.md). No se editaron producto ni migraciones en esa pasada; se detuvo la implementacion antes de cambiar el modelo de recuperacion.
