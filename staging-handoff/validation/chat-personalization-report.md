# Personalizacion del chat: enforcement local

Fecha: 2026-09-30. Solo local; sin staging, push, deploy ni paquetes.

## Bypass encontrado

Chrome filtraba los campos del perfil por plan en el cliente y los expandia en el primer mensaje system. Los endpoints /api/chat y /api/chat/stream persistian ese prompt como raiz de la operacion. Un request manipulado podia incorporar personalizacion superior o instrucciones privilegiadas en system/developer sin depender de los controles del popup.

Campos reales: profile_name, profession, client_type, specialty, tone, response_depth, priorities, advanced_instructions. No eran campos brand/activity/services del contrato. Los aliases advancedInstructions, customInstructions y systemInstructions tampoco son una fuente autorizada.

## Cambio

La preparacion de una nueva raiz consulta zentra_access usando la identidad verificada y el producto. Reutiliza PLAN_ENTITLEMENTS; no hay una segunda matriz comercial. Free conserva su comportamiento sin perfil. Starter permite profile_name/tone/response_depth; Pro suma profession/client_type/specialty/priorities; Agency suma advanced_instructions.

El servidor limita longitudes, valida enums de tono/detalle y reconstruye las instrucciones con los builders confiables existentes. Los mensajes system/developer del cliente no se usan como instrucciones efectivas. Mensajes user/assistant, adjuntos y response_format se conservan. El plan impreso/enviado por Chrome no otorga capacidades.

Los snapshots de Chrome llevan el perfil tipado, documentos y contexto del sitio ya leido; el backend no ejecuta otro crawl. Para clientes anteriores, se extraen solo campos conocidos del bloque de perfil antiguo y se aplica el mismo gate; nunca se reutiliza el system original.

La raiz autorizada se congela. Se guarda aparte el fingerprint original para mantener retries/resume exactos y rechazar contenido cambiado bajo la misma operacion. No se modifica el mecanismo de reserva, leases, fencing, streaming o consumo.

## Archivos de producto modificados

- /Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/zentra-backend/release-entitlements.js
- /Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/zentra-backend/release-refinements.js
- /Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/publicacion/chrome-store/zentra-ai-chrome-store-clean/claude-chatbot.js
- /Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/ZENTRA IA/ZENTRA_AI_v1.0.1_env_phase1_lab/claude-chatbot.js

QA: chat-personalization.test.mjs nuevo; quota.test.mjs ampliado con cuatro grupos HTTP de personalizacion; personalization-validation.json generado; este informe.

## Validacion

- Personalizacion: 9 grupos pasan, planes falsificados, roles privilegiados, aliases, planes desconocidos, perfil antiguo, campos/enums, formato estructurado, historial/imagenes/documentos, refinamiento y replay.
- Cuotas/HTTP con PostgreSQL real y proveedores simulados: 57 grupos pasan. Los cuatro grupos nuevos comprueban cada plan por chat y stream; replay sin proveedor ni consumo adicional.
- Concurrencia entre dos procesos independientes y PostgreSQL real: 29 grupos pasan.
- HTTP boundary: las 15 comprobaciones pasan. La ultima ejecucion termina con exit 1 en el teardown al detener PostgreSQL: un pool recibe 57P01 (terminating connection due to administrator command). No fallo una asercion funcional; queda pendiente corregir el cierre del fixture, sin tocar seguridad HTTP en esta tarea. Una invocacion combinada previa tambien fallo al resolver la dependencia del runner; se repitio con el comando independiente correcto.
- Planes/entitlements: 23 grupos pasan; precios, acciones, audits y maxPages preservados.
- Auth: 14 grupos pasan. Refinements: 11 grupos pasan.
- Respuestas estructuradas: suite pasa, anuncios/cards/OCR/JSON solicitados/respuestas normales.
- Audit resume/progreso: 9 escenarios pasan. Descarga PDF: 9 escenarios pasan.
- Sintaxis: 69 archivos pasan, cero errores. git diff --check sin errores.
- Metodos save/load/clear/fresh/resume del chat comparados con trusted-chat-builders: identicos en clean y Lab. Replay de la raiz autorizada probado sin nueva consulta de plan ni registro adicional.
- Hashes frente a plan-validation.json: solo cambian release-refinements.js y claude-chatbot.js de clean/Lab entre los archivos previamente inventariados. release-entitlements.js incorpora exclusivamente campos/gate de perfil; numericos comprobados por la suite de planes. SQL, server.js, seguridad HTTP, operations, builders confiables y Audit/PDF conservan sus hashes.

## Limites y pendientes antes de despliegue

No se hizo una validacion con proveedores/Supabase reales ni navegador autenticado de staging. Los tests HTTP usan el servidor real, PostgreSQL local y Auth/proveedores simulados.

Las operaciones persistidas ANTES del fix conservan su body congelado para preservar resume. El gate protege nuevas raices; no sanitiza retroactivamente operaciones antiguas. Antes de desplegar, revisar si existen operaciones pre-fix y definir su drenaje sin borrar historial ni romper recuperacion. No afirmar cierre retroactivo del bypass mientras puedan reutilizarse esas raices.

Validar backend y Chrome juntos. Los clientes anteriores recuperan el perfil conocido, pero no aportan los nuevos snapshots de documentos/contexto cacheado; no se certifica paridad completa de esos contextos en versiones antiguas.

No se intenta resolver prompt injection general: contenido de usuario/pagina/documento sigue siendo entrada no confiable. Un usuario puede pedir un tono en su mensaje normal; eso no equivale a activar el perfil comercial persistente. Las transformaciones rapidas conservan sus prompts existentes, sin introducir personalizacion donde antes no habia.

Esta pasada cierra el gate de personalizacion para nuevas operaciones, no certifica todas las capacidades comerciales del producto. Los controles de UI siguen siendo presentacion; otros gates solo cliente y la posibilidad de editar localmente un PDF exportado requieren su propia evaluacion. No se modificaron branding ni otros gates para ampliar alcance.

Cambios locales anteriores preservados. No se tocaron pagos/Lemon Squeezy, CORS/rate limiting, cuotas, concurrencia, SQL, Audit/PDF, Desktop, audio, UI ni animaciones.
