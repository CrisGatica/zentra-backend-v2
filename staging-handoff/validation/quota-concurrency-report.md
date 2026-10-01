# Atomicidad y concurrencia de cuotas

**Actualizacion posterior: las tres brechas estan corregidas y verificadas localmente bajo at-most-once automatico en resultado incierto.** La implementacion, archivos, migraciones, 28 grupos multiproceso, 53 grupos de cuotas y riesgos pendientes estan en [execution-concurrency-report.md](/Users/cristiangatica/Documents/Codex/2026-06-29/po/outputs/release-test-runtime/execution-concurrency-report.md). No hubo push/deploy/package.

El resto de este documento conserva la caracterizacion HISTORICA anterior al fix: las brechas y la decision de detenerse descritas abajo pertenecen a esa pasada, no al estado local actual.

## Fuente de verdad existente

La version LOCAL no usa el read/modify/write del backend publicado para reservar generacion. Cada llamada RPC se ejecuta en una transaccion PostgreSQL. zentra_access adquiere FOR UPDATE sobre la fila users del usuario/producto; ese lock se conserva hasta terminar la RPC y serializa check, descuento, recibo y estado de peticion. zentra_consume_generation exige ademas el lease actual para descuentos internos.

| Tabla | Identidad o garantia |
| --- | --- |
| users | UNIQUE(email, plan_type) y UNIQUE(auth_user_id, plan_type); contadores y ciclo mensual bloqueados por fila |
| zentra_usage_receipts | PRIMARY KEY(user_id, counter, operation_key); funding, billing_cycle y refunded_at |
| zentra_requests | PRIMARY KEY(user_id, operation_key, request_hash); source_hash, kind, state, attempts, response y lease_token/lease_until |
| zentra_chat_steps | PRIMARY KEY(user_id, operation_key, step_name); cuerpo/contexto originales y fases autorizadas |
| zentra_audit_steps | PRIMARY KEY(user_id, operation_key, step_name); fases y evidencia de Audit |

zentra_begin_request reusa una respuesta done, rechaza running con lease vigente, limita intentos fallidos a tres y valida el hash raiz. Las fases nuevas deben estar registradas; maximo nueve peticiones de chat o tres de Audit por operacion. Los builders actuales restringen los refinamientos. No se agregaron estados ni indices porque los existentes resuelven la carrera normal de cuota.

El check y el incremento de un contador no son queries independientes sin lock: zentra_consume llama a zentra_access dentro de la misma transaccion. Si falla la insercion de la peticion/recibo, la transaccion no deja un descuento parcial. zentra_finish_request y zentra_refund_failed bloquean la misma fila users, exigen lease/estado, comprueban hermanos done/running y marcan refunded_at junto con la devolucion. Un resultado done no se refunde por un error posterior. Los cambios de ciclo y extras conservan las reglas existentes, no se modificaron precios ni limites.

## Pruebas multiproceso

Se levantaron dos procesos Node con HTTP y memoria completamente independientes. Cada uno cargo createApiSecurity, createOperationGuard y los guards/handler actuales de busqueda. Ambos usaron el mismo PostgreSQL real local, mediante pools separados. Los handlers de generacion y los proveedores fueron simulados; Auth uso sesiones de prueba. No hubo requests a Render/OpenAI/Supabase real. El handler de chat simulado no sustituye una prueba del pipeline real completo; la suite anterior de 53 grupos complementa esta prueba, incluyendo el handler real de streaming con proveedor simulado.

15 grupos positivos pasaron:

- Free, Starter, Pro y Agency: un restante, chat y stream simultaneos en procesos distintos; uno genera, otro recibe 403, used termina exactamente en el limite y remaining derivado es cero.
- Diez restantes y veinte raices simultaneas: diez llamadas al proveedor, diez recibos, diez peticiones done y diez rechazos; no once reservas ni descuentos parciales.
- Mismo action/request diez veces: una llamada, una peticion, un recibo; 425 en curso o cache 200. Replays terminados no vuelven al proveedor.
- Resultado util persistido: dos fallos tardios no alteran response/estado ni refundean el recibo.
- Mismo OCR diez veces: una llamada, un recibo y un descuento.
- Dos handlers de fallo simultaneos: una finalizacion aceptada y un refund; respuesta tardia no genera otro abono.
- Fallo total y diez retries legitimos concurrentes: una nueva ejecucion, dos attempts, una peticion/recibo y un consumo neto; no se manipulo el cuerpo persistido para hacer pasar el retry.
- Diez refinamientos autorizados concurrentes: una ejecucion adicional y el mismo consumo; etapa arbitraria rechazada.
- Consumo nuevo y refund concurrente: el consumo ajeno permanece; solo se devuelve el recibo de la operacion fallida.
- Fila Alice bloqueada dentro de una transaccion: Bob completa mientras ese lock sigue tomado; saldos y recibos independientes.
- Audit de suscripcion con ultimo cupo: una generacion/reserva; perdedor sin recibo ni peticion de generacion. Su busqueda competitiva es rechazada.
- Audit de pago unico con ultimo credito: una generacion/recibo; audit_credits_used=1 y audits_used=0 en el producto Audit, sin alterar el saldo de suscripcion.

Los cuatro planes se contabilizan como cuatro grupos, dando quince en total. Se comprobaron directamente used, filas/estados, attempts, lease, refunded_at y ausencia de registros duplicados/parciales. Los fixtures restablecen contadores entre casos; no se presenta la suma historica de recibos de todos los fixtures como contabilidad de un usuario de produccion.

El primer arranque del harness fallo porque el spread de connectionParameters omitia la password no enumerable de pg. Se corrigio solo el transporte de credenciales de la DB efimera a los hijos y se repitieron las pruebas; no fue una carrera de producto ni se expusieron credenciales en logs. La ejecucion final completo los quince grupos positivos y las dos reproducciones abiertas.

## Brechas reproducidas

**1. Busqueda competitiva duplicada entre instancias.** La misma busqueda autorizada de una auditoria completada ejecutada una vez en cada proceso produce dos llamadas al proveedor. Ambas conservan el mismo consumo de Audit. Causa: cache/pending son Map locales de release-competitive-search.js; req.auditSearch identifica la operacion autorizada pero no reserva una ejecucion de proveedor en PostgreSQL. El lock del contador no deduplica esta fase externa.

**2. Lease vencido y resultado util sin persistencia.** Se inicio un proveedor simulado en el proceso A y se lo mantuvo pendiente. Se vencio explicitamente lease_until en la DB local para simular perdida de heartbeat; no se esperaron cinco minutos ni se cambiaron timeouts de producto. El proceso B tomo el retry del mismo ID: dos proveedores en curso, un consumo neto. A termino y PostgreSQL rechazo su finalizacion por lease_token antiguo, pero release-operations.js atrapo el error y res.json entrego 200 con contenido util. B fallo; el refund aceptado dejo actions_used=0 aunque A ya habia entregado contenido. La respuesta del worker antiguo no quedo registrada como done.

Esto es una brecha del enlace entre propiedad de ejecucion, entrega y contabilidad, no una doble devolucion: solo un refund fue aceptado, pero era indebido respecto al contenido ya entregado. El fencing SQL ya existe; no alcanza si el worker ignora su rechazo al entregar al cliente. El heartbeat tampoco cancela la ejecucion cuando no puede renovar. El mismo principio afecta una perdida de persistencia del resultado y necesita revision en el streaming antes de emitir contenido, no solo al cerrar la respuesta.

Estas dos caracterizaciones verifican la presencia del defecto actual; NO son pruebas de que el comportamiento deseado haya pasado. La salida del test las identifica como OPEN GAP, por separado de los quince grupos positivos.

