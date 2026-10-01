# Cierre local de planes y entitlements

Fecha: 2026-09-30. Solo local. No commit, push, deploy, paquetes ni llamadas a produccion.

## Matriz final

| Plan | USD mensual | USD/mes anual mostrado | Acciones/mes | Auditorias/mes | Paginas/Audit | Personalizacion | PDF |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| Free | 0 | 0 | 20 | 1 | 3 | Sin habilitar perfil nuevo; comportamiento existente preservado | Zentra |
| Starter | 12 | 10 | 300 | 5 | 5 | Nombre/marca, tono, detalle | Zentra |
| Pro | 29 | 25 | 800 | 10 | 7 | Nombre, actividad, clientes, especialidad, tono, detalle y prioridades existentes | Nombre/color, sin Zentra |
| Agency | 99 | 83 | 3000 | 30 | 11 | Pro + instrucciones avanzadas | Nombre/color/logo, sin Zentra |

Texto anual autorizado: "Pagá 10 meses y usá 12". No se recalcularon equivalentes, importes de checkout, variant IDs ni facturacion real anual.

Los cupos mensuales y la profundidad por auditoria son limites independientes; no se creo un pool de paginas.
Audit de pago unico mantiene sus creditos comprados y el aislamiento respecto de la suscripcion. No se convirtio a cobro mensual.
Se preservo el override administrativo existente, limitado en servidor por identidad verificada; no se amplio a clientes ni a profundidad.

## Fuentes activas inspeccionadas

- Backend: `server.js` (PLAN_LIMITS, PREMIUM_LIMITS, normalizacion, usage y catalogo configurado).
- Backend: `supabase-release-guard.sql` y `supabase-execution-guard.sql` (consumo, planes efectivos, periodo, adquisicion previa al crawl).
- Backend: `release-audit-acquisition.js`, `release-audit-steps.js`, `trusted-audit-builders.js`.
- Chrome clean, Lab y Audit: `subscription-manager.js`, `claude-integration.js`, `zentra-api-client.js`, `claude-pdf-generator.js`, `popup.js` y `popup.html`.
- Los gates de popup, el catalogo de checkout y los presupuestos avanzados se inspeccionaron sin modificarlos.
- Desktop, distribuciones historicas y builds viejos no se editaron ni sincronizaron.

Starter ya tenia 5 auditorias en las fuentes activas revisadas; no se encontro Starter=3 activo en ese mapa.
Chrome clean/Lab ya tenian 20/1, 300/5, 800/10, 3000/30. Audit tenia una matriz auxiliar Agency=2000/20, ahora 3000/30.
Los scopes de paginas ya eran 3/5/7/11. Faltaba comunicar autoridad antes del crawl y cerrar el limite combinado de evidencia/preview Free.

Los selectores Chrome inspeccionados muestran descripciones y enlaces, no importes numericos ni la frase anual.
Los precios autorizados quedaron como configuracion comprobable en `release-entitlements.js`, sin agregar una pantalla ni alterar el checkout.
La web comercial externa y los importes reales de Lemon Squeezy NO se verificaron en esta tarea local. No se afirma que el nuevo helper publique precios en la web.

## Autoridad y enforcement

La autoridad sigue siendo el registro del usuario vinculado a la identidad autenticada, obtenido mediante el RPC service-role existente `zentra_access`.
`release-entitlements.js` calcula la profundidad canónica por plan y la cantidad solicitada menor; nunca utiliza precio, plan del body, remaining o flags de permisos como autorizacion.

La reserva existente devuelve `entitlement` junto con su lease. El transporte Chrome conserva esa politica y `resolveAuditScope` la utiliza antes de leer paginas internas.
`options.maxPages` se transmite como solicitud `requestedPages`, no como permiso. Una solicitud mayor se limita a 3/5/7/11; Free=2 y Starter=3 se respetan.
No se rellena hasta el maximo cuando hay menos paginas seleccionadas o disponibles.
Si falta la politica del servidor, Chrome falla antes del crawl. La reserva/lease y su limpieza siguen usando el flujo existente.

