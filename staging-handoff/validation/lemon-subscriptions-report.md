# Lemon Squeezy: cierre local de suscripciones

Fecha: 2026-10-01. Trabajo local sobre el estado existente. No commit, push, deploy, SQL de produccion ni paquetes.

## Resultado y limite de este cierre

El nucleo de suscripciones/webhooks y el checkout de Chrome clean quedaron implementados y validados localmente: 200 grupos de pruebas PASS.
NO es una autorizacion de despliegue ni un cierre comercial integral.

Hay un bloqueo de integracion explicito: Audit de pago unico, Lab y los enlaces publicos de la web siguen usando checkouts sin la nueva asociacion verificada. Una compra nueva desde esos enlaces no se acreditara automaticamente por email con este backend. El backend admite pedidos Audit correctamente vinculados, pero no se modifico su apertura de checkout en Audit porque ese producto esta fuera del alcance autorizado. La pregunta para autorizar exclusivamente ese cambio sigue pendiente.

Las suscripciones pagas existentes sin relacion verificada tambien necesitan conciliacion previa al cutover. No se migraron por coincidencia de email ni se concedio premium automaticamente.

## Maquina de estados y entitlement

| Estado real de Lemon | Acceso efectivo | Observacion |
| --- | --- | --- |
| active | Premium de la variante autorizada | Restaura el plan al recuperar pago/despausar. |
| on_trial | Premium mientras trial_ends_at sea futuro | Sin fecha valida no se aplica una transicion incompleta. |
| past_due | Conserva el entitlement actual | No se inventa acceso premium para una cuenta que no lo tenia. |
| unpaid | Free | Conserva subscription, plan facturado e historial; no borra la cuenta. |
| paused, mode=free | Premium | Regla comercial expresamente confirmada. |
| paused, mode=void | Free temporal | Active posterior restaura la variante vigente. |
| cancelled | Premium solo mientras ends_at > ahora | No equivale a perdida inmediata ni permite acceso despues de ends_at. |
| expired | Free | Estado facturado conservado. |

`billing_status` conserva el estado real; `status` sigue siendo el indicador de acceso que utiliza la matriz existente. El plan efectivo Free se calcula con los entitlements actuales, sin duplicar sus limites en Lemon.

