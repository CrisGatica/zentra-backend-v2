# Cierre local de seguridad HTTP de Zentra

Estado al 30 de septiembre de 2026: cambios y pruebas exclusivamente locales. Staging sigue en standby. No se consulto ni modifico produccion, no hubo commit, push, deploy, paquetes ni migraciones remotas. Esta pasada no certifica el lanzamiento.

## Configuracion encontrada

El entrypoint es zentra-backend/server.js, segun package.json. Antes de esta pasada ya habia allowlist CORS, autenticacion Supabase, limites en Maps de 240/IP/minuto y 120/usuario/minuto, errores JSON controlados y X-Powered-By desactivado. No habia rate limit persistente, politica explicita de proxy, defensa de rutas desconocidas ni headers nosniff/no-store generales. /api/health devolvia ok, service, status y timestamp; /health no existia.

Chrome clean tiene host_permissions con all_urls y CSP connect-src https. zentra-api-client hace fetch autenticado desde el popup, con redirect:error, no desde el content script. Chrome clean, Lab y Audit NO se modificaron.

## Mapa de endpoints

A = publico necesario; B = autenticado; C = autenticado con reserva/consumo o dependencia de una reserva; D = webhook firmado; E = health. No hay endpoints HTTP internos/debug en este entrypoint ni rutas de login/session: ese login pertenece a Supabase Auth, fuera de este servidor. No se invento un admin. Rutas desconocidas no deben ejecutar trabajo y responden 404 controlado.

| Metodo y ruta | Clase y autorizacion | CORS navegador | Abuso y limite | Informacion devuelta |
| --- | --- | --- | --- | --- |
| GET /api/health, GET /health | A/E, sin auth | Solo origen listado | Flood; health/IP local | Solo ok |
| GET /api/user | B, sesion verificada | Si, allowlist | Consultas; read/usuario persistente | Estado propio de plan/acceso |
| GET /api/subscription/usage | B, sesion verificada | Si, allowlist | Consultas; read/usuario persistente | Consumo propio; contrato conservado |
| GET /api/subscription/capacity/offers | B, sesion verificada | Si, allowlist | Consultas; read/usuario persistente | Ofertas propias; contrato conservado |
| POST /api/subscription/consume | B, sesion verificada, guard existente | Si, allowlist | Spam; consume/usuario persistente | No permite consumo separado sin generacion |
| POST /api/audit/consume | B, sesion verificada, guard existente | Si, allowlist | Spam; consume/usuario persistente | No permite consumo separado sin generacion |
| POST /api/audit/reserve | C, sesion verificada y reserva atomica | Si, allowlist | Trabajo Audit; audit/usuario persistente | Token de adquisicion propio, no metadata de proveedor |
| POST /api/audit/release | B, sesion y ownership de adquisicion | Si, allowlist | Refund; audit/usuario persistente | Resultado de release propio |
| POST /api/audit/competitive-search | C, sesion y Audit propia completada | Si, allowlist | Busqueda externa; search/usuario persistente | Fuentes/resultados, no modelo/routing; sin segundo consumo |
| POST /api/chat | C, sesion y reserva existente | Si, allowlist | IA/SEO/OCR; generation/usuario persistente | Respuesta y consumo propios, recovery metadata acotada existente |
| POST /api/chat/stream | C, sesion y reserva existente | Si, allowlist | IA/stream; mismo bucket generation | Eventos publicos saneados; no proveedor/modelo/routing |
| POST /api/audio/transcribe | B, sesion, gate false por defecto | Si, allowlist | Audio externo; audio/usuario persistente | Rechazo si gate apagado; gate no editado |
| POST /api/lemon/webhook | D, firma existente | No lo necesita | Flood; webhook/IP local generoso | Acuse contractual firmado; Lemon funcional intacto |
| OPTIONS | Preflight, sin consumo/auth para origen permitido | Metodos/headers explicitos | public/IP local | Sin contenido de negocio |
| Otros metodos/rutas | No expuestos como funcionalidad | Sin autorizacion a origen ajeno | public/IP para desconocidos; auth para paths sensibles | 404 JSON controlado |

