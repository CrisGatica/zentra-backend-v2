# Chat GPT-6 routing: cierre local

Fecha: 2026-10-01. Estado: CHAT GPT-6 ROUTING = CERRADO LOCALMENTE.
Validacion con PostgreSQL efimero local y proveedor simulado; no gasto ni llamadas al proveedor real.

## Contrato anterior y nuevo

Antes: chat base gpt-5-mini; avanzado gpt-5.4-mini; agotamiento avanzado volvia a base. La ruta directa podia usar el modelo base global. El chat no usaba gpt-5 como nivel Pro.

Ahora, decisiones autoritativas centralizadas en release-chat-routing.js:

| Tier | Modelo | Reasoning | Consumo |
| --- | --- | --- | --- |
| chat_base | gpt-6-luna | medium | Una normal |
| chat_advanced | gpt-6.1-sol | medium | Una normal + una avanzada |
| chat_advanced_fallback por agotamiento | gpt-6-luna | high | Una normal, cero avanzadas |

Ruta directa: tarea normal -> Luna Medium; tarea premium -> reserva avanzada atomica existente -> Sol Medium si concedida; Luna High si no concedida. El modelo solicitado por el cliente no autoriza ni decide el modelo efectivo.

Ruta progresiva: Luna Medium -> respuesta util/checkpoint -> solo si premium + needsReasoning -> misma resolucion/reserva atomica -> Sol Medium o Luna High. No hay llamada de clasificacion adicional.

Cupos intactos: Free 20 normales/3 avanzadas; Starter 300/30; Pro 800/100; Agency 3000/300. Se preservo tambien el override administrativo preexistente; los cupos indicados corresponden a cuentas normales. No se crearon contadores ni recibos nuevos. advanced_actions_used conserva el alias premium_chat_used. No se editaron SQL, reset, devoluciones, auth, leases ni fencing.

Refinamientos: rewrite, organization, ocr_cards, incomplete, strategic, polish, reasoning y visible mantienen constructores y autorizaciones existentes. Se amplio el guard de capacidad del constructor de reasoning para GPT-6, tambien en la copia confiable del backend. Una prueba HTTP real con PostgreSQL confirma que root + reasoning + replay comparten una normal/una avanzada. Los demas constructores y prompts pasan sus regresiones existentes.

## Transporte y errores

Los dos modelos nuevos usan Responses API; effort se establece desde el tier decidido en servidor, no desde el body del cliente. Se omite temperature. Se conservan imagenes y json_object; se traduce json_schema al formato de Responses exclusivamente en Chat. No hay tool calling de Chat que migrar en este flujo actual. El NDJSON progresivo conserva el transporte por capas actual, no se convierte en streaming token-a-token del proveedor.

Presupuestos existentes intactos: directo normal/OCR 4096, avanzado 1800, base progresiva hasta 1100, refinamiento final opcional 1200. Las ENV antiguas de modelo/proveedor de Chat ya no sustituyen el contrato fijo; los presupuestos y el flag ejecutivo siguen vigentes. Las ENV/modelos globales de Audit/PDF no cambian.

Agotamiento: no se intenta Sol ni se reserva avanzada. Fallo HTTP confirmado de Sol: como antes, un fallback acotado, ahora Luna High, dentro de la misma operacion; no devuelve la avanzada si existe respuesta util. Si ambas capas fallan y hay base util, se conserva la base. Una excepcion de transporte marca ejecucion incierta: no se dispara Luna ni se regenera; durante lease devuelve pending y tras expiracion execution_uncertain. No hay loop. El refinamiento final opcional hereda el tier concedido; si hubo fallback tecnico, no vuelve a Sol.

Resume sigue activo: cierre/reapertura con ejecucion viva conserva pending; al completar entrega cache sin proveedor/consumo extra. Una accion legacy gpt-5.4 con lease pre-proveedor expirada retoma con routing nuevo y un solo recibo normal. Cache ya completada no se regenera por cambiar modelos.

## Telemetria y costos

Registro interno [CHAT COST] por llamada completada o transporte incierto: plan, logical_tier, modelo solicitado efectivo, reasoning_effort, premium_granted, input/cached input/output/reasoning tokens, operation_id hasheado, feature=chat, status y estimated_cost_usd. No contiene mensajes, email, headers, claves ni tokens de autenticacion. No se devuelve en respuestas publicas y no interviene en autorizacion. En incertidumbre/sin usage el costo es null, no cero.

Precios centralizados en release-chat-routing.js, USD por millon, Standard: Luna input .10/cached .01/output .50; Sol input 2/cached .10/output 10. Incluye umbral >272K: input/cache x2, output x1.5. Reasoning ya esta incluido en output_tokens y no se cuenta dos veces.

