# Adaptacion local de aperturas de checkout

Fecha: 2026-10-01. Continuacion exclusivamente de checkouts. Nucleo Lemon y migraciones intactos.

## Estado

CHROME CLEAN / LAB / AUDIT = CHECKOUTS ADAPTADOS LOCALMENTE.

No se declara cerrado todo el bloque web: falta el proyecto/codigo editable de Framer y conocer su acceso autenticado. La pregunta al usuario sigue pendiente. No se publico ni se modifico la web remota.

Resultado final: 222 grupos PASS. Incluye los 200 previos y 22 comprobaciones nuevas de entrada/identidad de checkout.
No se vincularon suscripciones reales existentes ni se hicieron compras reales.

## Puntos encontrados y clasificacion

| Punto | Estado anterior | Resultado de esta pasada |
| --- | --- | --- |
| Chrome clean: selector Starter/Pro/Agency mensual y anual (6 botones) | Actualizado con helper seguro | Se conserva; tests verifican todos los pares con PostgreSQL. |
| Chrome clean: growth/scale/unlimited (3 botones) | Actualizado con helper seguro | Se conserva; prueba de clic real y variante asociada. |
| Chrome clean: CTA Free Ver planes | Abre web publica con enlaces sin identidad vinculada | Ahora abre el selector existente, con sus 6 opciones seguras. No se agrega diseno. |
| Lab: selector mensual/anual (6 botones) | Antiguo, abre URL de Lemon directamente | Mismo helper exacto que Chrome clean y mismos handlers seguros. |
| Lab: extras (3 botones) | Antiguo, abre URL directamente | Reutiliza el helper; no abre links alterados/no aprobados. |
| Lab: CTA Free Ver planes | Abre web publica | Abre el selector existente seguro, igual que clean. |
| Audit: selector Starter/Pro/Agency (3 botones) | Antiguo, abre URL directamente | Solicita auditStarter/auditPro/auditAgency al mismo endpoint autenticado. Sigue siendo pago unico, sin intervalo mensual/anual. |
| Audit: Gestionar acceso de Agency | Entrada duplicada al checkout auditAgency | Conserva el destino comercial, ahora con el vinculo seguro. No se agrega portal de cliente. |
| Audit: Comprar otra auditoria / Cambiar alcance | Entradas indirectas al selector anterior | Quedan cubiertas por el mismo handler; no cambia el criterio de creditos, alcance ni reservas. |
| Web publica: Comprar Starter/Pro/Agency | Activo y antiguo respecto de identidad; 3 enlaces mensuales en HTML publicado | Inspeccionado en lectura; pendiente de proyecto editable y login. Las duplicaciones responsive usan los mismos destinos. |
| Web /descargar y /contact | Navegacion/informacion | Inspeccion HTTP de lectura: sin enlaces de checkout Lemon en su HTML. |
| Chrome/Lab rama manage | Inactiva con getPlanActionConfig actual; URL de planes, no checkout | Intacta. Agency actualmente usa capacity. |
| Historicos ZENTRA IA/anteriores, Version Pro v2, backups/ZIP Audit y versiones bases | Historico/inactivo en el mapa actual | No se editaron. |
| partner-admin | Integracion administrativa de Lemon, sin apertura de checkout de usuario encontrada | No se edito. |
| Desktop | Fuera de alcance expreso | No se adapto ni se inspecciono como build activo a publicar. |