Express conserva HEAD implicito en rutas GET. No se agregaron endpoints costosos ni rutas debug. El codigo independiente de apps/inbox-api no esta montado por este entrypoint; no se modifico su aplicacion aparte.

## Politica CORS

ZENTRA_ALLOWED_ORIGINS sigue siendo la variable existente: lista separada por comas de ORIGENES exactos. HTTPS propio y chrome-extension:// seguido de un ID valido de 32 letras a-p. No se inventa el ID de Chrome Store ni se habilitan todas las extensiones.

- Se rechazan wildcard, null, credenciales en URL, paths, query/fragment y puerto de extension. Una configuracion invalida detiene el arranque con mensaje sin revelar su valor.
- Localhost, 127.0.0.1 e IPv6 loopback solo son configurables explicitamente fuera de production. Si no hay NODE_ENV se aplica validacion de origen conservadora de produccion.
- Sin allowlist no se autoriza ningun Origin. Un origen web/extension no listado recibe 403 en rutas sensibles, sin Access-Control-Allow-Origin. CORS nunca sustituye la sesion verificada.
- Sin Origin no se agregan headers CORS: server-to-server continua sujeto a auth, y el webhook a su firma. El webhook no se rechaza solo por un Origin ajeno; tampoco obtiene autorizacion CORS.
- OPTIONS permitido responde 204; metodos GET/POST/OPTIONS y headers Content-Type/Authorization/Idempotency-Key; maxAge 600; sin Access-Control-Allow-Credentials ni wildcard.

Ejemplo de configuracion web: ZENTRA_ALLOWED_ORIGINS=https://tryzentra.app. Agregar el dominio www solo si efectivamente se usa, y los IDs reales de Chrome que se quieran autorizar. Para desarrollo configurar NODE_ENV=development y agregar explicitamente http://localhost:PUERTO. No se modificaron variables remotas.

Chrome permite cross-origin desde popup/service worker con host_permissions; los content scripts siguen el origen de la web. Eso no evita que este backend compruebe un Origin si llega. El cliente no intenta falsificarlo ni se cambiaron sus permisos. Las pruebas simulan un Origin de extension valido; NO se capturo el header de una extension publicada ni se hizo login real. Referencia primaria: [Chrome network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests).

## Rate limits

Ventanas de 60 segundos. Todos los defaults son configurables mediante enteros positivos de 1 a 100000; configuracion invalida falla al arrancar, no deshabilita silenciosamente la defensa.

| Variable | Default | Identidad y alcance |
| --- | --- | --- |
| ZENTRA_RATE_AUTH_IP | 240 | req.ip, antes de Auth; Map por proceso existente |
| ZENTRA_RATE_USER_LOCAL | 120 | ID verificado, Map por proceso existente; defensa complementaria global local |
| ZENTRA_RATE_PUBLIC_IP | 120 | IP para rutas desconocidas/preflight, por proceso |
| ZENTRA_RATE_HEALTH_IP | 600 | IP health, por proceso |
| ZENTRA_RATE_WEBHOOK_IP | 600 | IP webhook, por proceso; permite reintentos normales |
| ZENTRA_RATE_GENERATION_USER | 60 | ID verificado + generation, PostgreSQL compartido |
| ZENTRA_RATE_AUDIO_USER | 12 | ID verificado + audio, PostgreSQL compartido; no habilita gate |
| ZENTRA_RATE_SEARCH_USER | 30 | ID verificado + search, PostgreSQL compartido |
| ZENTRA_RATE_AUDIT_USER | 120 | ID verificado + audit, PostgreSQL compartido |
| ZENTRA_RATE_CONSUME_USER | 60 | ID verificado + consume, PostgreSQL compartido |
| ZENTRA_RATE_READ_USER | 180 | ID verificado + read, PostgreSQL compartido |

El limite local combinado de 120/usuario tambien aplica: el default read 180 no elimina ese techo complementario por proceso. Son defensas diferentes, no unidades del plan. No se modificaron precios ni cuotas Free/pagas. Polling y retries HTTP cuentan como requests; las fases internas, renovaciones de lease y recuperacion JSON interna no generan un nuevo HTTP count.