Fuentes verificadas: [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [compatibilidad de parametros](https://developers.openai.com/api/docs/guides/latest-model).

Simulacion, NO gasto medido: por invocacion 1000 input, 200 cached, 300 output incluyendo 100 reasoning; sin refinamientos, errores, cache writes explicitas, modalidades de servicio especiales ni recargos regionales. Se utilizan todos los cupos normales y avanzados; ninguna accion adicional a las normales de cada plan.

| Plan | Acciones/avanzadas | Directo USD | Progresivo USD |
| --- | --- | --- | --- |
| Free | 20/3 | .017804 | .018500 |
| Starter | 300/30 | .201240 | .208200 |
| Pro | 800/100 | .624400 | .647600 |
| Agency | 3000/300 | 2.012400 | 2.082000 |

Directo = normales no avanzadas x costo Luna + avanzadas x costo Sol. Progresivo = todas las normales x base Luna + avanzadas x Sol. Luna High tiene las mismas tarifas que Medium, pero sus tokens/latencia reales pueden diferir. Estos fixtures NO predicen una factura ni incluyen Audit/Search/PDF. Los logs no sustituyen un sistema contable persistente; su retencion depende de la configuracion posterior del entorno.

## Archivos de producto modificados

- /Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/zentra-backend/server.js
- /Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/zentra-backend/trusted-chat-builders.js
- /Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/publicacion/chrome-store/zentra-ai-chrome-store-clean/ai-provider.js
- /Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/publicacion/chrome-store/zentra-ai-chrome-store-clean/claude-chatbot.js
- /Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/publicacion/chrome-store/zentra-ai-chrome-store-clean/strategy-model-selector.js
- /Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/publicacion/chrome-store/zentra-ai-chrome-store-clean/subscription-manager.js
- /Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/ZENTRA IA/ZENTRA_AI_v1.0.1_env_phase1_lab/ai-provider.js
- /Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/ZENTRA IA/ZENTRA_AI_v1.0.1_env_phase1_lab/claude-chatbot.js
- /Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/ZENTRA IA/ZENTRA_AI_v1.0.1_env_phase1_lab/strategy-model-selector.js
- /Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/ZENTRA IA/ZENTRA_AI_v1.0.1_env_phase1_lab/subscription-manager.js
- /Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/zentra-backend/release-chat-routing.js (nuevo)

Chrome clean/Lab: ai-provider centraliza catalogo indicativo; subscription-manager usa rama exclusiva Chat y expone catalogo correcto; strategy-model-selector mantiene gpt-5-mini en fallback no-Chat; claude-chatbot cambia solo default y guard GPT-6. UI, eventos, animaciones, scroll, CTA y prompts no se editaron. trusted-chat-builders replica solo esos dos cambios de Chat.

Pruebas/documentacion:
- /Users/cristiangatica/Documents/Codex/2026-06-29/po/outputs/release-test-runtime/chat-gpt6-routing.test.mjs (nuevo)
- /Users/cristiangatica/Documents/Codex/2026-06-29/po/outputs/release-test-runtime/quota.test.mjs (fixture VM actualizado al resolver central; mismos escenarios y assertions)
- /Users/cristiangatica/Documents/Codex/2026-06-29/po/outputs/release-test-runtime/chat-gpt6-routing-report.md (este informe)

## Pruebas ejecutadas

| Suite | Resultado |
| --- | --- |
| chat-gpt6-routing.test.mjs | 24 grupos PASS; incluye 433 concesiones avanzadas de los cuatro planes |
| quota.test.mjs | 65 grupos PASS |
| quota-multiprocess.test.mjs | 29 grupos PASS, dos procesos Node independientes y PostgreSQL real |
| chat-personalization.test.mjs | 18 grupos PASS |
| refinements.test.mjs | 11 comprobaciones reportadas PASS |
| chat-structured-response.test.mjs | PASS; ad cards, labels internos, respuestas normales, OCR y JSON |
| backend-auth-boundaries.test.mjs | 14 grupos PASS |
| http-boundary.test.mjs | 15 grupos PASS |
| plan-entitlements.test.mjs | 23 grupos PASS |
| lemon.test.mjs | 76 grupos PASS, incluida regresion checkout (por precaucion del servidor compartido) |
| node --check | 13 archivos PASS |
| git diff --check backend | PASS |

El routing se ejecuto mediante el server.js real en VM/Express, auth y middleware de operaciones reales, SQL real y proveedor simulado. En esta suite se omite exclusivamente reconciliacion de asociaciones billing del fixture y se elevan rate limits locales para probar 433 concesiones; Lemon y HTTP se validan por separado sin esos overrides. No se cambian configuraciones de producto. Los fallos transitorios del arnes (expectativas de status pending/uncertain, fixture sin response_format, binding billing faltante e import del fingerprint) se corrigieron en tests, no relajando las protecciones del producto. La ultima corrida de cada suite pasa.

La nueva suite comprueba passive shared transport sin ejecutar una auditoria: Audit mantiene gpt-5-mini/low/2048; PDF mantiene sus modelos y parametros anteriores. Comprobacion de hashes: 102 archivos preexistentes fotografiados, 10 modificados esperados y 92 intactos. Todo el producto Audit, modulos de Audit/PDF/Search, SQL, manifests, checkout, backend security/operations/refinements, popup/UI y estilos protegidos sin cambios. Los cuatro archivos editados de clean y Lab son identicos byte a byte.

## Pendiente antes de staging

No hay validacion con clave real en esta tarea. Confirmar acceso de la cuenta a ambos modelos, calidad conversacional/OCR, latencia, casos de salida incompleta y suficiencia de 1100/1800 tokens con medium/high; no se aumentaron presupuestos ni timeouts sin evidencia. Revisar retencion/acceso de logs y comparar costos estimados con usage/facturacion real, incluidos recargos si el servicio cambia. El cliente sigue teniendo guards legacy de rescate de modelos antiguos para acciones previas; los tiers nuevos no disparan ese rescate por agotamiento porque el servidor ya ejecuta Luna High. No se cambiaron condiciones de generacion ni UI para forzar otra pasada.

NO staging. NO produccion. NO push. NO deploy. NO empaquetado. NO publicacion. NO migraciones de produccion. Todos los cambios locales previos preservados.

