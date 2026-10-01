# Audit GPT-6 routing, Search budget y telemetry: cierre local

Fecha: 2026-10-01.
Estado: AUDIT GPT-6 ROUTING + SEARCH BUDGET = CERRADO LOCALMENTE.
Validacion local con el servidor real en VM/Express, PostgreSQL efimero y proveedores simulados. NO es una validacion con OpenAI real ni una autorizacion para publicar.

## 1. Routing anterior y nuevo

| Ruta | Antes | Ahora | Condicion |
| --- | --- | --- | --- |
| seo_analysis | gpt-5-mini | gpt-6-luna / medium | Capa base |
| premium_reasoning_audit | gpt-5.4-mini | gpt-6-luna / high | Autorizacion premium existente |
| pdf_summary | Modelo intermedio anterior | gpt-6-luna / high | Autorizacion existente; base medium si no concedida |
| pdf_polish | Modelo intermedio anterior | gpt-6-luna / high | Autorizacion existente; base medium si no concedida |
| executive_refiner_pdf | gpt-5 | gpt-6.1-sol / xhigh | Solo cuando la autorizacion comercial existente lo concede |
| Competitor Search | gpt-5.4-mini / low + web_search | gpt-6-luna / low + web_search | Reserva/evidencia previa y presupuesto disponible |
| Recuperacion consultiva | Base anterior | gpt-6-luna / medium | Un unico intento de recuperacion ya existente |

No se usa max. Sol xhigh no interviene en crawl, competencia, render ni recuperacion tecnica ordinaria. Un fallo HTTP confirmado de una capa premium conserva el fallback acotado a Luna Medium; una ejecucion incierta no autoriza otra generacion. No se anade un bucle de Sol.

Se reutiliza la compatibilidad GPT-6 de Responses API existente. Se omite temperature incompatible y se mantienen los contratos JSON/imagenes. El effort efectivo procede del servidor, no de un parametro arbitrario del cliente. Las constantes/ENV globales legacy permanecen para otras rutas; ya no sustituyen el routing de Audit.

## 2. Productos y derechos preservados

Zentra AI: Chrome clean y Lab sincronizan configuracion indicativa de Audit y la copia confiable del constructor. La autorizacion real sigue en backend. Chat conserva su rama dedicada; no se reabre su routing.

Zentra Audit: usa el mismo routing servidor para base y capas autorizadas, pero mantiene sus creditos individuales. Su pdf_polish indicativo pasa al modelo intermedio Luna, coherente con la ruta real; no se confunde con executive_refiner_pdf. Esto no concede Sol ni modifica sus derechos. La prueba con credito individual verifica una unidad usada y cero consumo SaaS.

| Zentra AI | Acciones normales | Audits | Maximo paginas |
| --- | --- | --- | --- |
| Free | 20 | 1 | 3 |
| Starter | 300 | 5 | 5 |
| Pro | 800 | 10 | 7 |
| Agency | 3000 | 30 | 11 |

Sin cambios en planes, precios, overrides administrativos ni contadores. En suscripcion, summary/reasoning/executive conservan allowedPlans Pro/Agency; polish conserva Agency. premium_pdf_used y las reservas/recibos existentes siguen siendo autoridad. No hay nuevos cupos premium. La misma Audit comparte su recibo en fases/replay; no se vuelve a consumir por recovery.

## 3. Search global, persistencia y concurrencia

Antes el limite de tres era por solicitud del proveedor. Ahora el limite se comparte entre web, social, retry y resume de una misma operacion Audit: MAXIMO 3 web_search tool calls externos. Cache valida y replay persistido no ejecutan proveedor ni consumen nuevos slots.

Se anaden dos tablas y dos RPCs al SQL local existente:

- zentra_audit_search_budgets: presupuesto por usuario interno autenticado + operation_key.
- zentra_search_allocations: reserva por request_hash + lease_token.
- zentra_reserve_search_budget: verifica ownership/lease, bloquea la fila existente del usuario y reserva atomica del remanente antes de marcar proveedor iniciado.
- zentra_settle_search_budget: liquida las llamadas observadas y devuelve slots no utilizados solo con resultado terminal confirmado y ownership correcto.