La cadena efectiva es headers/defensa anonima -> CORS -> defensa IP/auth/usuario local -> rate persistente -> parse body -> reserva existente -> handler/proveedor. 429 usa Retry-After; no crea recibo/reserva ni invoca proveedor/crawl/search. Si la RPC de rate falla o falta, devuelve 503 rate_limit_unavailable antes del consumo; no expone el error SQL. No hay fallback de la defensa distribuida a una Map.

La reserva economica sigue independiente. Un bloqueo HTTP no reintegra una respuesta util previa ni altera ownership. Audit reserve/release comparten un bucket amplio, y se preserva la recuperacion existente; un release que no alcance el backend queda sujeto a la expiracion segura previamente validada.

## Persistencia y migracion

Nueva supabase-http-rate.sql, independiente de las migraciones de concurrencia. Tabla zentra_http_rate_buckets: subject text, category con CHECK de seis valores, count integer no negativo default 0, expires_at timestamptz obligatorio y PK(subject,category). La PK es tambien el indice unico. Una fila por usuario/categoria, no una fila por request/ventana. UPSERT bloquea esa fila y cuenta/reset atomicos; usuarios diferentes no comparten lock. La cuenta se satura en maximo+1 tras el rechazo.

RPC zentra_http_rate_limit accesible exclusivamente con service_role. RLS habilitada; PUBLIC/anon/authenticated sin lectura, escritura ni EXECUTE. El subject y maximo proceden del backend, no de los parametros del cliente. Aplicada dos veces SOLO a PostgreSQL efimero local.

No altera filas existentes de users/receipts/requests. El backend viejo ignora esta tabla: la migracion puede aplicarse primero en staging, seguida del backend nuevo. El nuevo necesita la RPC; omitirla produce 503 en rutas autenticadas. No reconstruir ni desplegar el server.js sucio completo sin revisar sus pendientes anteriores. Lock de fila por usuario/categoria en uso; DDL sobre objetos nuevos. Retirar la tabla/RPC revierte esta defensa, elimina contadores HTTP temporales y requiere retirar primero el middleware; no devuelve ni modifica cuotas. No se ejecuto esa retirada.

## Proxy y trafico anonimo