La web actual muestra sus botones de compra en [tryzentra.app](https://tryzentra.app/). La lectura del HTML identifica destinos mensuales configurados; no certifica el toggle anual hidratado ni todos los enlaces que pudiera tener el proyecto Framer. Eso requiere revisar su fuente editable.

## Mapping y precios

La UI solo traduce una opcion exacta del catalogo local a productKey. No manda variantId, productId, precio, plan premium, intervalo arbitrario, customer ni userId.
El backend existente conserva la autoridad y resuelve la variante. No hay heuristica por nombre Agency/producto ni strings aproximados.

| Opcion | productKey | Variant ID configurado |
| --- | --- | --- |
| Starter mensual | starter_monthly | 1683122 |
| Starter anual | starter_yearly | 1683117 |
| Pro mensual | pro_monthly | 1683111 |
| Pro anual | pro_yearly | 1683097 |
| Agency mensual | agency_monthly | 1683071 |
| Agency anual | agency_yearly | 1683081 |
| Audit Starter, pago unico | auditStarter | 1683161 |
| Audit Pro, pago unico | auditPro | 1683159 |
| Audit Agency, pago unico | auditAgency | 1605502 |
| Extra growth | growth | 1683224 |
| Extra scale | scale | 1683227 |
| Extra unlimited | unlimited | 1683228 |

IDs/productos/enlaces NO cambiaron y siguen pendientes de contraste manual en Lemon Dashboard.
Precios preservados: 12/29/99 mensual; equivalentes anuales mostrados 10/25/83. No se calculan permisos con importes del cliente ni se afirma que esos equivalentes certifiquen el cobro anual real.

Un URL o intervalo no registrado se rechaza. Incluso una URL conocida con query agregada de variantId/userId no coincide con la opcion permitida.
El endpoint solo acepta productKey; los tests confirman que campos adicionales, IDs falsificados y periodicidad desconocida no controlan el checkout efectivo.

## Identidad y apertura

El helper existente de Chrome se reutiliza literalmente en Lab. Audit conserva el mismo transporte/validacion, cambiando solo los alias a productos de pago unico.
Se reutiliza `zentraApiFetch` ya existente: obtiene la sesion Supabase, anade el Bearer verificado y no sigue redirects. No se modifico ese transporte ni su estado de operaciones.

La URL que se abre es UNICAMENTE la devuelta por el backend, HTTPS, sin credenciales, del merchant autorizado y en /checkout/buy/.
El backend existente prepara el token opaco ligado al usuario interno. La asociacion final sigue completandose en el webhook verificado. Email no se convierte en autoridad.

Si falta sesion, falla el request o el destino devuelto es ajeno: no se abre una compra ni un link publico alternativo. El selector sigue visible y el boton vuelve a estar habilitado. Se cierra solo despues de abrir el checkout verificado.
No se hace un retry nuevo ni se altera ningun consumo.

## Archivos modificados

Producto, SOLO tres popup.js:

- `/Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/publicacion/chrome-store/zentra-ai-chrome-store-clean/popup.js`: una linea en la apertura del CTA Free; usa el selector ya existente.
- `/Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/ZENTRA IA/ZENTRA_AI_v1.0.1_env_phase1_lab/popup.js`: helper ya validado, handlers de apertura de plan/extras y CTA Free.
- `/Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/ZENTRA AUDIT/ZENTRA_AUDIT_v1.0.0/popup.js`: helper de checkout, clic del selector y apertura duplicada Agency/manage.

QA/documentacion:

- `/Users/cristiangatica/Documents/Codex/2026-06-29/po/outputs/release-test-runtime/checkout-entrypoints.test.mjs`: fixtures de DOM, handlers reales y transporte real de las tres copias; reutiliza los workers PostgreSQL/Lemon existentes.
- `/Users/cristiangatica/Documents/Codex/2026-06-29/po/outputs/release-test-runtime/lemon.test.mjs`: integra esas comprobaciones y rechazo de campos/intervalos no autorizados.
- `/Users/cristiangatica/Documents/Codex/2026-06-29/po/outputs/release-test-runtime/checkout-adaptation-report.md` y `checkout-validation.json`: informe y hashes/resultados.

NO se editaron backend, SQL, manifests, HTML, CSS, assets ni codigo funcional de Audit. No hay nueva dependencia ni nueva arquitectura de checkout.

## Pruebas y regresiones

Auth/Lemon simulados, dos procesos Node independientes y PostgreSQL real efimero. Los fixtures aplican las migraciones anteriores solo en esas bases temporales; no se crearon ni cambiaron migraciones de producto y no se aplico SQL a Supabase/produccion.

| Suite | Resultado |
| --- | --- |
| Lemon + entradas de checkout nuevas | 76 grupos PASS (54 anteriores + 22 nuevos) |
| Auth boundaries | 14 grupos PASS |
| Planes/entitlements | 23 grupos PASS |
| HTTP/webhooks | 15 grupos PASS |
| Quotas/chat/stream/JSON recovery/Audit reservation | 65 grupos PASS |
| Concurrencia multiproceso | 29 grupos PASS |
| Total | 222 grupos PASS |
| Sintaxis de tres popup.js | PASS |
| git diff --check backend | PASS |

Se comprobaron los 6 pares SaaS desde clean y Lab, y los 3 productos Audit. Cada clic termina en un token cuyo registro SQL tiene el product/variant esperado y auth_user_id de la sesion, no del cuerpo manipulado.
Se prueban el transporte autentico, rechazo sin sesion, links modificados, destino ajeno, fallo backend, selector conservado, botones reactivados, CTA Free y los 3 extras desde los handlers reales.
Las pruebas negativas del backend cubren camelCase variantId/productId/userId, plan, price y periodicidad desconocida, ademas de los casos previos de apropiacion de subscription/customer.

Un fallo inicial fue exclusivamente del fixture: eval separados en jsdom no compartian las constantes lexicales del popup. Se corrigio cargando las declaraciones y handlers en un mismo script, igual que en el archivo real; se repitieron las suites y no quedan fallos finales.

## Audit/PDF/crawl intactos

Se verifican hashes del popup anterior al helper, posterior al bloque de compras y del setup del modal: no difieren. Esos segmentos contienen la logica funcional de Audit y sus callbacks fuera del checkout.
El test deja una operacion Audit en curso mientras inicia compras y confirma que el objeto no cambia.
La comparacion de archivos con los inventarios previos confirma intactos: PDF, crawl, JSON recovery, builders, estados/reservas, entitlements, subscription-manager, API client, chat, animaciones, HTML y assets inventariados.
El core Lemon, server.js, release-security.js y supabase-lemon.sql tienen exactamente los hashes de lemon-validation.json; no se reabrieron sus garantias.

## Web: dato faltante

El proyecto publicado esta servido por Framer. No se encontro fuente editable web entre los proyectos activos locales revisados.
Hace falta el proyecto/codigo de los CTA de compra (incluido el toggle anual) y saber donde inicia sesion el comprador y como se obtiene su sesion verificada de Zentra en esa web.
No se puede trasladar el Bearer del popup a una pagina publica por query, confiar en email ni incrustar una service role/API key como atajo.
Si la web no tiene login, esa dependencia requiere una decision separada de flujo autenticado; no se invento un login/gateway dentro de esta tarea acotada.

Hasta resolverlo, los botones publicos no deben usarse con el cutover nuevo para acreditar compras automaticamente. No se declara CHECKOUTS LEMON = ADAPTADOS LOCALMENTE en sentido global incluyendo la web.

## Suscripciones existentes: informacion necesaria para el bloque separado

- ID estable Supabase/Auth verificado y users.id/plan_type de Zentra, con comprobacion de propiedad de la cuenta; email solo auxiliar.
- Store ID real y modo test/live correctos.
- Customer ID y subscription ID reales, consultables con la API privada de Lemon.
- Product/variant actuales, intervalo, estado, updated_at, ends_at/trial_ends_at y pause mode si corresponde, obtenidos del proveedor.
- Evidencia verificable que permita unir esa subscription al usuario interno: binding/metadata original ya validada o comprobacion manual autorizada de propiedad y compra. No basta una coincidencia de correo ni metadata escrita libremente por un cliente.
- Verificar unicidad del customer/subscription, posibles asociaciones ya existentes, varias subscriptions y conflictos antes de escribir la relacion.
- Historial de pedidos/recibos necesario para no duplicar compras ni creditos; conservar contadores y ciclo actual.
- Verificacion manual de los IDs del catalogo y revision en staging antes del cutover.

No se consultaron ni asociaron cuentas reales, ni se implemento importador/migracion masiva. Ese bloque sigue separado.

NO commit, push, deploy, publicacion, compras reales ni packaging. NO migracion nueva ni SQL en bases persistentes/produccion. HEAD permanece a8e5af81a5b15ec0734aa43e5f218e96e919dd78.
