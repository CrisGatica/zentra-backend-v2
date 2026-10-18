// Only the new read-only presentation is tested. Never executes migration 01.
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {createRequire} from 'node:module';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const runtime=process.env.ZENTRA_LOCAL_PG_RUNTIME;assert.ok(runtime);
const {Client}=createRequire(import.meta.url)(path.join(runtime,'node_modules/pg'));
const bin=path.join(runtime,'node_modules/@embedded-postgres',process.platform+'-'+process.arch,'native/bin');
const run=promisify(execFile);
const original=await readFile(new URL('../migrations/00-required-catalog.sql',import.meta.url),'utf8');
const combined=await readFile(new URL('../migrations/00-required-catalog-single-result.sql',import.meta.url),'utf8');
const baseline=JSON.parse(await readFile(new URL('../migrations/production-baseline.json',import.meta.url),'utf8'));
const labels=['column_differences','function_differences','baseline','execution_role','zentra_functions_all_schemas','users_constraints','users_indexes'];
const statements=original.replace(/^--.*$/gm,'').trim().split(/;\s*(?:\r?\n|$)/).map(s=>s.trim()).filter(Boolean).filter(s=>!/^begin read only$|^rollback$/i.test(s));
assert.equal(statements.length,7);
for(const [i,statement] of statements.entries())assert.ok(combined.includes('check_'+i+' as (\n'+statement+'\n)'),'Security check '+i+' changed');
const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
const tmp=await mkdtemp(path.join(os.tmpdir(),'zentra-preflight-only-')),database=path.join(tmp,'db');let started=false,db,passed=0;
const pass=s=>{passed++;console.log('PASS '+s);};
try{
  await run(path.join(bin,'initdb'),['-D',database,'-A','trust','-U','postgres','--no-locale','-E','UTF8','--no-sync'],{timeout:60000});
  await run(path.join(bin,'pg_ctl'),['-D',database,'-l',path.join(tmp,'postgres.log'),'-o','-h 127.0.0.1 -p '+port,'-w','start'],{timeout:20000});started=true;
  db=new Client({host:'127.0.0.1',port,user:'postgres',database:'postgres'});await db.connect();
  await db.query('create role anon;create role authenticated;create role service_role');
  await db.query('create table public.users('+baseline.columns.map(c=>c.column_name+' '+c.data_type).join(',')+')');
  const compare=async expected=>{
    const before=(await db.query(original)).filter(r=>r.command==='SELECT');
    const after=(await db.query(combined)).filter(r=>r.command==='SELECT');
    assert.equal(before.length,7);assert.equal(after.length,1);assert.equal(after[0].rows.length,1);
    const report=after[0].rows[0].preflight_result;assert.equal(report.read_only,true);assert.equal(report.result_sets,7);assert.equal(report.decision,expected);
    const sorted=rows=>rows.map(r=>JSON.stringify(Object.fromEntries(Object.entries(r).sort()))).sort();
    for(const [i,key] of labels.entries())assert.deepEqual(sorted(report[key]),sorted(before[i].rows),'Missing/altered results: '+key);
  };
  await compare('LEGACY_BASELINE_COMPATIBLE');pass('one JSON row preserves all seven original result sets on the production CSV baseline');
  await db.query('alter table users alter column audits_used type bigint');await compare('STOP_REVIEW');
  await db.query('alter table users alter column audits_used type integer');pass('type mismatch retains every result and requires STOP');
  await db.query('create schema fixture;create function fixture.zentra_access() returns int language sql as $$select 1$$');await compare('STOP_REVIEW');
  await db.query('drop function fixture.zentra_access();drop schema fixture');pass('other-schema implementation requires STOP without dropping any check');
  await db.query('alter table users add constraint users_email_key unique(email)');await compare('STOP_REVIEW');
  await db.query('alter table users drop constraint users_email_key');pass('conflicting legacy uniqueness requires STOP');
  await db.query('create function public.zentra_partial_fixture() returns int language sql as $$select 1$$');await compare('STOP_REVIEW');
  pass('partial schema requires STOP; no migration, providers or production access');
  console.log('RESULT '+passed+'/'+passed+' preflight-only checks');
}finally{
  if(db)await db.end();if(started)await run(path.join(bin,'pg_ctl'),['-D',database,'-m','fast','-w','stop'],{timeout:20000});
  await rm(tmp,{recursive:true,force:true}); // Exact synthetic fixture only.
}
