# Seguridad del crawl de Audit en Chrome

Fecha: 2026-09-30. Continuacion de audit-url-scope-report.md. Esta pasada endurece LOCALMENTE el lector de Chrome clean y Audit, sin modificar el backend ni ejecutar migraciones. El scope de evidencia y la reserva del backend siguen siendo autoritativos. No hay certificacion completa de seguridad de red: DNS y la navegacion de pestanas auxiliares conservan riesgos que se explican abajo.

## 1. Flujo real

1. claude-pdf-generator.js, generateAIReport, toma lockedPageData.url o chrome.tabs.get(tabId).url.
2. zentra-api-client.js, reserveAudit, autentica y espera /api/audit/reserve. El servidor devuelve lease y entitlement. Antes de esa confirmacion no se habilita el lector de Audit.
3. El transporte registra beginAuditCrawl en el service worker con auditId, sitio y profundidad confirmada. Solo se admite el popup propio de la extension, no mensajes de content scripts.
4. collectPageData recoge el DOM existente mediante content.js. readAuditPrimaryPage confirma la lectura tecnica en la pestana del usuario mediante chrome.scripting; no abre una pagina nueva para la principal.
5. content.js, extractInternalLinkCandidates, descubre anchors; claude-integration.js, resolveAuditScope/fetchInternalPagesContext, selecciona las paginas automaticas o manuales y limita la lista antes de pedir su lectura.
6. background.js aplica una misma validacion de URL y la vinculacion a la sesion reservada. Para internas hace fetch de HTML. Solo un HTML permitido e insuficiente puede acudir a una pestana auxiliar y lectura renderizada.
7. El worker devuelve paginas/attempts/errors en el formato existente. El preview Free reutiliza las mismas lecturas completas, no vuelve a descargar esas paginas.
8. Chrome envia pageData/internalPagesResult/freePreviewPagesResult en zentra_audit_workflow. El backend valida URLs/scope contra la reserva autenticada y congela la evidencia; no descarga de nuevo esas URLs. IA/recovery/fases siguen sin cambios.

## 2. Fuentes de URLs y procedencia

| Fuente actual | Validacion y normalizacion | Descarga o lectura | Manipulable |
| --- | --- | --- | --- |
| URL principal activa o bloqueada | Backend antes de reserva; helper del worker antes de lectura | DOM de la pestana actual | El usuario puede navegar; la pagina puede redirigir. Se comprueba la URL actual y el origen dentro del script antes de extraer DOM. |
| Anchors a[href] | content.js conserva origen exacto y deduplica; el worker vuelve a validar | fetch de las seleccionadas, no de todo el pool | El DOM y los enlaces generados por JS son no confiables. |
| Seleccion automatica | claude-integration.js selecciona sobre el pool; worker aplica origen/capacidad/limite | Mismo lector | La pagina puede alterar los candidatos/textos, no ampliar el origen admitido. |
| Seleccion manual | Normalizador de seleccion existente y mismo gate del worker | Mismo lector | El usuario/cliente puede alterar la seleccion; el flag manual no constituye prueba server-side de procedencia. |
| Navegacion efectiva de pagina seleccionada | Comprobacion de origen antes y dentro de la extraccion, y al recibir el resultado | Pestana auxiliar solo despues de prelectura HTML permitida | JS/meta refresh/redirecciones pueden provocar conexiones del navegador antes de detectar una salida de scope. |

No se encontro adquisicion por sitemap; no se anadio. Canonical, meta refresh, URLs de scripts e imagenes NO se convierten en nuevas paginas de crawl por contener una URL. Un anchor insertado por JS debe pasar el mismo filtro que cualquier otro anchor. Los recursos que el navegador carga al navegar tienen una frontera diferente, descrita en las limitaciones.

Esta es procedencia trazada en el codigo de la extension confiable, NO una certificacion criptografica de que la evidencia declarada fue observada realmente. Una build modificada puede mentir sobre datos o realizar su propia red; no se afirma controlar todo ese navegador.

