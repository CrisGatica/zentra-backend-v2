# Validacion local del scope de URLs de Audit

Fecha: 2026-09-30. Se endurecio la aceptacion de evidencia y la vinculacion con el target reservado. No se certifica la procedencia del crawl ejecutado por Chrome ni su seguridad de DNS/redirecciones antes de abrir URLs. Por estos limites no se declara AUDIT URL SCOPE = CERRADO LOCALMENTE en todo el alcance solicitado.

## Flujo real

1. Chrome toma la URL activa y solicita /api/audit/reserve con la operacion. Auth y zentra_access determinan identidad/plan; zentra_acquire_audit reserva atomicamente antes de la lectura del sitio. El target se guarda en zentra_audit_acquisitions.source.
2. Chrome recoge la pagina principal. Sus enlaces descubiertos y su seleccion manual son sugerencias del cliente, no una lista descubierta por el backend.
3. resolveAuditScope utiliza el entitlement de reserva. fetchInternalPagesContext aplica seleccion editorial y maxPages; background.js recoge HTML o lectura renderizada. La politica actual de Chrome usa origen exacto y no abre otros subdominios como paginas internas. El pool de candidatos puede ser mayor que el conjunto que se lee.
4. Chrome envia pageData, internalPagesResult y freePreviewPagesResult como evidencia ya recogida. Los URLs de enlaces/canonical/imagenes contenidos en una pagina no son por si mismos paginas adicionales de crawl autorizadas.
5. El backend valida el scope, sus paginas, URLs solicitadas/finales y registros de adquisicion. Para una nueva raiz consultiva comprueba el target contra la reserva almacenada del mismo usuario/producto/operacion. Reconstruye el prompt con trusted-audit-builders, no vuelve a leer el sitio.
6. zentra_begin_request conserva handoff, reserva, lease y replay existentes. IA, recovery y fases posteriores usan el contexto congelado. La busqueda competitiva tiene su guard propio de operacion completada y consultas reconstruidas; sus candidatos son sitios externos por definicion y no se incluyen como paginas internas del dominio.

La seleccion final aceptada por el backend es autoritativa para sus generaciones, no para certificar que un navegador modificado hizo realmente el crawl indicado. El backend no tiene un lector independiente de estos URLs ni una lista descubierta por el mismo.

## Validacion implementada

- Target HTTP(S) absoluto, longitud maxima 2048, sin credenciales, espacios/control ni barras invertidas.
- Rechazo de localhost, nombres internos evidentes, IPs loopback, privadas, link-local/metadata, shared-address, multicast y rangos no aptos. URL convierte las formas IPv4 numericas/hexadecimales antes de comprobarlas; node:net BlockList cubre tambien direcciones privadas mapeadas IPv6.
- Cada requestedUrl y URL final de pagina debe conservar host de sitio y puerto no estandar. No se aceptan otros dominios, subdominios funcionales ni sufijos fraudulentos. www y protocolos HTTP/HTTPS se comparan como alias de identidad; no se habilita crawl nuevo de subdominios en Chrome. Su filtro de origen permanece intacto.
- Identidad equivalente: host casing, www, puertos predeterminados, fragmentos, trailing slash y parametros utm/gclid/fbclid. Se preservan mayusculas del path, queries funcionales, valores/orden de query y puertos no estandar. No se usa el campo domain del cliente como autoridad; si existe debe coincidir con el hostname del target.
- Duplicados equivalentes de requestedUrl dentro de una lista se rechazan, no se recortan ni procesan dos veces. Preview Free puede describir las mismas URLs que la lectura completa, no ampliar el conjunto.
- Redirecciones declaradas dentro del sitio pueden conservar requestedUrl distinto del destino; por ejemplo /inicio hacia /. Los destinos finales ajenos se rechazan. Esto valida evidencia declarada, no prueba la cadena real de redirecciones.
- Los attempts/errors que identifican URLs deben corresponder al conjunto de paginas enviado; attempts no puede exceder el limite interno. No se autoriza una URL adicional escondiendola en esos registros.
- Free 3, Starter 5, Pro 7, Agency 11 incluyen la principal. Una lista excesiva se rechaza completa antes de IA (cero paginas procesadas por el proveedor), no se recorta mientras mantiene un prompt con evidencia adicional. La solicitud menor en auditScope se respeta y no se rellena.
- Una nueva raiz sin reserva previa o con otro target se rechaza antes de registrar el step/proveedor. El operation.source enviado por Chrome no sustituye el valor de DB.

