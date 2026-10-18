// Narrow configuration regression only; no previous suites or providers.
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {execFile,execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const root=fileURLToPath(new URL('../../',import.meta.url));
const runtime=process.env.ZENTRA_LOCAL_PG_RUNTIME;
assert.ok(runtime,'Use the existing installed local PostgreSQL test runtime');
const {Client}=createRequire(import.meta.url)(path.join(runtime,'node_modules/pg'));
const bin=path.join(runtime,'node_modules/@embedded-postgres',process.platform+'-'+process.arch,'native/bin');
const run=promisify(execFile);
const source=await readFile(path.join(root,'release-candidate/migrations/01-production-schema.sql'),'utf8');
const original=execFileSync('git',['show','d2184e28b0b93e9966ac51ec4daa07dcaae42d35:release-candidate/migrations/01-production-schema.sql'],{cwd:root,encoding:'utf8'});
const moduleOf=s=>s.split('execute $rc_module_7$')[1].split('$rc_module_7$;')[0];
const config=/create table if not exists public\.zentra_free_launch_config \([\s\S]*?on conflict do nothing;/;
const configSQL=moduleOf(source).match(config)[0];
assert.equal(moduleOf(source).replace(config,''),moduleOf(original).replace(config,''),
  'Free activation/waitlist/notification/status/consumption logic must stay byte-identical');
assert.match(moduleOf(source),/actions:=greatest\(0,20-u\.actions_used\); audits:=greatest\(0,1-u\.audits_used\)/);
console.log('PASS existing Free activation, waitlist, notification and 20/1 rules unchanged');

const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));
const port=listener.address().port;await new Promise(r=>listener.close(r));
const tmp=await mkdtemp(path.join(os.tmpdir(),'zentra-free-capacity-'));
const database=path.join(tmp,'db');let started=false,db;
try {
  await run(path.join(bin,'initdb'),['-D',database,'-A','trust','-U','postgres','--no-locale','-E','UTF8','--no-sync'],{timeout:60000});
  await run(path.join(bin,'pg_ctl'),['-D',database,'-l',path.join(tmp,'postgres.log'),'-o','-h 127.0.0.1 -p '+port,'-w','start'],{timeout:20000});started=true;
  db=new Client({host:'127.0.0.1',port,user:'postgres',database:'postgres'});await db.connect();
  await db.query(configSQL);
  assert.deepEqual((await db.query('select * from zentra_free_launch_config')).rows,
    [{singleton:true,capacity_total:100,access_days:30,enabled:false,activated_total:0}]);
  console.log('PASS initial SQL configuration: 100 places, 30 individual days, OFF, zero activations');
  // Local fixture only: demonstrate that the existing administrative increase
  // does not reset counters, and bootstrap/replay does not overwrite that policy.
  await db.query('update zentra_free_launch_config set activated_total=7,capacity_total=150 where singleton');
  await db.query(configSQL);
  assert.deepEqual((await db.query('select * from zentra_free_launch_config')).rows,
    [{singleton:true,capacity_total:150,access_days:30,enabled:false,activated_total:7}]);
  console.log('PASS later manual capacity increase/replay preserves activations, duration and disabled state');
  console.log('RESULT 3/3 focused checks; local disposable PostgreSQL only; zero provider calls');
} finally {
  if(db)await db.end();
  if(started)await run(path.join(bin,'pg_ctl'),['-D',database,'-m','fast','-w','stop'],{timeout:20000});
  await rm(tmp,{recursive:true,force:true}); // Only this exact synthetic fixture.
}