## 3. Validacion anterior al request

normalizeFetchedUrl se reutiliza tanto para registro/target como para candidatas, fetch, pestanas y URL efectiva. Rechaza antes de esos requests iniciados por Audit: URL no absoluta/no string, mas de 2048 caracteres, espacios/control/barra invertida, esquemas distintos de HTTP(S), usuario/password embebidos, host local evidente y origen ajeno a la sesion.

El origen declarado por el request no reemplaza al registrado: debe coincidir con session.origin. Los mensajes del worker se aceptan solo desde popup.html del runtime propio, sin sender.tab. documentId vincula el documento cuando Chrome lo proporciona; en su ausencia se usa la URL del popup, una vinculacion menos fina conservada como compatibilidad.

La pagina principal debe coincidir con el target reservado antes de su lectura tecnica. La pagina que el usuario ya tenia abierta puede haber hecho red previamente por su propia navegacion; esa red previa no es un request nuevo de Audit ni queda controlada por este gate.

## 4. Politica de sitio

Chrome conserva ORIGEN EXACTO: mismo protocolo, hostname y puerto. www, otro subdominio, HTTP frente a HTTPS y otro puerto no son autorizaciones nuevas de crawl. No se amplio la politica a eTLD+1 ni a sitios relacionados.

Se conserva la semantica de URL SEO existente en Chrome: URL normaliza casing de host/puertos por defecto; se quitan fragmentos, toda query y trailing slash. content.js sigue convirtiendo /home a /. No se cambio este tratamiento para redefinir recursos SEO. El backend conserva su politica previa de aliases www/HTTP/HTTPS y query funcional; el lector Chrome es mas estricto en origen.

## 5. Destinos locales y privados

El helper previo al request cubre localhost y sufijos locales evidentes, incluida home.arpa; IPv4 0/8, 10/8, 127/8, RFC1918, 100.64/10, 169.254/16, 192.0.0/24, 198.18/15 y multicast/reservadas altas; IPv6 unspecified/loopback/compatible, ULA, link-local, site-local y multicast. IPv4 mapeada en IPv6 se comprueba como IPv4.

WHATWG URL normaliza las variantes numericas/hexadecimales IPv4 antes de comprobar el host. Se prueban 2130706433 y 0x7f000001, metadata.google.internal, 169.254.169.254 y sufijos locales. IPs publicas IPv4/IPv6 siguen admitidas; no se rechaza todo 192.0/16 por confundirlo con 192.0.0/24.

Es una proteccion de destinos EXPLICITOS. No inspecciona lo que un hostname publico finalmente resuelve.

## 6. Redirecciones

Antes, fetch seguia redirects y solo luego se revisaba response.url. Ahora usa redirect:manual y credentials:omit. Una respuesta opaqueredirect, 3xx o marcada redirected detiene la lectura; no se lee el body ni se abre una pestana de respaldo. Un response.url inesperado tambien se rechaza antes del body, sin afirmar que eso evita una conexion que ya hubiese ocurrido.