## Limites y decisiones pendientes

No hay un fetch del target de Audit en el backend actual; sus fetch son a endpoints de proveedores. Por ello esta validacion no genera una peticion SSRF del servidor hacia el target. Sin embargo, el rechazo sintactico de IPs NO es una comprobacion DNS: un hostname publico puede resolver a una IP privada, y Chrome sigue realizando la lectura y siguiendo redirecciones antes de enviar evidencia. La comprobacion actual del destino final de Chrome ocurre despues de fetch, no impide una peticion inicial a un destino de red no permitido. No se oculta esta limitacion con una prueba de strings.

Una build modificada puede hacer lecturas propias fuera de los limites y mentir sobre su evidencia; esta pasada impide que esa lista declarada se acepte sin validacion y reserva para IA, no controla todo el trabajo de red de ese navegador. Tampoco certifica que el contenido enviado pertenezca realmente a la URL declarada.

El numero menor solicitado en la reserva se devuelve a Chrome pero no esta almacenado en la tabla de adquisicion. La validacion protege el maximo del plan y el scope menor presentado; no certifica que un cliente manipulado no amplie una solicitud anterior menor dentro del maximo comercial. No se modifico el esquema de adquisicion para ocultar esta distincion.

Manual/automatico: existe allowsManualSelection=false en Starter y true en Free/Pro/Agency. Se reporto antes de editar y se preservo. Ambas modalidades pasan la misma validacion de URLs; una bandera manualSelectionUsed no prueba la procedencia. No se inventa un entitlement nuevo ni se declara protegida server-side esa diferencia. Para certificar seleccion automatica habria que tener descubrimiento/seleccion confiables en servidor o aceptar expresamente que es un control UX de cliente.

Los steps Audit ya congelados conservan replay/resume existentes; esta pasada no migra ni recertifica retrospectivamente toda evidencia historica. No se reabre el cutover del chat.

PDF BRANDING = gate de cliente aceptado para este lanzamiento. Starter conserva Zentra; Pro/Agency permiten personalizacion/sin branding. Una build Chrome modificada podria omitir el gate visual. Hardening adicional requeriria mover/finalizar el artefacto en servidor y queda fuera del alcance actual. Ningun PDF fue editado.

## Archivos modificados

Producto, bajo /Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/zentra-backend:

- release-audit-urls.js: helper central nuevo exclusivo de validacion Audit; sin fetch/DNS/proveedores. Los helpers existentes de normalizacion SEO descartan toda query y viven en codigo browser/VM; no se trasladaron ni se cambiaron porque no son una frontera de seguridad de red. El filtro competitivo existente no se modifico ni se creo otro crawler.
- release-entitlements.js: delega validacion de URLs en el helper, sin cambiar matriz, precios ni politica de planes.
- release-audit-acquisition.js: valida el target antes de permitir la reserva; sin cambiar RPC/consumo/lease.
- release-audit-steps.js: nueva raiz vinculada al acquisitionSource autenticado almacenado.
- supabase-release-guard.sql: SOLO zentra_read_audit_steps incorpora acquisitionSource por usuario/operacion en su resultado. Sin cambios en tablas, funciones de consumo, concurrencia ni fencing en esta pasada.

QA, bajo /Users/cristiangatica/Documents/Codex/2026-06-29/po/outputs/release-test-runtime:

- audit-url-scope.test.mjs: 11 grupos nuevos de URLs/scope/reserva.
- quota.test.mjs: casos nuevos de sustitucion de target reservado con PostgreSQL real; fixtures Audit ahora hacen adquisicion previa y handoff como Chrome.
- quota-multiprocess.test.mjs: fixtures antiguas de Audit ahora reservan antes de generar; mantienen aserciones de ultimo cupo/proveedor unico.
- plan-entitlements.test.mjs y commercial-gates.test.mjs: fixtures de contexto incorporan su URL principal, ahora requerida.
- validate-sources.mjs: incluye hashes del helper y release-entitlements.
- audit-url-scope-validation.json y este informe: evidencia local de validacion.

## Pruebas y regresiones

- Scope: 11 grupos pasan, incluyendo A-M, listas excesivas rechazadas sin procesamiento, queries funcionales distintas, IPv4 alternativa, IPv6, preview, redirecciones declaradas y vinculacion al target reservado.
- Quotas/HTTP/DB: 65 grupos pasan (63 anteriores y dos nuevos de target con DB real). Recovery conserva un retry, replay sin segundo consumo ni segundo crawl.
- Multiproceso/DB: 29 grupos pasan. Ultimo cupo de Audit, ganadora unica, perdedora cero crawl/read/IA/search en el generador Chrome real con proveedor simulado; fencing, heartbeat y resultado incierto intactos.
- Planes/entitlements: 23 grupos pasan; requests menores y 3/5/7/11 sin cambio.
- HTTP boundary: 15 comprobaciones pasan.
- Fases Audit: suite completa pasa, prompts/opciones originales iguales para los cuatro planes, multipagina y evidencia competitiva.
- JSON recovery: 23 comprobaciones consultivas y 6 de backend/budget pasan.
- Resume/PDF_READY: 9 escenarios pasan. Descarga/progreso: 9 escenarios pasan.
- Inventario comercial: 3 comprobaciones pasan y preservan la limitacion de procedencia/manual y branding local.
- Sintaxis: 70 archivos, cero errores. git diff --check limpio.

Las pruebas detectaron durante el desarrollo una interaccion de BlockList con una subred IPv6 mapeada demasiado amplia: se corrigio y se verifico admision de IPs publicas IPv4/IPv6 y rechazo de privadas. Los fixtures antiguos de generacion directa se actualizaron al protocolo real; no se relajo el rechazo sin reserva. Un test nuevo de liberacion necesitaba el lease existente; se corrigio el fixture, no la logica del producto. Todas las suites finales indicadas pasan.

Hashes frente a cutover-validation.json: entre archivos previamente inventariados solo cambiaron release-audit-steps.js, release-audit-acquisition.js y supabase-release-guard.sql. El nuevo inventario agrega release-entitlements.js y release-audit-urls.js. Chrome/Lab/Audit, PDF, chat, builders, UI, animaciones, server.js, concurrencia/operations, auth, CORS, rate, facturacion y Desktop quedaron intactos en esta pasada. Se preservo el worktree sucio anterior.

## Condiciones antes de desplegar

No hubo push, deploy, empaquetado ni publicacion. No se hicieron llamadas reales a proveedores/Render/Supabase. Auth y proveedores simulados; PostgreSQL local real y efimero.

El nuevo backend requiere la version actualizada de zentra_read_audit_steps y la tabla de adquisicion existente. Con la funcion antigua no recibe acquisitionSource y falla cerrado para nuevas raices. No desplegar solo JS omitiendo esa actualizacion SQL. No ejecutar de golpe la migracion local completa con otros pendientes: aislar la funcion de lectura en una futura pasada de despliegue autorizada.

La validacion de evidencia server-side esta probada localmente. La certificacion total solicitada sigue pendiente por procedencia/crawl de cliente, DNS/redirecciones y la decision comercial de seleccion manual. Cerrar esos limites requeriria otro alcance o una aceptacion explicita de esa frontera de confianza; no se asumio dicha aceptacion.