El backend comprueba nuevamente el usuario efectivo y el scope al registrar la fase inicial, antes del proveedor. Evidencia por encima del limite se rechaza, no se trunca silenciosamente ni se modifica scoring/cobertura.
Preview y lectura tecnica Free pueden representar las mismas URLs: se controla la union de URLs distintas, y cada lista se limita al scope. No son dos cupos sumables.
Las fases ya persistidas mantienen su reconstruccion y replay existentes; no se introdujo una politica retroactiva para operaciones en curso.

No hay nuevo sistema de reservas ni segundo consumo. La consulta de entitlement no consume unidades; la adquisicion/consumo atomicos permanecen en los RPC existentes.

## Normalizacion y gates

- Plan desconocido, vacio, null y nombres heredados (`constructor`, `__proto__`, etc.) resuelven de forma segura a Free.
- Limites ausentes, negativos, no finitos, vacios o no enteros validos no se convierten en ilimitados. Se usa la matriz del plan; cero explicito sigue siendo una restriccion valida.
- Contadores invalidos/null se normalizan a cero para la representacion del cliente; negativos no aumentan remaining. El backend conserva su validacion existente de contadores corruptos.
- Remaining se mantiene acotado a cero cuando used supera el limite. Los extras y el override administrativo existente no se redefinieron.
- Gates de perfil del popup ya coincidian con la matriz y no se editaron. Free sigue sin habilitar perfil; Pro conserva sus prioridades existentes.
- El perfil del chat se filtra actualmente en el cliente. NO se convirtio en un permiso de contenido impuesto por el backend ni se rehizo el pipeline del chat. Esto queda documentado como limitacion, no como proteccion server-side nueva.
- El PDF normal usa el plan de la reserva verificada; sin reserva verificada su gate cae a Free. Pro/Agency ya no recuperan marca/logo Zentra cuando faltan datos personalizados. Solo Agency toma el logo personalizado.
- El PDF se genera en el cliente: un navegador modificado puede alterar los bytes del documento. Este cambio protege el flujo normal del producto, no establece certificacion criptografica ni renderizado de PDF en servidor.

## Periodos y cambios internos

El SQL usa `billing_cycle_start` + intervalo de un mes con reset lazy, no un mes calendario global. Se mantuvo el periodo actual y no se redisenaron fechas ni resets.
Cuando cambia el plan autoritativo, los limites nuevos se aplican sin reset artificial del consumo acumulado; used por encima del nuevo limite deja remaining en cero.
Las pruebas validan ambos sentidos Free/Starter/Pro/Agency y conservacion de consumo; NO definen cuando debe ocurrir un upgrade/downgrade comercial.
Fecha efectiva, periodo pagado, cancelaciones, past_due, anual real y prorrateos corresponden al siguiente bloque Lemon Squeezy. No se invento politica.

## Archivos de producto modificados

Backend: `/Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/zentra-backend/`

- `release-entitlements.js` (nuevo): matriz, precios configurados, plan seguro, profundidad y validacion de evidencia.
- `server.js`: normalizacion de nombre de plan con claves propias y trim, sin otros cambios de esta pasada.
- `release-audit-acquisition.js`: consulta de usuario autoritativo y respuesta de profundidad, sin modificar la reserva SQL.
- `release-audit-steps.js`: verifica entitlement al registrar root y controla evidencia por scope; acepta menor profundidad autorizada.
- `trusted-audit-builders.js`: mismas reglas de scope/preview que Chrome, manteniendo prompts identicos para scopes completos.

En CADA directorio siguiente se modificaron exclusivamente `subscription-manager.js`, `claude-integration.js`, `zentra-api-client.js` y `claude-pdf-generator.js`:

- `/Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/publicacion/chrome-store/zentra-ai-chrome-store-clean/`
- `/Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/ZENTRA IA/ZENTRA_AI_v1.0.1_env_phase1_lab/`
- `/Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/ZENTRA AUDIT/ZENTRA_AUDIT_v1.0.0/`