La comprobacion server-side de ends_at/trial_ends_at ocurre dentro del RPC de acceso, incluso sin webhook de expiracion. renews_at se guarda pero no se utiliza como fecha de revocacion.
Los atributos y estados oficiales se contrastaron con [Subscription object](https://docs.lemonsqueezy.com/api/subscriptions/the-subscription-object). Las decisiones de past_due, unpaid y pausa son las autorizadas por el usuario, no una politica comercial atribuida al proveedor.

## Mapping autorizado, mensual y anual

Se conservaron los IDs existentes; NO estan contrastados contra el Dashboard real.

| Clave del servidor | Product ID | Variant ID | Plan | Intervalo |
| --- | --- | --- | --- | --- |
| starter_monthly | 1073703 | 1683122 | Starter | month |
| starter_yearly | 1073699 | 1683117 | Starter | year |
| pro_monthly | 1073694 | 1683111 | Pro | month |
| pro_yearly | 1073685 | 1683097 | Pro | year |
| agency_monthly | 1073671 | 1683071 | Agency | month |
| agency_yearly | 1073676 | 1683081 | Agency | year |

El catalogo server-side solo acepta una variante explicita con su product ID correcto. Los nombres del proveedor, el texto Agency y product IDs conocidos con variante desconocida NO autorizan premium.
Variantes desconocidas se ignoran con diagnostico acotado; una sincronizacion que no puede identificar la variante falla sin conceder un plan nuevo.

Starter mantiene 300 acciones / 5 Audit; Pro 800 / 10; Agency 3000 / 30. Anual usa esos mismos cupos mensuales, nunca un pool multiplicado por 12. Free sigue 20 / 1 y 3 paginas por Audit. No cambiaron precios, paginas, branding ni features.

El mecanismo anterior usa billing_cycle_start + un mes y reset lazy al consultar acceso, no mes calendario global ni renews_at. Se preservo. Upgrade/downgrade real aplica la variante nueva sin borrar consumo; si el nuevo limite es menor que used, remaining queda en cero. Un downgrade futuro no se inventa a partir de nombres: se espera el cambio real de variante, o la expiracion correspondiente. Prorrateo financiero queda en Lemon.

## Flujo y autoridad

1. `POST /api/lemon/checkout`: sesion autentica verificada; cliente envia exclusivamente productKey del catalogo aprobado.
2. PostgreSQL guarda un hash de token aleatorio, usuario interno, tienda, producto, variante y familia. El token permite una asociacion de compra, no declarar un plan.
3. Se devuelve el link configurado con custom data opaca. Email es solo prellenado y nunca prueba de propiedad.
4. `POST /api/lemon/webhook`: HMAC del RAW BODY; formato exactamente 64 caracteres hexadecimales; comparacion timing-safe. Firma ausente, basura final, cuerpo alterado y firma invalida se rechazan antes de mutaciones.
5. Tienda, recurso, customer y variante/producto se validan. La primera subscription necesita el vinculo opaco; actualizaciones posteriores usan la relacion interna persistida.
6. Transicion y receipt quedan en una misma transaccion PostgreSQL; service_role es la unica autoridad de ejecucion de RPCs. Ante fallo de DB, 503 sin confirmar el evento.

La firma se contrasto con [Signing requests](https://docs.lemonsqueezy.com/help/webhooks/signing-requests). Lemon devuelve custom data en los eventos de pedidos/suscripciones segun [Passing custom data](https://docs.lemonsqueezy.com/help/checkout/passing-custom-data); no se presupone que las facturas la traigan.

La relacion store/customer queda vinculada a auth_user_id. La subscription referencia la fila interna del usuario y customer verificado. Una subscription/customer de A no puede reasignarse a B mediante metadata, email, checkout diferente ni body del cliente. Cambios de email no redefinen esa relacion.
Una segunda subscription distinta mientras la actual sigue activa se rechaza para revision; no se decide una politica de cobro doble.

## Eventos, idempotencia y orden

| Evento | Tratamiento |
| --- | --- |
| subscription_created / updated / cancelled / expired / resumed / paused / unpaused | Persistir el objeto de subscription validado y aplicar la maquina de estados. |
| subscription_payment_success / failed / recovered | Consultar el estado actual de la subscription mediante API; el ID de la factura NO es el subscription ID. Un paid de factura no puede reactivar por si solo una subscription expired. |
| order_created de SaaS | No concede plan; lo hace el evento de subscription. |
| order_created de Audit/extra | Acreditar una sola vez mediante el accounting existente despues de verificar identidad de checkout. |
| order_refunded / subscription_payment_refunded | Registrar importe/estado de refund para revision; no cambiar acceso. |
| Otros eventos | Ignorar de forma controlada. |

Los eventos se contrastaron con [Event types](https://docs.lemonsqueezy.com/help/webhooks/event-types). La forma de factura y subscription_id se comprobaron con [Subscription invoice object](https://docs.lemonsqueezy.com/api/subscription-invoices/the-subscription-invoice-object); no se inventa un order_id en una factura.

La clave estable combina evento, tipo/ID del recurso, tienda, updated_at normalizado y el importe cuando es refund. data.id identifica un recurso, no una entrega. Diferencias de whitespace no duplican la transicion.
Lock transaccional y receipt persistido impiden doble aplicacion entre dos procesos. No hay Set/Map en memoria como autoridad. El receipt no se escribe antes de que la transicion quede persistida.

updated_at mas viejo nunca revierte estado. Una entrega contradictoria con la misma version no gana por llegar ultima: deja pendiente una consulta canonica a la API. Solo el loader privado del servidor puede marcar una lectura como autoritativa para resolver esa igualdad; atributos homonimos en el webhook se descartan. Una lectura API mas vieja tampoco retrocede estado.

## Webhook perdido y errores

Antes de acceso/usage/capacidad y generacion con suscripcion, una lectura API se permite como maximo cada cinco minutos por subscription mediante claim/lease PostgreSQL compartido. No existe polling global ni un cron nuevo.
Dos procesos concurrentes realizan una verificacion; otro request puede recibir 503 billing_sync_pending sin iniciar proveedor ni consumir cupo. Los estados de billing no se convierten a Free ante una excepcion de API.
Una caida, customer/store ajenos, variante desconocida o API no configurada bloquean la verificacion pendiente sin conceder permiso por datos no verificados. El claim se libera o expira; no hay un bucle arbitrario de retries.
La ventana de cache permite hasta cinco minutos de retraso en descubrir una suspension cuyo webhook se perdio. ends_at conocido no depende de esa ventana: se impone en acceso SQL.

Filas pagas legacy sin vinculo retornan billing_association_required antes de generacion, conservando sus datos. Esto requiere un plan de conciliacion verificada ANTES de desplegar; no es compatible a ciegas con toda la base anterior.

Los logs de produccion son eventos/razones acotadas. No incluyen payload, email, signature, tokens, headers, clave API ni excepciones SQL. Los errores SQL que muestran las pruebas negativas pertenecen exclusivamente al worker local de fixtures.

## Refunds y gestion de cuenta

Refund parcial y completo quedan registrados sin revocacion automatica. `refund entitlement automation` sigue siendo politica futura. No se implementaron chargebacks ni reglas financieras adicionales.
El boton de gestion existente abre la web de planes; no habia portal de cliente real implementado. No se agrego un portal ni una API de cancelacion. Las cancelaciones y reanudaciones recibidas del proveedor se resuelven por los eventos verificados.

## Archivos de producto modificados

- `/Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/zentra-backend/release-lemon.js` (nuevo): catalogo seguro, firma, checkout, eventos y reconciliacion acotada.
- `/Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/zentra-backend/supabase-lemon.sql` (nuevo): tablas privadas, transiciones/receipts, identidad y wrappers de acceso/payment, permisos y reload del cache PostgREST.
- `/Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/zentra-backend/server.js`: wiring de billing antes del guard, nueva ruta de checkout y reemplazo del handler webhook; helpers legacy de firma/mapping endurecidos. Cambios anteriores preservados.
- `/Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/zentra-backend/release-security.js`: solo incorporacion de `/api/lemon/checkout` a las rutas autenticadas existentes; sin cambio de CORS/rate.
- `/Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/publicacion/chrome-store/zentra-ai-chrome-store-clean/popup.js`: solo apertura de checkout autenticado para planes/extras; sin fallback al link publico, sin cambios visuales/chat/scroll.

QA bajo `/Users/cristiangatica/Documents/Codex/2026-06-29/po/outputs/release-test-runtime/`:

- `lemon.test.mjs`, `lemon-worker.mjs` (nuevos).
- `backend-auth-boundaries.test.mjs`: firma estricta y adaptador de fixture Chrome; no cambio de limites esperados.
- `quota.test.mjs`: billing migration aplicada; fixtures de subscription usan identidad nueva y past_due autorizado, no el RPC email-only retirado.
- `quota-multiprocess.test.mjs`, `plan-entitlements.test.mjs`, `http-boundary.test.mjs`: migracion billing aplicada antes de las regresiones existentes; comprobacion del orden de reconcile.
- `lemon-subscriptions-report.md`, `lemon-validation.json`: informe y registro de validacion.

## Migracion local y orden

Se aplico exclusivamente a PostgreSQL efimero de pruebas; no a Supabase ni produccion.

Orden completo: `supabase-users.sql` -> `supabase-release-guard.sql` -> `supabase-execution-guard.sql` -> `supabase-http-rate.sql` -> `supabase-lemon.sql`.
La migracion Lemon aplicada dos veces es repetible. Renombra y conserva la funcion previa de acceso/accounting, envolviendola solo con enforcement de billing/identidad. Nuevas tablas tienen RLS; funciones internas/core no son ejecutables por anon/authenticated. La regresion multiproceso comprobo todas las funciones zentra_*.

IMPORTANTE: las funciones guard previas quedan congeladas en los wrappers `_before_lemon`. No volver a aplicar las migraciones base por encima de Lemon en un cutover ni asumir que reejecutar Lemon incorpora cambios futuros de esas funciones. Una futura actualizacion del core requiere una migracion explicita que preserve los wrappers. No se refactorizo el core ya cerrado.

## Pruebas finales

Auth/Lemon/proveedores simulados; PostgreSQL real efimero, dos procesos Node independientes. No se hicieron compras ni llamadas al proveedor real.

| Suite | Resultado |
| --- | --- |
| Lemon, firma, checkout, estados, asociacion, receipts, API, fechas iguales, ciclos | 54 grupos PASS |
| Auth boundaries | 14 grupos PASS |
| Planes/entitlements con migracion Lemon | 23 grupos PASS |
| HTTP/webhooks/guard con migracion Lemon | 15 grupos PASS |
| Quotas, chat/stream, JSON recovery y Audit reservation con migracion Lemon | 65 grupos PASS |
| Concurrencia multiproceso con migracion Lemon | 29 grupos PASS |
| Total | 200 grupos PASS |
| Sintaxis server/release-lemon/Chrome popup | PASS |
| git diff --check backend | PASS |
| Smoke del server real sin proveedores configurados | health=200, webhook sin configurar=503, checkout sin auth=401 |

Las comprobaciones incluyen 299/300 simultaneo, quinta/sexta Audit Starter, diez entregas iguales entre procesos, receipt no confirmado ante DB failure, replays sin reset, variantes mensuales/anuales, lectura API unica, refund sin cambio y el bloqueo de asociaciones ajenas.

En una pasada intermedia fallo la comprobacion global de permisos: el wrapper recreado de zentra_apply_payment tenia EXECUTE publico por defecto. Se agregaron REVOKE/GRANT explicitos y se repitieron las seis suites; el resultado final no tiene fallos.
La comparacion con chrome-audit-crawl-validation.json conserva 37/40 fuentes inventariadas: solo difieren server.js, release-security.js y Chrome popup.js. PDF, crawl, builders, reservas, JSON recovery, entitlements, chat, Lab y Audit estan intactos respecto de ese inventario.

## Requisitos de staging/predeploy y decisiones pendientes

- Verificar manualmente todos los pares product/variant y destinos de checkout, incluidos anual, Audit y extras, contra Lemon Dashboard. Los fixtures no certifican su existencia real.
- Verificar importes/cobro anual y moneda; no se dedujeron del equivalente mensual mostrado ni se cambiaron precios.
- Configurar `LEMON_SQUEEZY_STORE_ID`, `LEMON_SQUEEZY_WEBHOOK_SECRET`, `LEMON_SQUEEZY_API_KEY` en backend, ademas de Supabase service role. No exponerlos en Chrome.
- `LEMON_ALLOW_TEST_WEBHOOKS=true` solo en pruebas controladas. Por defecto eventos test se ignoran y una lectura API test no habilita acceso live.
- Configurar el endpoint `/api/lemon/webhook` con eventos de subscription, pagos y refunds mencionados; confirmar firma y recurso real en staging.
- Aplicar las migraciones anteriores y Lemon en el orden documentado; comprobar RPC/shape PostgREST y permisos reales.
- Backend y checkout de Chrome requieren cutover coordinado. Chrome nuevo contra backend viejo no puede obtener el vinculo de compra.
- Adaptar el checkout de Audit/Lab/web antes de ofrecer compras con este backend. Se requiere autorizacion puntual para Audit; no se toco su generacion ni se acepta email como solucion provisional.
- Conciliar de forma verificada usuarios pagados legacy y sus store/customer/subscription IDs, incluidos los administrativos. No hay importador ni migracion automatica por email.
- Validar devolucion de custom data en una compra real de staging y estados/fechas de cancelacion/pausa/trial. No se afirma que un test local sustituya esa prueba.
- Refund automation, conflictos de dos subscriptions activas y chargebacks quedan para revision/politica futura, sin reglas financieras inventadas.

NO hubo commit, push, deploy, publicacion, SQL de produccion ni packaging. HEAD sigue a8e5af81a5b15ec0734aa43e5f218e96e919dd78. Los pendientes locales anteriores siguen preservados.
