ZENTRA AI v1.0.3 — DELTA PRODUCTIVO LOCAL, NO EJECUTADO

Confirmado por el propietario: main Live 5adc763, Auto-Deploy OFF, proyecto
ohakwaihhuenpensoedh; 8 cuentas propias de prueba, sin clientes externos.
Faltantes confirmados: zentra_lemon_customers y zentra_lemon_subscriptions.
La ausencia de otras columnas/RPC NO se deduce del SHA ni de esas dos tablas.

ORDEN Y CONDICIONES
1. Con autorización separada, ejecutar 00-required-catalog.sql en ese proyecto.
   Sólo SELECT de catálogos + READ ONLY/ROLLBACK; devuelve discrepancias de tipos,
   firmas, cuerpos/grants y topología. No consulta cuentas ni ejecuta RPC.
2. Si el resultado es LEGACY_USERS_ONLY, 01-production-schema.sql es el bootstrap
   transaccional preparado para ese baseline. Si existen objetos zentra_* previos,
   NO ejecutar sobre ellos: el instalador aborta y hay que seleccionar el delta
   con el catálogo real. Nunca sobrescribir wrappers por un replay genérico.
3. Antes de aplicar: exportar esquema/funciones/grants originales y registrar
   backup recuperable, SHA/deploy ID Live; comprobar que no hay operaciones ni
   entregas webhook en curso. No abrir compras nuevas durante el cutover.
4. Aplicar 01 sólo tras autorización, conectado al proyecto verificado. No se
   ejecuta desde npm start/build, Render pre-deploy ni ningún endpoint.
5. Comprobar 00: sin discrepancias, más RLS/tablas privadas y el marker de release.
   Verificar firma/configuración real Lemon y que el checkout público del
   lanzamiento use la ruta autenticada /api/lemon/checkout. Enlaces estáticos
   anteriores sin binding NO deben vender como si la acreditación fuera automática.
6. Sólo entonces desplegar el nuevo SHA backend aprobado; confirmar Live/health
   y arranque. Publicación de extensión 1.0.3 requiere autorización posterior.

DEPENDENCIAS INCLUIDAS, EN ORDEN
- users: sólo columnas/índices faltantes; no backfill de identidades ni cuentas.
- Guard de consumo/recibos/Chat/Audit, seguido por leases/adquisición/Search.
- Rate-limit HTTP; liberación premium definitiva; recuperación ejecutiva;
  lifecycle Search; binding Lemon; wrapper Free Launch al final.
Son las dependencias de los endpoints ya presentes en el RC, no funciones nuevas.
Se omiten SQL de audio STAGING y la versión supersedida del refiner premium.
Instalación completa: 17 tablas funcionales + ledger de migración; 40 firmas
RPC incluyendo cores internos. required-schema.json fija tipos/cuerpos esperados.
La lista de FALTANTES reales la produce 00, no esta cantidad de dependencias.

PROTECCIONES
- Una transacción, lock/statement timeout, índices únicos y rechazo de identidad
  duplicada/tipos inesperados/contadores inválidos, sin corregir datos a ciegas.
- Marker transaccional: segunda aplicación no reejecuta wrappers ni modifica
  datos. Si cambian definiciones/grants o faltan objetos, aborta, no los pisa.
- RLS y RPC sólo servidor; todos los parámetros unlimited de este artefacto
  productivo rechazan true y null. STAGING original permanece sin cambios.
- Ningún UPDATE/INSERT sobre cuentas se ejecuta durante la instalación. Los
  UPDATE dentro de cuerpos RPC pertenecen al uso normal posterior autorizado.
- No se crea ningún mapping Lemon para las 2 Agency de prueba. Quedan bloqueadas
  si no tienen asociación legítima; no se cancela ni modifica su pago/plan.
- En uso normal, la identidad se resuelve desde Auth verificado ANTES de comprobar
  billing, evitando el hueco de primera petición de una fila legacy sin auth id.
- Compra nueva: checkout autenticado -> token opaco guardado como hash -> webhook
  con HMAC/tienda/variante/fechas válidas -> vínculo cliente/suscripción/usuario.
  Replay no duplica; email ni un plan del cliente conceden entitlement.

CONTABILIDAD PDF
Base aprobada: Pro 10 / Agency 30 auditorías por ciclo, sin cambios a otros planes.
Se alineó PREMIUM_LIMITS a 10/30; extensión y SQL ya usan ese contrato. Todas las
fases comparten el mismo recibo por operación. 30/80 eran contadores por llamada,
no un derecho demostrado a 30/80 auditorías completas nuevas.
Los números legacy se conservan literalmente: no se dividen, resetean o convierten
en recibos inventados. Si superan el cap nuevo, premium remaining queda en cero
hasta renovación normal; no se bloquea por ello todo PDF técnico. El cupo base,
extras y branding mantienen su propia autorización. No se inventa una equivalencia
sin historial por operación. No hay clientes externos afectados según lo confirmado.

RECUPERACIÓN
- Error antes de COMMIT: ROLLBACK completo; no continuar con el deploy. Si el editor
  deja la sesión abortada, ejecutar ROLLBACK y corregir únicamente el error observado.
- Error después de COMMIT: no hay down destructivo automático. Conservar tablas,
  recibos y mappings; corregir hacia adelante o restaurar definiciones desde el
  export previo sólo con revisión y autorización. No reponer backups sobre pagos.
- Si falla el deploy, usar el deploy Render anterior registrado. El rollback de
  código no revierte SQL y el backend viejo no garantiza el contrato nuevo de
  billing/idempotencia: no reabrir compras/clientes con una combinación incompatible.
- Tras compras nuevas, preferir hotfix compatible con los recibos/bindings ya
  creados. No borrar cuentas, marcar recibos como no usados ni dar cuotas de prueba.

PRUEBAS FOCALES
production-schema.test.mjs: PostgreSQL local, 8 cuentas sintéticas, atomicidad,
replay/drift, preservación, bindings firmados, 10/30/idempotencia y rutas compartidas.
lemon-legacy-identity.test.mjs: primera petición legacy y exclusión de audit/no Auth.
Sólo 2 tests afectados de production-candidate.test.mjs; no repetir los otros 40.
No proveedores, SQL remoto, migraciones productivas ni datos privados en fixtures.