Total: 17 archivos de producto (incluye el helper nuevo). No se modificaron popup, CSS, animaciones, chat, background, UI comercial ni SQL.

QA, bajo `/Users/cristiangatica/Documents/Codex/2026-06-29/po/outputs/release-test-runtime/`:

- `plan-entitlements.test.mjs` (nuevo).
- `quota.test.mjs`, `quota-multiprocess-worker.mjs`, `http-boundary.test.mjs`: adaptador local del RPC compuesto con `to_jsonb`, para simular correctamente su respuesta JSON PostgREST, sin alterar assertions de reservas/concurrencia/HTTP.
- `plan-validation.json` (generado): sintaxis, hashes y consistencia de fuentes.
- `plan-entitlements-report.md` (este informe).

## Pruebas y resultados finales

Todas locales; PostgreSQL real efimero para cuotas/concurrencia, Auth y proveedores simulados. Sin Supabase/Render ni proveedores reales.

| Suite | Resultado |
| --- | --- |
| Nuevos planes/entitlements | 23 grupos PASS |
| Cuotas, consumo, streaming/refunds, Audit recovery/reservation/search | 53 grupos PASS |
| Concurrencia, dos procesos independientes + PostgreSQL | 29 grupos PASS |
| Seguridad HTTP | 15 grupos PASS |
| Auth boundaries | 14 grupos PASS |
| Refinements/OCR | 11 comprobaciones PASS |
| Fases Audit y prompts congelados | 21 comprobaciones PASS |
| JSON consultivo | 23 comprobaciones + 6 presupuesto/extraccion PASS |
| Audio gate | 6 grupos PASS |
| Espera/resume/PDF_READY | 9 escenarios PASS |
| Descarga/progreso | 9 escenarios PASS |
| Respuestas estructuradas chat | PASS |
| Busqueda competitiva backend | 9 tests PASS |
| Sintaxis y sincronizacion | 69 JS PASS (14 backend / 22 clean / 23 Lab / 10 Audit) |
| git diff --check backend | PASS |

Fallos durante la iteracion: un getter sin coma (corregido); limite inicialmente demasiado estricto para URLs Free repetidas entre preview/tecnico (corregido contando URLs distintas); adaptadores PG devolvian texto compuesto en vez de JSON (corregidos en QA).
Se repitieron las suites afectadas: no quedan fallos en los resultados finales listados. No se ocultaron fallos cambiando expectativas de cuota.

La comparacion de hashes con `http-validation.json` demuestra 20 fuentes previas intactas, incluidos `release-security.js`, `release-operations.js`, `release-refinements.js`, `trusted-chat-builders.js`, SQL de reservas/ejecucion, background, chatbot, ai-provider y popup.
La seguridad HTTP de producto y sus migraciones no se editaron; su suite se repitio. JSON recovery, Schema, Legal, keywords, competidores, scoring, coverage, resume y PDF_READY no se modificaron.

## Dependencias y riesgos pendientes

- Staging sigue en standby. No se afirma preparacion comercial final solo con pruebas locales.
- Antes de usar esta extension contra un servidor, ese backend debe incluir el contrato `entitlement` de reserva. Backend viejo + Chrome nuevo falla cerrado antes del crawl. No publicar la extension sola.
- Validar la forma concreta del RPC `zentra_access` en staging. El helper soporta objeto y array de una fila; una respuesta malformada se rechaza sin conceder permisos.
- Personalizacion del chat continua siendo gate de cliente; no se garantiza que un cliente alterado respete esas restricciones de contenido.
- Los PDFs cliente no tienen enforcement criptografico de branding.
- Lemon Squeezy sigue pendiente: politicas de fechas, transiciones y cobro real; sin cambios en checkout ni webhooks.
- No se editaron archivos historicos ni Desktop; no se regeneraron instaladores.

NO hubo commit, push, deploy, package ni publicacion. Los cambios locales anteriores se preservaron.
