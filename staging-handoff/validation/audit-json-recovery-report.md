# Audit: recuperacion JSON consultivo
Fecha: 2026-09-28. Cambios locales; sin despliegue ni empaquetado.

## Diagnostico confirmado y limite de la evidencia
El flujo aceptaba un HTTP 200 del proveedor sin comprobar completitud de la fase consultiva. La extraccion descartaba el motivo de finalizacion; una salida vacia podia convertirse en "{}". El parser inicial aceptaba cualquier objeto JSON, aunque careciera de campos consultivos obligatorios. Ante un error sintactico, la recuperacion parcial aceptaba un resumen aislado; cuando tampoco podia recuperarlo, se ejecutaba inmediatamente el fallback, sin regeneracion consultiva. Las heuristicas posteriores podian completar keywords y buscar competidores sin distinguir esa degradacion.

El presupuesto inicial era de 2048 tokens y no se explicitaba esfuerzo de razonamiento para seo_analysis. Esto es un factor de riesgo de truncamiento, no una prueba de que fuera la causa exacta del incidente de tryzentra.app. El payload y finish reason de ese incidente no se conservaron; NO se ha reconstruido ni confirmado su contenido original.

## Reproducciones sinteticas, no payloads reales
Valido:
{"summary":"Servicio de software documentado.","topIssues":[],"recommendations":[{"action":"Precisar la propuesta de valor"}],"keywords":{"primary":["software SEO"],"longTail":[],"local":[]}}

Recuperable: el mismo objeto sin su ultima llave. El parser anterior lo rechaza; el nuevo solo completa cierres de contenedores cuando no hay un valor/string incompleto y valida la estructura.
No recuperable: {"summary":"Servicio sin terminar
Parcial: {"summary":"Solo un resumen"}. El parser anterior lo acepta; la nueva validacion exige summary, topIssues, recommendations y keywords con sus tres listas. technicalStatus y score siguen procediendo de evidencia tecnica.

## Cambios
- Validador compartido por las tres extensiones y copia confiable del backend: fences, objeto balanceado respetando strings, caracteres de control, cierres seguros y prefijo completo. No inventa contenido para terminar una frase.
- Backend: extraccion especifica de texto final de Responses, Chat Completions y Anthropic; conserva un motivo de finalizacion acotado.
- Maximo una regeneracion de seo_analysis con los mismos mensajes/contexto original, 4096 tokens de salida y limite de 45 segundos para esa recuperacion. No se modifica el timeout inicial, no se reinicia el crawl ni se crea otra operacion.
- Esfuerzo low solo para seo_analysis en modelos GPT-5 de Responses; resto de tareas sin cambio.
- Estados internos complete, recovered y consultative-degraded. El estado se conserva al reproducir fases desde cache.
- Si fallan los dos intentos, el backend entrega un marcador tecnico no vacio, cacheable; el cliente conserva el informe tecnico, omite refinamientos consultivos y no deriva keywords/competidores del fallback.
- Diagnostico del backend solo si NODE_ENV no es production y ZENTRA_AUDIT_JSON_DEBUG=true. Longitud, finish reason, truncamiento, etapa, campos faltantes y errores categoricos/posicion; fragmentos de 120 caracteres con TODO texto enmascarado. No se almacenan payloads originales, secretos, headers ni datos personales.
- En cliente, diagnostico solo con window.__ZENTRA_INTERNAL_DEBUG__===true, maximo 10 registros locales. Los logs originales de extraccion quedan en el backend; el cliente solo observa lo recibido del backend.
- La regeneracion puede duplicar el coste del proveedor de esta fase, no el cupo del usuario.

## Archivos del producto modificados
- /Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/publicacion/chrome-store/zentra-ai-chrome-store-clean/claude-integration.js
- /Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/ZENTRA IA/ZENTRA_AI_v1.0.1_env_phase1_lab/claude-integration.js
- /Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/ZENTRA AUDIT/ZENTRA_AUDIT_v1.0.0/claude-integration.js
- /Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/zentra-backend/trusted-audit-builders.js
- /Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/zentra-backend/server.js
- /Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/zentra-backend/release-audit-json.js (nuevo)
- /Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/zentra-backend/release-audit-steps.js

No se modificaron archivos de chat, animaciones, CTA, scroll, PDF/render, Schema, SQL ni dependencias del producto. El servidor ya tenia otros cambios pendientes: no se desplego esa tanda.

## Pruebas modificadas
En /Users/cristiangatica/Documents/Codex/2026-06-29/po/outputs/release-test-runtime:
- audit-json-recovery.test.mjs
- audit-fixtures.mjs
- quota.test.mjs
- audit-context.test.mjs (excluye unicamente el nuevo estado interno de la comparacion con la version anterior)
- audit-sector-flows.mjs (listas vacias explicitas para cumplir el contrato JSON en fixtures)
- audit-json-recovery-report.md (este informe)

## Validacion realizada
- audit-json-recovery.test.mjs: 6 comprobaciones previas y 23 grupos nuevos; A-H, envelopes, arrays de bloques, control characters, secreto en error, limite de tamanio, retry maximo uno, fallo del retry, debug desactivado, una/multipagina, mismo score y coverage, un crawl, ninguna busqueda degradada.
- quota.test.mjs: 46 comprobaciones aprobadas con HTTP y PostgreSQL local real. Incluye 299/300 concurrente, regeneracion consultiva unica, cache sin nueva generacion y un solo debito para suscripcion y Audit pago unico.
- audit-evidence.test.mjs: 22 aprobadas.
- audit-steps.test.mjs: aprobada, paridad del codigo confiable y fases de Free/Starter/Pro/Agency.
- audit-context.test.mjs: aprobada; contexto acotado, evidencia y resultados normales iguales salvo nuevo estado interno.
- audit-domain-criteria.test.mjs: aprobada (Legal, keywords representativas, competencia y detalle de Schema).
- audit-judgment.test.mjs: 17 aprobadas.
- audit-sector-criteria.test.mjs: 30 aprobadas.
- audit-sector-flow.test.mjs: 4 sectores aprobados.
- node --check server.js y git diff --check: aprobados.

Las dependencias locales preexistentes se detenian al cargar. Para evidencia y cupos se usaron versiones equivalentes instaladas en /tmp/zentra-audit-json-test-runtime mediante hooks de resolucion, sin cambiar package.json ni node_modules del producto. Los fallos iniciales del harness y fixtures quedaron corregidos y las suites anteriores se repitieron.

## Pendiente
No se ejecuto una llamada real al proveedor ni una auditoria nueva de tryzentra.app. No se garantiza que una salida arbitraria sea reparable: si faltan valores o campos esenciales despues de la unica regeneracion, se entrega el tecnico degradado. La correccion completa necesita backend y extension coherentes; recargar solo la extension no activa la regeneracion del servidor. No publicar ni empaquetar hasta autorizacion y validacion integrada en un entorno configurado.