Fetch manual oculta Location/status/body mediante la respuesta opaca: no se inventa el destino ni se sigue una cadena que no se pueda verificar. La politica es detenerse en el PRIMER salto, incluso si era un alias legitimo del mismo sitio. Esto es una decision conservadora con coste de compatibilidad, no un seguidor de redirects validados. [Fetch Standard](https://fetch.spec.whatwg.org/)

La prueba simula rutas hacia otro dominio, localhost, RFC1918 y una cadena interna que acabaria en metadata; solo se solicita el primer URL. Son pruebas del codigo real con fetch/navegador simulados, no una captura de trafico de Chrome real.

Una pestana auxiliar aun puede redirigir por HTTP/JS/meta refresh despues de la prelectura. Se rechaza extraccion fuera del origen y se cierra la pestana propia; el chequeo dentro del script evita leer el DOM si hubo una carrera entre tabs.get e inyeccion. Eso NO previene toda conexion anterior del navegador.

## 7. Garantia sobre DNS rebinding

NO resuelto. Un nombre sintacticamente publico puede resolver o volver a resolver hacia red privada. fetch/tabs no estan vinculados a una IP previamente validada por Zentra.

Chrome documenta dns.resolve para el canal Dev, no como API de Chrome Stable. Incluso una consulta previa separada no fija la IP de la conexion posterior y conserva una carrera TOCTOU. No se anadio ese permiso/API. [Chrome DNS](https://developer.chrome.com/docs/extensions/reference/api/dns)

webRequest requeriria permisos ausentes; su campo ip describe la IP a la que el request ya fue enviado, no ofrece aqui una comprobacion/pinning antes de conectar. No se uso como falsa solucion preventiva. [Chrome webRequest](https://developer.chrome.com/docs/extensions/reference/api/webRequest)

## 8. Lo que Chrome no certifica

- IP efectiva publica antes de cada conexion o ausencia de rebinding.
- Cero requests privados/externos provocados por JS, recursos, frames o navegacion de una pestana auxiliar. Una prelectura correcta no inmoviliza su futura navegacion.
- Correspondencia autentica entre cuerpo declarado y URL si el usuario modifica la extension.
- Aviso instantaneo de una invalidacion backend desconocida al worker: se corta al cerrar/reemplazar localmente, expirar sesion o recibir rechazo confirmado en heartbeat; una perdida de transporte no se equipara a revocacion.
- Persistencia indefinida del cache tras reiniciar/recargar Chrome o la extension, ni cero relecturas tras expiracion/desalojo.

## 9. Permisos

manifest.json NO CAMBIO. host_permissions y content_scripts.matches siguen con <all_urls>; permisos activeTab, tabs, storage, scripting y downloads. No se anadieron dns, webRequest, declarativeNetRequest ni unlimitedStorage.

Audit utiliza acceso a sitios arbitrarios para fetch de internas y scripting sobre pestanas auxiliares; activeTab por si solo no reemplaza esos accesos. Chat/contexto y adaptadores actuales leen paginas arbitrarias del usuario. OCR utiliza capturaVisibleTab con permisos activos/tabs y procesamiento de la captura; no exige por si mismo crawling arbitrario. downloads se conserva para PDF y storage para estados. No se redujeron permisos a ciegas; el cierre de permisos Chrome Store sigue fuera de este bloque.

## 10. Reserva anterior al crawl

generateAIReport ya esperaba reserveAudit antes de collectPageData. Ahora tambien debe completar el registro en el worker antes de continuar. Sin auth/reserva/entitlement valido, o si falla el almacenamiento del registro, no se abre una capacidad utilizable de crawl. El backend mantiene su RPC/reserva/lease existentes.

Las pruebas con el generador y transporte reales frente a dos procesos backend independientes y PostgreSQL local confirman: ultimo cupo, una ganadora; la perdedora realiza cero crawl/lectura/IA/busqueda. Los componentes de navegador/proveedor son simulados, no se usaron servicios reales.

## 11. Limites efectivos

Se toma totalPages del entitlement confirmado; no se duplico la matriz comercial en el worker. Un limite defensivo de formato <=11 protege su descriptor, no decide el plan. Free/Starter/Pro/Agency mantienen 3/5/7/11 incluyendo la principal.

El worker deduplica y recorta ANTES de leer. Con un pool de 30 candidatos las pruebas adquieren solo 2/4/6/10 internas y la principal, respectivamente. Cada sesion conserva su conjunto de URLs visitadas para no ampliar el presupuesto mediante lotes sucesivos. Las lecturas completas duplicadas/preview comparten cache; adquisiciones simultaneas de la misma URL comparten una promesa.

Estos son limites de PAGINAS seleccionadas, no de paquetes ni de todo el trafico del navegador: una SPA puede requerir fetch y navegacion para la misma pagina; sus recursos no equivalen a paginas adicionales auditadas. Las lecturas incompletas pueden reintentarse segun el flujo existente, no se garantiza una sola conexion fisica por URL fallida.

## 12. Audit ID, sitio y resume

La sesion vincula auditId, fuente, origen, profundidad y documento del popup. Otro ID/origen/documento sin registro confirmado no puede usarla. Reemplazar o finalizar la sesion desactiva y aborta sus fetch pendientes; se comprueba estado antes de leer y de entregar resultados.

Al reabrir, el mismo ID/sitio solo recupera capacidad mediante nueva reserva confirmada y reutiliza evidencia completa disponible. Un ID nuevo no hereda evidencia del anterior. No se cambiaron el guardado del job, el resume del chat ni la distincion RUNNING/PDF_READY/COMPLETED. PDF_READY y COMPLETED no se retoman por abrir/cerrar el popup.

El cache se guarda solo en chrome.storage.session, sin guardar tokens de autenticacion del transporte ni sus headers. Contiene la evidencia del sitio leida por Audit. Se limita a 15 minutos, 32 registros, 4 MiB serializados y 256 KiB por pagina cacheable. El resultado enviado al analisis NO se recorta por este limite. Se desaloja evidencia, no el presupuesto de URLs de sesiones retenidas; tras desalojo/expiracion puede haber relectura. Chrome limpia storage.session al recargar/deshabilitar/actualizar la extension o reiniciar el navegador; por defecto no esta expuesto a content scripts. [Chrome storage](https://developer.chrome.com/docs/extensions/reference/api/storage)

El backend sigue rechazando evidencia declarada ajena al sitio/audit autenticado. No se cambian los limites previamente documentados: la solicitud menor de profundidad no queda persistida como cap server-side independiente; procedencia manual/automatica y veracidad del contenido no estan atestadas por servidor.

## 13. Archivos modificados

Producto: unicamente estos seis archivos, bajo /Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES:

- publicacion/chrome-store/zentra-ai-chrome-store-clean/audit-crawl-security.js: nuevo guard y cache de adquisicion exclusivo de Audit.
- publicacion/chrome-store/zentra-ai-chrome-store-clean/background.js: gate comun, URLs locales, fetch manual y lectura renderizada limitada.
- publicacion/chrome-store/zentra-ai-chrome-store-clean/zentra-api-client.js: registrar la capacidad tras reservar; terminarla ante rechazo confirmado o end Audit.
- ZENTRA AUDIT/ZENTRA_AUDIT_v1.0.0/audit-crawl-security.js: mismo guard.
- ZENTRA AUDIT/ZENTRA_AUDIT_v1.0.0/background.js: mismo lector endurecido.
- ZENTRA AUDIT/ZENTRA_AUDIT_v1.0.0/zentra-api-client.js: mismo transporte.

QA/documentacion, bajo /Users/cristiangatica/Documents/Codex/2026-06-29/po/outputs/release-test-runtime:

- audit-crawl-fixtures.mjs: nuevo entorno simulado del worker real y storage.session.
- audit-chrome-crawl.test.mjs: nuevos tests de frontera de red y lifecycle.
- audit-evidence.test.mjs: utiliza la nueva sesion en fixtures del lector existente; conserva las 22 aserciones de evidencia.
- audit-schema.test.mjs: stub importScripts en VM; 14 aserciones existentes sin cambiar Schema de producto.
- plan-entitlements.test.mjs: stub del registro runtime; mismos limites y 23 grupos.
- quota-multiprocess.test.mjs: no contabiliza begin/end del guard como lecturas; mantiene la comprobacion de cero trabajo en la perdedora.
- validate-sources.mjs: modo explicito ZENTRA_CHROME_CRAWL_ONLY con verificacion estricta del baseline protegido, no excepcion general.
- chrome-audit-crawl-validation.json: hashes y sintaxis de esta pasada.
- chrome-audit-crawl-report.md: este informe.

Lab se sincronizo temporalmente durante el desarrollo, pero se detecto que su puente Desktop llama directamente al lector. Esa sincronizacion se retiro mediante patches: sus hashes finales coinciden con audit-url-scope-validation.json. NO se desactivo ese puente ni se cambio Desktop para acomodar el nuevo guard. Backend y todos los archivos inventariados de PDF/chat/UI/analisis/planes permanecen iguales al snapshot anterior.

## 14. Pruebas nuevas

23 grupos de crawl pasan. Cobertura solicitada:

| Casos | Resultado y prueba |
| --- | --- |
| A-J | Anchors validos aceptados; externos, localhost, IPv4/IPv6 privadas, link-local, esquemas y credenciales: cero requests a esos candidatos. DOM real simulado por JSDOM mas worker real en VM. |
| K-M | Redirect externo/privado/cadena: manual detiene primer salto; no body ni fallback de pestana. Navegacion efectiva fuera del origen y carrera de inyeccion: sin extraccion de DOM ajeno. |
| N | Duplicados normalizados, preview y lectores concurrentes: una adquisicion completa compartida. |
| O-R | 3/5/7/11 paginas; pool de 30 no se descarga entero ni se amplian paginas con otro lote. |
| S | Reserva denegada: cero registro de lector; sin registro, cero fetch/lectura. |
| T | Suite multiproceso con generador/transporte reales y DB local: perdedora del ultimo cupo, cero crawl/read/IA/search. |
| U | Scope y cuotas con DB: sustitucion de sitio reservado, ID ajeno y evidencia externa rechazados; worker bloquea cross-ID/origen/documento. |
| V | Mismo ID registrado de nuevo tras reiniciar el worker simulado: pagina completa cacheada sin fetch; ID nuevo no reutiliza. |

Adicionales: CSP/network failure no navega como respaldo; SPA same-origin conserva recuperacion incluso pasando transitoriamente por about:blank sin extraer ese documento; tabs propias se cierran; end durante fetch aborta y no publica; almacenamiento inaccesible falla cerrado; cache acotado devuelve evidencia grande intacta y conserva presupuesto cuando desaloja paginas.

## 15. Regresiones

- Crawl: 23 grupos, cero fallos finales.
- Evidencia multipagina: 22, cero fallos.
- Schema existente: 14, cero fallos; sin cambiar su captura/clasificacion.
- Scope URL/backend: 11, cero fallos.
- Fases Audit: suite completa pasa para cuatro planes, prompts/opciones iguales, multipagina y fallback social.
- Planes/entitlements: 23, cero fallos; 3/5/7/11 y precios intactos.
- Consumo/reserva/HTTP/DB: 65, cero fallos; recovery un retry/replay sin doble consumo.
- Multiproceso/DB: 29, cero fallos; ultimo cupo, fencing, heartbeat real de 30 segundos, handoff y resultado incierto intactos.
- JSON recovery: 23 consultivas + 6 parser/budget, cero fallos.
- RUNNING/resume/PDF_READY: 9, cero fallos.
- Descarga/progreso: 9, cero fallos.
- HTTP boundary: 15, cero fallos.
- Sintaxis: 72 archivos de producto, cero fallos; git diff --check limpio en backend.

Auth/proveedores/fetch/tabs simulados; PostgreSQL local real y efimero. No se hicieron llamadas a IA real, Render, Supabase real ni sitios auditados. No se realizo staging, prueba visual de PDF ni prueba manual Chrome en esta pasada; no eran requeridas. Los ajustes de fixtures adaptan la nueva interfaz del worker, no eliminan los casos de cuotas/resume/evidencia.

Durante la implementacion, una sincronizacion de Lab hubiese afectado Desktop; fue retirada y verificada por hashes. Tambien se acoto el cache que inicialmente no tenia presupuesto, se estrecho el rechazo IPv4 de 192.0/16 a 192.0.0/24 para no bloquear IPs publicas y se anadio el chequeo dentro del script contra carreras de navegacion. Todas las suites finales relevantes pasan.

## 16. SQL pendiente para staging

No se ejecuto ni modifico SQL en esta pasada. La dependencia de la anterior sigue pendiente:

public.zentra_read_audit_steps(p_auth_id text,p_email text,p_product text,p_operation text).

Debe devolver acquisitionSource desde zentra_audit_acquisitions.source, correlacionado por u.id y operation_key. Conservar SECURITY DEFINER/search_path y permisos de service_role; anon/authenticated no deben obtener ejecucion publica de la funcion.

Depende de ella la version LOCAL de release-audit-steps.js que compara la raiz seo_analysis con workflow.acquisitionSource. No es una nueva dependencia introducida por el helper Chrome; existia desde el informe anterior. HEAD local a8e5af81a5b15ec0734aa43e5f218e96e919dd78 tiene pendientes sin commit: no se afirma que su version publicada incluya esa logica.

Orden futuro, exclusivamente tras autorizacion:

1. Verificar en staging tabla de adquisicion y funciones de acceso/guard preexistentes; identificar sus versiones reales.
2. Aislar y aplicar SOLO la actualizacion compatible de zentra_read_audit_steps y sus grants necesarios; no ejecutar a ciegas todo supabase-release-guard.sql con pendientes ajenos.
3. Verificar lectura del mismo usuario/operacion, ausencia de leakage y raiz de otro sitio rechazada en staging.
4. Desplegar el backend dependiente y ejecutar smoke auth/reserva/target/replay antes de probar la nueva extension.
5. Recargar la build Chrome/Audit incluyendo audit-crawl-security.js junto a background.js y zentra-api-client.js; el importScripts debe encontrar el archivo. No hace falta permiso nuevo.

Sin acquisitionSource, el backend dependiente falla cerrado para nuevas raices. No desplegar solo JS omitiendo la funcion.

## 17. Riesgos residuales y alternativa

Evaluacion de riesgo, no un resultado medido en produccion: ALTO para garantizar seguridad de red frente a URLs publicas hostiles que resuelvan a red interna o ejecuten navegacion/recursos maliciosos en pestanas auxiliares. Puede haber acceso desde la red del usuario y, en el caso de DNS privado bajo hostname publico, contenido leido con una URL aparentemente autorizada. No hay SSRF nuevo de target en el servidor actual, porque este no lo descarga.

La alternativa fuerte requiere crawler/proxy controlado con resolucion DNS validada, IP efectiva fijada por conexion, validacion de cada redirect, egreso que excluya rangos internos y aislamiento del navegador renderizado/recursos. NO basta con trasladar un fetch sin estos controles al backend. No se hizo ese cambio arquitectonico.

Costes de compatibilidad aplicados: redirects HTTP internos tambien quedan sin lectura directa; un fallo de fetch/CSP ya no puede convertirse en navegacion auxiliar. Se conserva fallback para HTML SPA aceptado. Deben verificarse esas expectativas en la proxima prueba Chrome autorizada; no se ocultan con retry nuevo ni con evidencia inventada.

## 18. Evaluacion para lanzamiento

CHROME AUDIT CRAWL = endurecido y probado LOCALMENTE en las fronteras de URL, origen, reserva, paginas, binding, dedupe y aceptacion de evidencia renderizada. NO = certificado como seguro contra toda red privada/DNS/navegacion hostil.

Puede considerarse cerrado como hardening de la extension confiable solamente si se acepta expresamente esa limitacion arquitectonica. No recomiendo una aprobacion incondicional para auditar cualquier URL hostil. Si el requisito comercial/seguridad es impedir toda conexion privada/external antes de ocurrir, queda bloqueado por arquitectura, no por un test o prompt pendiente. Se detiene aqui, antes de redisenar el crawler.

## 19. Acciones no realizadas

NO commit nuevo, push, deploy, package, publicacion ni migracion de staging/produccion. NO cambios de backend, cuotas/concurrencia/fencing, auth/CORS/rate, facturacion, Desktop/audio, PDF/branding, UI/chat/animaciones, Legal/Schema/score/coverage, keywords o competidores. Se preservo el worktree sucio y sus cambios anteriores, sin reset ni checkout destructivo.
