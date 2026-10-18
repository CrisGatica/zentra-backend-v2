ZENTRA AI v1.0.3 — DELTA PRODUCTIVO LOCAL, NO EJECUTADO

Confirmado por el propietario: main Live 5adc763, Auto-Deploy OFF, proyecto
ohakwaihhuenpensoedh; 8 cuentas propias de prueba, sin clientes externos.
Evidencia CSV posterior: una fila TABLA/users, 20 columnas; nombres y tipos
contrastados contra el fixture local sin diferencias. production-baseline.json
conserva sólo esos metadatos y el SHA256 del CSV (sin cuentas ni secretos).
Delta users: 14 columnas faltantes (Auth + billing/Lemon). No se vuelven a agregar
los contadores ya existentes. El instalador verifica los 20 tipos antes de editar.
No hay objetos zentra_* en public según la consulta aportada por el propietario;
el CSV no acredita rol, índices/restricciones ni implementaciones en otros esquemas.
00 también comprueba esos datos mínimos. Nunca se infiere ausencia por visibilidad
limitada. El cliente backend usa public por defecto, sin redirección de esquema;
sus handlers JS llaman a RPC, no los implementan ni instalan automáticamente.

ORDEN Y CONDICIONES
Forma recomendada en Supabase SQL Editor: abrir el proyecto productivo
ohakwaihhuenpensoedh, rol postgres, pegar y ejecutar COMPLETO
00-required-catalog-single-result.sql. Conserva las siete consultas originales de
00-required-catalog.sql sin cambios y las devuelve en UNA fila JSON preflight_result.
Copiar la celda completa o exportar su CSV de una fila; no basta una captura parcial.
Debe indicar read_only=true y result_sets=7. LEGACY_BASELINE_COMPATIBLE permite
continuar con la autorización de migración (no la ejecuta ni autoriza por sí solo).
STOP_REVIEW, error, proyecto/rol incorrecto o salida incompleta exigen detenerse.
00-required-catalog.sql original sigue disponible; no ejecutar ambas versiones.

1. Con autorización separada, ejecutar 00-required-catalog.sql en ese proyecto.
   Sólo SELECT de catálogos + READ ONLY/ROLLBACK; devuelve discrepancias de tipos,
   firmas, cuerpos/grants, topología, rol, índices/restricciones y funciones zentra_*
   en todos los esquemas mediante pg_catalog. No consulta cuentas ni ejecuta RPC.
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

FREE — CAPACIDAD APROBADA, APERTURA PENDIENTE
La instalación queda cerrada: enabled=false, capacity_total=100, activated_total=0.
Política aprobada el 18/10/2026: 100 usuarios, 30 días individuales, 20 acciones
de Chat y 1 auditoría SEO. La migración no abre plazas ni inicia ningún plazo.
La apertura requiere autorización posterior explícita del propietario.
Mientras siga OFF, Chat/Audit Free devuelven espera sin consumir ni reclamar slot;
los planes pagos verificados no dependen de esa apertura. Reejecutar la migración
no modifica la configuración de Free que se haya aprobado posteriormente.
Se conserva la ampliación manual de capacity_total, sin reiniciar activated_total,
usuarios, plazos ni consumos. Lista de espera, mensajes y avisos sin cambios.

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
El paquete requiere 17 tablas funcionales y 40 firmas RPC nuevas para el baseline
users-only: bindings Lemon (clientes/checkouts/suscripciones/eventos), recibos,
reservas/etapas/leases, Search, rate limit y Free Launch ya presentes en el RC.
El ledger de esquema es adicional. No se incluyen audio ni objetos de Audit app.

PROTECCIONES
- Una transacción, lock/statement timeout, índices únicos y rechazo de identidad
  duplicada/tipos inesperados/contadores inválidos, sin corregir datos a ciegas.
- RPCs zentra_* en otro esquema hacen abortar: revisar antes de duplicarlos o
  cambiar permisos. El CSV public por sí solo no descarta esa posibilidad.
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
production-schema.test.mjs: 20 escenarios PostgreSQL 18.4 local con roles sintéticos
anon/authenticated/service_role. Ejecución completa de los dos archivos SQL (no
sólo texto), 8 cuentas y pagos sintéticos, CSV20/tipos, otro esquema, atomicidad,
replay/drift, preservación, bindings firmados, 5/10/30, permisos, Free OFF y rutas
compartidas. No replica Auth/PostgREST ni certifica la configuración Live de Supabase.
No se leyeron cuentas/pagos reales. Sin repetir las 42 pruebas anteriores.
lemon-legacy-identity.test.mjs: primera petición legacy y exclusión de audit/no Auth.
Sólo 2 tests afectados de production-candidate.test.mjs; no repetir los otros 40.
No proveedores, SQL remoto, migraciones productivas ni datos privados en fixtures.
Preflight single-result: 5 comprobaciones locales, conservando exactamente los
siete juegos de resultados originales. Sin ejecutar 01 en esa prueba.