Las tablas tienen RLS y permisos exclusivos de service_role; Chrome no controla presupuesto, identidad, reinicio ni devolucion. constraint used between 0 and 3 refuerza el limite. Un lease obsoleto no puede devolver slots de una ejecucion nueva. Los RPCs no cambian las funciones anteriores de consumo/acquisition/leases.

Responses recibe max_tool_calls igual al remanente reservado. La API limita llamadas a herramientas integradas por respuesta; la reserva PostgreSQL extiende ese limite a toda la Audit. [Contrato de Responses](https://developers.openai.com/api/reference/cli/resources/responses/methods/create).

Adaptacion: se preserva web-first, y redes solo si no hay una web comparable suficientemente respaldada. La instruccion de Search pide no repetir cuando la evidencia alcance. No se cambian consultas, seleccion de competidores, keywords ni criterios de negocio. Pruebas con respuestas de 1, 2 y 3 tool calls confirman que no se fuerza gastar tres.

Resultado incierto, timeout, SIGKILL o respuesta incomplete: se conserva el limite superior reservado; no se adivina que las llamadas faltantes no ocurrieron. Una respuesta incomplete puede conservar candidatos ya verificados, pero no libera slots. Puede reducir capacidad posterior si la ejecucion no fue observable; es una defensa conservadora contra exceder tres, no una medicion inventada de gasto.

Presupuesto temporalmente reservado por otro worker vivo -> search_in_progress/425, no un resultado vacio permanentemente cacheado. Presupuesto definitivamente agotado -> search_budget_exhausted sin proveedor; el informe continua con evidencia disponible. Sin callbacks durables la busqueda falla cerrada, no usa un contador en memoria.

La reserva Audit sigue precediendo crawl/IA/Search. El test de ultimo credito y la prueba multiproceso del generador Chrome verifican que la operacion perdedora no inicia crawl, lectura, IA ni Search.

## 4. Recovery, resume y PDF

La recuperacion JSON mantiene el unico intento adicional existente, misma operacion/recibo, sin segundo crawl. Una segunda respuesta invalida conserva consultative-degraded y no activa competencia basada en texto degradado. No reinicia el presupuesto Search.

No se editaron prompts consultivos, parser/recovery, score, coverage, Schema, Legal, representatividad de keywords, scope competitivo, PDF layout, PDF_READY, loader, animaciones, descarga ni resume. La copia confiable conserva parity con los constructores originales salvo configuracion de modelos/precios autorizada.

Los limites actuales de salida se mantienen: seo_analysis 2048; summary/reasoning 2200; polish 3072; recovery 4096; executive 900 por defecto, con ENV existente. No se aumentaron timeouts ni se anadieron retries para ocultar salidas incompletas.

## 5. Telemetria y coste

Registro interno [AUDIT COST] por invocacion externa, no por entrega desde cache. Campos allowlisted: feature, product, plan, credit_type, operation_id hasheado y separado por producto/usuario, stage, model, reasoning_effort, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, visible_output_tokens, web_search_calls, pages_processed, estimated_cost_usd, latency_ms, status y price_version.

Etapas: seo_analysis, premium_reasoning, competitor_search, executive_refiner y recovery; aliases summary/polish mantienen su identificador de tarea. Las paginas contadas son URLs completas unicas de la evidencia congelada, no paginas parciales ni destinos duplicados. Este conteo no altera score/coverage.

No contiene prompts, URLs, email, user ID en claro, headers, credenciales ni texto de respuestas. No se expone en respuestas publicas. credit_type separa subscription_audit de individual_audit_credit/free_audit; no pretende ser un ledger ni detallar la fuente contable de cada extra SaaS.

Se reutilizan, sin editarlas, las tarifas Standard del modulo Chat: USD/millon Luna input .10/cache .01/output .50; Sol input 2/cache .10/output 10. Contextos >272K usan su tarifa larga. Search suma USD .01 por tool call, mas tokens. Reasoning ya esta incluido en output_tokens y no se factura dos veces en la estimacion. [Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [Precios](https://developers.openai.com/api/docs/pricing).

Sin usage completo, modelo con tarifa desconocida o Search incierto, estimated_cost_usd=null. Reasoning ausente queda null, no cero. Un objeto usage vacio/parcial tampoco se presenta como coste cero. Las llamadas observadas de una respuesta incomplete se distinguen de un total confirmado.

auditCostTotal(events) permite agrupar etapas por operation_id y derivar coste total. Si una etapa es desconocida, el total queda incompleto/null; no se presenta la suma parcial como total. No se anade dashboard ni base de datos contable; retencion/deduplicacion de logs y comparacion con facturacion real siguen pendientes operativamente.

## 6. Archivos de producto modificados

- /Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/zentra-backend/release-audit-routing.js (nuevo: routing/telemetry/total).
- /Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/zentra-backend/server.js (solo rutas/contexto/logging de Audit y fallback compatible).
- /Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/zentra-backend/release-audit-steps.js (callbacks de presupuesto fenced y metadata servidor).
- /Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/zentra-backend/release-competitive-search.js (Luna, budget durable, liquidacion y telemetry).
- /Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/zentra-backend/supabase-execution-guard.sql (adiciones de presupuesto/RPCs/RLS).
- /Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/zentra-backend/trusted-audit-builders.js (configuracion de Audit sincronizada).
- /Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/publicacion/chrome-store/zentra-ai-chrome-store-clean/claude-integration.js (solo configuracion/modelos/precios de debug).
- /Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/publicacion/chrome-store/zentra-ai-chrome-store-clean/subscription-manager.js (solo modelo/identificacion de capas de Audit).
- /Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/ZENTRA IA/ZENTRA_AI_v1.0.1_env_phase1_lab/claude-integration.js (mismo cambio).
- /Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/ZENTRA IA/ZENTRA_AI_v1.0.1_env_phase1_lab/subscription-manager.js (mismo cambio).
- /Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/ZENTRA AUDIT/ZENTRA_AUDIT_v1.0.0/claude-integration.js (misma configuracion de Audit).
- /Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/ZENTRA AUDIT/ZENTRA_AUDIT_v1.0.0/subscription-manager.js (modelo intermedio/premium de Audit).
- /Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/zentra-backend/release-competitive-search.test.js (fixtures terminales y tests de budget/uncertainty).

QA/documentacion, base /Users/cristiangatica/Documents/Codex/2026-06-29/po/outputs/release-test-runtime:

- audit-gpt6-routing.test.mjs (nuevo: servidor real + SQL + modelos/usage simulados).
- quota-multiprocess.test.mjs (tres grupos adicionales de presupuesto compartido).
- quota-multiprocess-worker.mjs y quota.test.mjs (fixture Search con status completed explicito).
- chat-gpt6-routing.test.mjs (solo expectativas pasivas de configuracion Audit; regresiones Chat intactas).
- audit-loader.test.mjs (normaliza solo configuracion autorizada y comprueba el resto contra hash real anterior a esta tarea).
- audit-gpt6-routing-report.md (este informe).

## 7. Pruebas ejecutadas

Todas las ultimas corridas terminaron PASS, cero fallos pendientes.

| Suite | Resultado |
| --- | --- |
| audit-gpt6-routing.test.mjs | 15 grupos PASS |
| release-competitive-search.test.js | 13 tests PASS |
| quota.test.mjs | 65 grupos PASS |
| quota-multiprocess.test.mjs | 32 grupos PASS; procesos independientes, PG real, heartbeat y SIGKILL |
| chat-gpt6-routing.test.mjs | 24 grupos PASS, incluidos cupos 3/30/100/300 |
| chat-structured-response.test.mjs | PASS |
| audit-url-scope.test.mjs | 11 grupos PASS |
| audit-chrome-crawl.test.mjs | 23 grupos PASS |
| plan-entitlements.test.mjs | 23 grupos PASS |
| audit-json-recovery.test.mjs | 6 casos frontend + 23 comprobaciones consultivas PASS |
| audit-competitive.test.mjs | 23 grupos PASS |
| audit-download.test.mjs | 9 grupos PASS |
| audit-loader.test.mjs | 9 grupos PASS |
| audit-wait-diagnostic.test.mjs | 9 grupos PASS; RUNNING retoma, PDF_READY/Save As no vuelve a generar |
| audit-schema.test.mjs | 14 grupos PASS |
| audit-small-site-topics.test.mjs | 6 grupos PASS |
| audit-domain-criteria.test.mjs | PASS |
| audit-steps.test.mjs | 21 comprobaciones PASS |
| audit-evidence.test.mjs | 22 grupos PASS |
| lemon.test.mjs | 76 grupos PASS; creditos/billing/checkout existentes |
| node --check | 12 archivos JS de producto PASS |
| git diff --check backend | PASS |

La nueva suite verifica routing real Free/Starter/Pro/Agency, denegacion de ejecutivo, perdida de autorizacion sin Sol, credito individual, 1/2/3 llamadas, web+social combinado, cache entre workers, un recovery sin reset, fallback degradado sin Search y cuotas agotadas sin proveedor. Telemetry comprueba hashing separado por usuario/producto, costo/cache/reasoning y usage incompleto.

El test multiproceso usa dos procesos Node reales contra PostgreSQL: tras usar una llamada, ambos compiten por dos slots; uno reserva y el otro queda pending, nunca cuatro. La devolucion es idempotente, un worker nuevo conserva el presupuesto y un lease obsoleto no lo libera. SIGKILL despues de iniciar proveedor conserva el limite superior reservado.

En los fixtures de servidor se elevan limites HTTP locales y se omite reconciliacion Lemon para aislar routing, no en producto. Lemon tiene regresion separada. Ninguna prueba llama OpenAI real. Los proveedores simulados no demuestran relevancia/latencia/calidad real de Search ni del refinador.

## 8. Preservacion y pendientes

Hashes de 82 archivos preexistentes: 70 identicos; 12 modificados esperados, mas el modulo nuevo. Se preservaron byte a byte manifests, popup/UI, animaciones, PDF, loaders, crawl, Schema/Legal/keywords, Chat/provider/builders, modulo Chat routing, seguridad, pagos y checkout dentro del conjunto protegido. En los archivos compartidos modificados, pruebas/hash normalizado y parity cubren el contenido fuera de configuracion Audit.

Pendiente de prueba real, antes de publicar:

- Confirmar acceso de la cuenta a ambos modelos y medir Search/costo/latencia con API real.
- Verificar que el presupuesto actual permita JSON util con medium/high y especialmente Sol xhigh: el default ejecutivo sigue en 900 tokens. max_output_tokens incluye reasoning y texto visible, por lo que puede agotarse antes del JSON final. No se declara resuelto mediante mocks ni se aumento arbitrariamente. [Referencia Responses](https://developers.openai.com/api/reference/cli/resources/responses/methods/create).
- Aplicar posteriormente, bajo autorizacion separada y orden coordinado, las adiciones SQL necesarias antes de habilitar el backend actualizado. Sin los RPCs el Search falla cerrado. Solo se aplicaron en PG efimero local.
- Validar logs/retencion y cotejar estimated_cost_usd con facturacion; tarifas Standard no cubren modalidades/recargos especiales.
- La conservacion de slots ante incertidumbre es intencional; no forzar retries que puedan exceder el maximo.

HEAD backend permanece a8e5af81a5b15ec0734aa43e5f218e96e919dd78. Cambios locales anteriores preservados; no se tomaron los diff acumulados contra HEAD como si fueran todos de esta tarea.

Chat intacto funcionalmente. NO staging. NO produccion. NO commit/push. NO deploy. NO packaging/publicacion. NO migraciones de produccion.
