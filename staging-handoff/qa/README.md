# Fixtures aprobados para el backend staging

Copias exactas de las pruebas locales aprobadas, no un runner nuevo ni codigo cargado por server.js. Render instala solo el package.json raiz; este directorio NO forma parte del runtime. No ejecutar fixtures contra una base real.

Las suites SQL usan PostgreSQL efimero mediante embedded-postgres, con auth/proveedores simulados. Algunas necesitan la jerarquia externa original de Chrome clean/Lab/Audit y construyen rutas a partir del padre del backend. Por eso el repo backend, por si solo, no promete una regresion completa de clientes desde un clone arbitrario. Sus hashes de referencia estan en ../source-manifest.json. No se copian clientes ni dependencias/node_modules.

Para una futura corrida local autorizada: instalar las dependencias QA de este directorio con su lockfile, instalar el backend raiz, y configurar ZENTRA_BASE con el directorio que contiene las tres variantes aprobadas y zentra-backend; ZENTRA_BACKEND_DIR con ese backend; ZENTRA_TEST_PG_MODULE con la URL file: del pg/esm/index.mjs del entorno QA. Los workers heredan esas rutas. No colocar estas ENV en Render ni usar connection strings Supabase/production. Los puertos efimeros de las suites pueden exigir ejecucion serial.

La prueba sin DB que si puede ejecutarse desde este repo independiente es:

```sh
node --test release-competitive-search.test.js
```

Los resultados previos se conservan en ../validation. La copia no modifica assertions, fixtures ni controles de consumo y no habilita pruebas automaticas ni migraciones en Render.