ZENTRA_TRUSTED_PROXY_CIDRS acepta exclusivamente IPs/CIDRs explicitos; rechaza true, numero de hops, /0 y CIDRs invalidos. Default trust proxy=false. X-Forwarded-For directo no es identidad fiable. No se inferio una cadena de Render ni se inventaron sus rangos. Referencia primaria: [Express behind proxies](https://expressjs.com/en/guide/behind-proxies.html).

Antes de produccion hay que verificar la topologia/rangos de proxies y que el ultimo proxy quite/sobrescriba headers falsificables. Con trust proxy=false Render podria agrupar usuarios bajo la IP del proxy y causar falsos 429 locales. No activar true ni subir limites para ocultarlo.

Health/webhook/anonimos/prechallenge de Auth siguen protegidos solo por proceso. No se afirma rate limit distribuido anonimo ni defensa DDoS global. La defensa de usuarios verificados SI usa PostgreSQL compartido. Para abuso volumetrico o Auth externo se requiere proteccion de borde/limites propios de Supabase; no se agrego Redis ni se abrio una nueva arquitectura.

## Metadata headers y errores

/api/health y su alias /health devuelven exclusivamente {ok:true}, sin timestamp/service/model/provider/routing/config. Es liveness, no una afirmacion de que DB o IA estan operativas. X-Powered-By ya estaba desactivado y se conserva; se agrega nosniff y no-store a respuestas, errores y streaming. No se altero CSP de Chrome ni se agregaron headers decorativos.

Se conserva el saneamiento previo de JSON/stream que quita proveedor/modelo/routing. Los contratos de consumo propio y audit_consultative se preservan; no se borran diagnosticos necesarios de recovery. Error 400/413/500 y 404 quedan en JSON controlado, sin stack/path/SQL/payload de proveedor. No se refactorizaron logs ni el webhook; la firma real previa pasa su regresion intacta. No se registran secrets nuevos, tokens, texto privado ni parametros sensibles en esta defensa.

## Archivos de esta pasada

Base de producto: /Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/zentra-backend.

- server.js: wiring antes de parse/reserva, proxy/headers, health minimo y 404/error boundary.
- release-security.js: validacion CORS configurable y configuracion de los dos limites locales existentes.
- Nuevo release-http-boundary.js: limites diferenciados, RPC persistente, headers, proxy y handlers minimos.
- Nueva supabase-http-rate.sql: tabla/RPC independientes.

QA en /Users/cristiangatica/Documents/Codex/2026-06-29/po/outputs/release-test-runtime: nuevo http-boundary.test.mjs; quota-multiprocess-worker.mjs admite el guard HTTP solo en su modo de prueba opcional; quota-multiprocess.test.mjs agrega el escenario distribuido. http-validation.json e informe actual como resultados. No se cambiaron las migraciones de concurrencia ni archivos de Chrome/Audit/Desktop, PDF/UI/SEO/Schema/Legal/resume. Contra los hashes de la pasada anterior: 34 archivos iguales; solo server.js y release-security.js cambiaron entre los archivos existentes medidos.

## Pruebas locales

- HTTP boundary: 15 grupos aprobados. CORS A-E/K, auth F/G/I/O, 429 antes de reserva/proveedor H, rutas publicas J, health L/M, errores N, proxy, RPC privadas, migracion repetible, 20 solicitudes/10 admisiones y expiracion de ventana.
- Multiproceso: 29 grupos aprobados. Los 28 anteriores mas dos procesos Node con el nuevo guard, 20 requests/10 admisiones: exactamente 10 proveedores/debitos; los 10 rechazados no tienen receipts ni requests.
- Cuotas: 53 grupos aprobados, incluidos streaming/refund/concurrencia/Audit/competitive search y recuperacion JSON.
- Backend auth boundaries: 14 grupos aprobados; firma Lemon intacta y errores de transporte sin regeneracion incierta.
- Refinements/OCR: 11 salidas aprobadas; prompts, multiples imagenes y consumo preservados.
- Fases Audit: 21 salidas aprobadas.
- JSON recovery: 23 checks consultivos + 6 parser/presupuesto aprobados.
- Audio gate: 6 grupos aprobados, false por defecto, cero proveedor/consumo con gate apagado.
- Resume/PDF_READY: 9 escenarios aprobados; descarga: 9 escenarios aprobados.
- Chat structured response: aprobado; competitive search backend: 9 tests aprobados.
- Servidor real localhost sin claves: /health y /api/health ok minimo; auth rechaza chat antes de parse/consumo.
- Sintaxis: 68 JS aprobados, backend 13 / clean 22 / Lab 23 / Audit 10. git diff --check aprobado.

PostgreSQL/SQL/RPC y procesos fueron reales LOCALES; Auth y proveedores simulados. No se uso Supabase real, Render ni IA facturable. Dos corridas se interrumpieron al cargar jsdom desde la carpeta de trabajo; se reejecutaron con el runtime temporal existente y pasaron. Los errores iniciales del fixture PG y el nombre de variable SQL fueron corregidos antes del resultado final.

No se tocaron ni actualizaron baselines visuales; UI intacta. No se atribuyen pruebas visuales nuevas a esta pasada.

## Pendientes para staging

Confirmar Auth/PostgREST y RPC/permisos reales, origen enviado por Chrome, IDs reales, allowlist de webs consumidoras, proxy Render, latencia de una RPC por request, limites bajo polling/refinements/retries reales y volumen de webhook compartido. Los defaults son conservadores, no limites perfectos basados en telemetria que no tenemos. Ventanas fijas permiten un burst en su borde; no se afirma sliding window ni control de concurrencia de sockets.

No dar la defensa anonima por global ni confundir CORS con auth. No publicar hasta aplicar/verificar la migracion y configurar Origins/proxy en el entorno correcto. Produccion permanece intacta, sin push/deploy/packaging.