**3. Lectura anterior a reserva en Audit, confirmada por codigo.** claude-pdf-generator.js recopila/lee la pagina principal antes de llamar a analyzeSEO; claude-integration.js fetchInternalPagesContext tambien corre antes del primer request seo_analysis que reserva cuota. El control inicial del cliente es una lectura, no una reserva DB. Por ello dos clientes pueden leer/crawlear antes de que PostgreSQL elija la auditoria ganadora. La perdedora no llega a IA/busqueda, pero NO puede afirmarse que no haya leido paginas. No se probo este punto en Chrome nativo; se inspecciono el orden real de llamadas.

## Ampliacion necesaria antes de accionar

No conviene repetir los locks ni subir el timeout para ocultar los defectos. El cierre completo requiere:

- Ejecucion y resultado de busqueda persistidos y deduplicados por usuario/operacion/hash en DB, con ownership real entre instancias; la memoria puede seguir siendo una optimizacion.
- Entrega de contenido condicionada a ownership valido y registro duradero de resultado util antes de permitir un refund. Debe abarcar JSON y streaming, manteniendo la respuesta util ante errores posteriores.
- Definir recuperacion del resultado incierto: si el proveedor ya empezo y el lease vence, una repeticion automatica puede ejecutar dos veces. La DB puede impedir una segunda admision, pero por si sola no sabe si el proveedor externo termino. Garantizar ninguna segunda ejecucion puede requerir suspender el retry automatico hasta reconciliar el resultado; no se modifico resume para imponer esa decision.
- Reserva de adquisicion antes de leer paginas, ligada al mismo ID de Audit y reutilizada por seo_analysis; cancelacion/refund/resume de esa reserva deben estar definidos. Esto cambia el contrato de entrada/lifecycle, no el analisis SEO ni el PDF visual.

Archivos de producto implicados en una futura correccion: supabase-release-guard.sql y release-operations.js; handler/guard de busqueda y cableado server.js; para impedir crawl antes de reserva, transporte de Chrome y punto de entrada de Audit. No se sustituyeron ni editaron esos archivos en esta pasada.

No se improviso esa ampliacion como un parche de contadores. Falta alinear la garantia ante proveedor de resultado incierto antes de implementarla. Una cache Redis/Map o un mutex Node no resolverian por si solos estas garantias.

## Regresiones y archivos

Se repitieron y pasaron: quota.test.mjs (53 grupos); backend-auth-boundaries (9); refinements (11 salidas, incluido OCR); audit-steps (21 salidas); audit-json-recovery (23 comprobaciones consultivas y 6 de parser/presupuesto); structured chat; audio-gate (6); competitive search (9); audit-wait (8 escenarios) y audit-download (9 escenarios). No se regeneraron PDFs reales.

Archivos creados: quota-multiprocess-worker.mjs, quota-multiprocess.test.mjs y este informe, dentro del runtime de pruebas existente. Se agrega una nota de alcance al informe anterior de auth/consumo. Ninguna migracion, constraint ni archivo de producto fue modificado. Desktop, UI, resume, audio gate, Audit/PDF, CORS/rate limiting y planes/Lemon Squeezy quedaron intactos.

**Conclusion:** PostgreSQL impide superar las cuotas de chat y Audit en las reservas simultaneas normales probadas, incluso entre procesos, y evita el doble refund. NO se garantiza todavia una sola llamada fisica al proveedor ni refund correcto tras perder ownership/persistencia y entregar contenido. Tampoco se garantiza reserva antes de crawl. El bloque global permanece abierto; no desplegarlo como "concurrencia totalmente resuelta". La carrera read/modify/write del backend publicado tampoco fue corregida mediante un deploy en esta tarea.

No hubo commit, push, deploy, empaquetado ni publicacion. CORS/rate limiting y planes/Lemon Squeezy siguen siendo bloques independientes; no se reauditaron ni corrigieron aqui.
