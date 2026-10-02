import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const deps=createRequire(process.env.ZENTRA_QA_RUNTIME || import.meta.url);
const {JSDOM}=deps('jsdom');

const base=process.env.ZENTRA_CHAT_ROOT || '/Users/cristiangatica/Downloads/IA/Zentra AI/ZENTRA FINALES/publicacion/chrome-store/zentra-ai-chrome-store-clean';
const source=await readFile(base+'/claude-pdf-generator.js','utf8');
const dom=new JSDOM('<!doctype html><body></body>',{url:'https://audit.test',runScripts:'outside-only'});
const {window}=dom;
let now=Date.now(), tick, resolveAnalysis, rejectAnalysis, saved={}, consumed=0, downloaded=0;
const realDate=window.Date;
window.Date=class extends realDate {constructor(...args){super(...(args.length?args:[now]));} static now(){return now;}};
window.setInterval=callback=>{tick=callback;return 1;};
window.clearInterval=()=>{tick=null;};
window.setTimeout=(callback,delay)=>{if(delay===1000) callback();return 1;};
window.console={log(){}};
window.jspdf={jsPDF:class{}};
window.chrome={
  storage:{local:{set(value,cb){Object.assign(saved,value);cb();},get(keys,cb){cb(saved);},remove(key,cb){delete saved[key];cb();}}},
  tabs:{query:async()=>[{id:1}]},
  runtime:{sendMessage:async()=>({success:true,page:{url:'https://audit.test',title:'Audit test'}})}
};
window.zentraSubscription={getUserState:async()=>({plan:'agency'}),canGenerateAudit:()=>({allowed:true}),consumeAudit:async()=>{consumed++;}};
window.zentraOperations={begin(){},reserveAudit:async()=>{},releaseAudit:async()=>{},end(){}};
window.claudeAI={
  getStatus:async()=>({isReady:true}),getAuditScope:()=>({totalPages:11}),
  analyzeSEO:(_data,onProgress)=>new Promise((resolve,reject)=>{resolveAnalysis=resolve;rejectAnalysis=reject;onProgress('structure');})
};
window.eval(source);
const g=window.claudePDFGenerator;
g.createPDF=async()=>new window.Blob(['test']);
g.downloadPDF=async()=>{downloaded++;return 123;};
const flush=async()=>{
  for(let i=0;i<80;i++) await Promise.resolve();
  let deadline;
  try {
    await Promise.race([g.pendingAuditWrite, new Promise((_, reject) => {
      deadline=setTimeout(()=>reject(new Error('Harness storage did not settle: '+JSON.stringify({
        generating:g.isGenerating, phase:g.progressPhase, status:saved['zentra-audit-pending-job']?.status
      }))),2000);
    })]);
  } finally {clearTimeout(deadline);}
  for(let i=0;i<80;i++) await Promise.resolve();
};
const start=()=>g.generateAIReport(1,{pageData:{url:'https://audit.test',selectedInternalUrls:['https://audit.test/a']}});
const jobKey='zentra-audit-pending-job';
const analysis={success:true,analysis:{recommendations:[],keywords:{}}};
try {
  const pending=start();
  await flush();
  assert.equal(typeof resolveAnalysis,'function');
  assert.equal(window.document.querySelector('#progress-text').textContent,'Analizando estructura SEO...');
  assert.equal(g.isGenerating,true);
  assert.equal(g.progressStageCeiling,49);
  assert.equal(saved[jobKey].status,'running');
  for(let elapsed=0;elapsed<180000;elapsed+=180){now+=180;tick();}
  assert.ok(g.progressValue>42 && g.progressValue<49);
  assert.equal(g.isGenerating,true);
  assert.equal(downloaded,0);
  console.log('PASS: pending promise stays alive for 180 simulated seconds with phase label unchanged and continuous bounded progress');
  resolveAnalysis(analysis);
  await flush();assert.ok(g.progressCompletion, 'Completion animation starts after generation and storage settle');now+=800;tick();
  await pending;
  assert.equal(g.isGenerating,false);
  assert.equal(g.progressValue,100);
  assert.equal(saved[jobKey],undefined);
  assert.equal(window.document.querySelector('#claude-progress-indicator'),null);
  assert.equal(tick,null);
  assert.equal(consumed,1);
  assert.equal(downloaded,1);
  console.log('PASS: completion after wait reaches download, clears saved job and removes modal');

  const failing=start();await flush();rejectAnalysis(new Error('controlled request timeout'));await failing;
  assert.equal(g.isGenerating,false);
  assert.equal(saved[jobKey],undefined);
  assert.equal(tick,null);
  assert.match(window.document.querySelector('#claude-message').textContent,/controlled request timeout/);
  console.log('PASS: rejected analysis reports error and cleans up; no silent pending modal');

  const uncertain=start();await flush();
  const unknown=new Error('La auditoria sigue pendiente de confirmacion.');unknown.code='execution_uncertain';
  rejectAnalysis(unknown);await uncertain;
  assert.equal(saved[jobKey].status,'running');
  assert.equal(g.isGenerating,false);assert.equal(downloaded,1);
  console.log('PASS: uncertain supplier preserves saved audit/resume; does not create a fallback PDF');

  let finishDownload;
  g.downloadPDF=()=>new Promise(resolve=>{finishDownload=resolve;});
  const saving=start();await flush();resolveAnalysis(analysis);await flush();
  assert.equal(typeof finishDownload,'function');
  assert.equal(saved[jobKey].status,'pdf_ready','The audit must be terminal before Chrome opens Save As');
  g.saveProgressCheckpoint(true);await flush();
  assert.equal(saved[jobKey].status,'pdf_ready');
  window.dispatchEvent(new window.Event('pagehide'));await flush();
  const reopened=new g.constructor();
  let unexpectedResume=0;
  reopened.generateAIReport=async()=>{unexpectedResume++;};
  await reopened.resumePendingAuditIfNeeded();
  assert.equal(unexpectedResume,0,'Reopening while Save As is pending must not regenerate the audit');
  assert.equal(saved[jobKey].status,'pdf_ready');
  finishDownload(123);await flush();await saving;
  assert.equal(consumed,2,'Only the two successful audits consume a unit');
  assert.equal(saved[jobKey],undefined);
  console.log('PASS: pending Save As and popup close preserve PDF_READY without restarting or extra consumption');

  for(const status of ['pdf_ready','PDF_READY','completed','COMPLETED']){
    saved[jobKey]={operationId:'done-operation',startedAt:new realDate(now).toISOString(),status,tabId:1};
    await reopened.resumePendingAuditIfNeeded();
    assert.equal(unexpectedResume,0,status);
    assert.equal(saved[jobKey].status,status,'Keep completed state independent of popup lifecycle');
  }
  console.log('PASS: completed and PDF-ready records never resume');

  saved[jobKey]={operationId:'test-operation',selectedUrls:['https://audit.test/a'],startedAt:new realDate(now).toISOString(),status:'running',tabId:1};
  let resumed=null;
  g.generateAIReport=async(tabId,options)=>{resumed={tabId,options};};
  await g.resumePendingAuditIfNeeded();
  assert.equal(resumed.options.operationId,'test-operation');
  assert.match(window.document.querySelector('#claude-message').textContent,/Retomando auditoría SEO/);
  console.log('PASS: fresh saved job alone triggers resume; running is not a heartbeat');
  saved[jobKey].status='error';resumed=null;
  await g.resumePendingAuditIfNeeded();
  assert.equal(resumed.options.operationId,'test-operation','An existing recoverable error keeps the same resume path');
  console.log('PASS: a saved recoverable error retains the existing resume behavior');
  resumed=null;now+=16*60*1000;
  await g.resumePendingAuditIfNeeded();
  assert.equal(resumed,null);
  assert.equal(saved[jobKey],undefined);
  console.log('PASS: stale job older than 15 minutes is removed, not resumed');
} finally {dom.window.close();}
