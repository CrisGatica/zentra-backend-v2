import crypto from 'node:crypto';
import { parseBuffer } from 'music-metadata';
import { File, FormData } from 'node-fetch';
import { normalizeConversationContext } from './release-conversation-context.js';
import { fetchAudioResponse, parseAudioTranscript } from './release-audio.js';
import { sendFreeAccessBlock } from './release-free-launch.js';
import { decodedAudioDuration } from './release-audio-duration.js';

export const AUDIO_MODEL = 'gpt-transcribe';
export const AUDIO_LIMITS = Object.freeze({ bytes:25*1024*1024, batchBytes:32*1024*1024, audioMs:600000, operationMs:900000, count:5 });
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export const audioKey = (auth,context,id) => hash(JSON.stringify([auth.userId,context.platform,context.contact.id,id]));
export const isAudioStaging = env => env.SUPABASE_URL === 'https://qfwmjgoiwketpkuhvixm.supabase.co';

export async function inspectAudio(encoded) {
  if (typeof encoded!=='string' || encoded.length>Math.ceil(AUDIO_LIMITS.bytes/3)*4
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('audio_invalid');
  const buffer=Buffer.from(encoded,'base64');
  if (!buffer.length || buffer.length>AUDIO_LIMITS.bytes || buffer.toString('base64')!==encoded) throw new Error('audio_invalid');
  let meta;
  try { meta=await parseBuffer(buffer,undefined,{duration:true,skipCovers:true}); }
  catch (_) { buffer.fill(0); throw new Error('audio_invalid'); }
  // Identify actual bytes, not client MIME/duration. Never decode/play media in the browser.
  const formats={ MPEG:['audio/mpeg','mp3'],WAVE:['audio/wav','wav'], Ogg:['audio/ogg','ogg'],
    WebM:['audio/webm','webm'],Matroska:['audio/webm','webm'],M4A:['audio/mp4','m4a'],MP4:['audio/mp4','mp4'],FLAC:['audio/flac','flac'] };
  const format=formats[meta.format.container];
  let durationMs;
  try { durationMs=await decodedAudioDuration(buffer); }
  catch(e){buffer.fill(0);throw e;}
  if (!format || meta.format.hasVideo || !Number.isSafeInteger(durationMs) || durationMs<=0) { buffer.fill(0); throw new Error('audio_invalid'); }
  if (durationMs>AUDIO_LIMITS.audioMs) { buffer.fill(0); throw new Error('audio_too_long'); }
  return {buffer,durationMs,mimeType:format[0],extension:format[1],binaryHash:hash(buffer)};
}

export function audioSelection(auth,input) {
  const context=normalizeConversationContext(input);
  if (!context?.contact.id) throw new Error('audio_context_invalid');
  const selected=[],excluded=[]; let total=0;
  // Only missing transcripts. Recent messages first within the bounded authorized snapshot.
  for (const message of [...context.messages].reverse()) {
    if (message.type!=='audio') continue;
    if (!message.id || message.audio?.native_status!=='unavailable') {
      excluded.push({id:message.id,reason:message.audio?.native_status==='available'?'native_available':'native_unknown'}); continue;
    }
    const duration=message.audio?.duration_ms;
    if (duration>AUDIO_LIMITS.audioMs) {excluded.push({id:message.id,reason:'audio_too_long'});continue;}
    if (selected.length>=5 || (duration&&total+duration>900000)) {excluded.push({id:message.id,reason:'audio_operation_limit'});continue;}
    total+=duration||0;
    selected.push({id:message.id,audio_key:audioKey(auth,context,message.id)});
  }
  return {context,selected,excluded};
}

export function cachedConversation(context,selection,cache) {
  const byId=new Map(selection.map(s=>[s.id,cache.find(c=>c.audio_key===s.audio_key && c.state==='done')]));
  return normalizeConversationContext({...context,messages:context.messages.map(m=>{
    const entry=byId.get(m.id);
    return entry?{...m,type:'audio_transcript',text:entry.transcript,source:'zentra_transcript',audio_id:m.id,
      audio:{...m.audio,duration_ms:entry.duration_ms},partial:entry.transcript.length>=6000}:m;
  })});
}

export function createAudioTranscriber({fetchImpl,apiKey}) {
  return async item => {
    const form=new FormData();
    form.append('file',new File([item.buffer],`conversation.${item.extension}`,{type:item.mimeType}));
    form.append('model',AUDIO_MODEL);
    form.append('languages[]','es');
    const {response,payloadText}=await fetchAudioResponse(fetchImpl,'https://api.openai.com/v1/audio/transcriptions',{
      method:'POST',headers:{Authorization:`Bearer ${apiKey}`},body:form},85000);
    const text=response.ok?parseAudioTranscript(payloadText,String(response.headers.get('content-type')||'')):null;
    if (!text) throw new Error('audio_provider_failed');
    return text.slice(0,6000);
  };
}

export function createConversationAudioHandlers({client,env=process.env,transcribe,providerReady=()=>true,log=event=>console.info('[conversation-audio]',JSON.stringify(event))}) {
  const emit=event=>{try{log(event);}catch(_){/* Observability must never replace a persisted transcript. */}};
  const rpc=async(name,args)=>{const r=await client.rpc(name,args);if(r.error)throw new Error('audio_store_unavailable');return r.data;};
  const args=(req)=>({p_auth_id:req.auth.userId,p_email:req.auth.email});
  const fail=(res,reason,status=409)=>res.status(status).json({success:false,code:reason,error:({
    audio_quota_exhausted:'Alcanzaste los minutos de transcripción disponibles para este mes.',
    audio_too_long:'El audio supera el máximo de 10 minutos.',audio_operation_limit:'Podés procesar hasta 5 audios y 15 minutos nuevos por operación.',
    audio_pending:'La transcripción está en curso o pendiente de confirmación. No volveremos a procesar ese audio.',
    audio_disabled:'La transcripción de conversaciones todavía no está habilitada.',
    usage_limit_reached:'Alcanzaste el límite de acciones de tu plan.'
  })[reason]||'No se pudo preparar la transcripción. Intentá nuevamente.'});
  const guard=(req,res)=>{if(!req.auth?.userId){fail(res,'audio_unauthenticated',401);return false;}
    if(!isAudioStaging(env)){fail(res,'audio_disabled',503);return false;}return true;};
  const load=async req=>{
    const {context,selected,excluded}=audioSelection(req.auth,req.body?.conversationContext);
    const operation=req.body?.operationId;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(operation||'')) throw new Error('audio_context_invalid');
    const fingerprint=hash(JSON.stringify({context,selected}));
    const binding={platform:context.platform,contact_id:context.contact.id,message_ids:selected.map(s=>s.id)};
    const result=await rpc('zentra_audio_prepare',{...args(req),p_operation:operation,p_hash:fingerprint,p_context:binding,p_selection:selected});
    return {result,context,selected,excluded,operation,fingerprint};
  };
  const view=(loaded)=>{
    const {result,selected,excluded}=loaded;
    const cache=result.cache||[];
    return {success:true,operationId:loaded.operation,state:result.operation.state,
      conversationContext:cachedConversation(loaded.context,selected,cache),excluded,
      pending:selected.filter(s=>!cache.some(c=>c.audio_key===s.audio_key && c.state==='done')),
      cacheHits:cache.filter(c=>c.state==='done').length,quota:{limitMs:result.account.cap_ms,cycle:result.account.cycle,
        usedMs:result.account.used_ms,reservedMs:result.account.reserved_ms,
        remainingMs:Math.max(0,result.account.cap_ms-result.account.used_ms-result.account.reserved_ms)}};
  };
  return {
    async config(req,res){if(!guard(req,res))return;try{
      const r=await client.from('zentra_conversation_audio_settings').select('enabled').eq('singleton',true).single();
      return res.json({enabled:!r.error&&r.data?.enabled===true,model:AUDIO_MODEL});
    }catch(_){return res.json({enabled:false});}},
    async prepare(req,res){if(!guard(req,res))return;try{
      const loaded=await load(req);
      if(!loaded.result.allowed)return fail(res,loaded.result.reason,loaded.result.reason==='audio_disabled'?503:409);
      return res.json(view(loaded));
    }catch(e){return fail(res,e.message,e.message==='audio_store_unavailable'?503:400);}},
    async process(req,res){if(!guard(req,res))return;
      let loaded,reserved=false;const files=[];
      try {
        // Authorization belongs to the user's request, never to transcript/page text.
        if(req.body?.authorized!==true)return fail(res,'audio_authorization_required',400);
        loaded=await load(req);
        if(!loaded.result.allowed)return fail(res,loaded.result.reason,503);
        const initial=view(loaded);
        if(!initial.pending.length){emit({operationId:loaded.operation,zentraTranscribed:0,processedMs:0,
          cacheHits:initial.cacheHits,quotaBeforeMs:loaded.result.account.used_ms,quotaAfterMs:loaded.result.account.used_ms,
          model:null,estimatedCostUsd:0});return res.json(initial);}
        if(loaded.result.operation.state!=='prepared')return fail(res,'audio_pending');
        if(!providerReady())return fail(res,'audio_disabled',503);
        const uploads=req.body?.audios;
        if(!Array.isArray(uploads)||uploads.length!==initial.pending.length||uploads.length>5)return fail(res,'audio_context_invalid',400);
        let bytes=0;const ids=new Set();
        for(const upload of uploads){
          const selected=initial.pending.find(s=>s.id===upload.id);
          if(!selected||ids.has(upload.id))throw new Error('audio_context_invalid');ids.add(upload.id);
          const file=await inspectAudio(upload.audioBase64);files.push({...file,...selected});bytes+=file.buffer.length;
          if(bytes>AUDIO_LIMITS.batchBytes)throw new Error('audio_invalid');
        }
        // Identical bytes in one batch run only once, even with distinct message IDs.
        const unique=files.filter((f,i)=>files.findIndex(other=>other.binaryHash===f.binaryHash)===i);
        const reservation=await rpc('zentra_audio_reserve',{...args(req),p_operation:loaded.operation,p_hash:loaded.fingerprint,
          p_items:unique.map(f=>({audio_key:f.audio_key,binary_hash:f.binaryHash,duration_ms:f.durationMs}))});
        if(!reservation.allowed){if(sendFreeAccessBlock(res,reservation))return;return fail(res,reservation.reason,403);}
        reserved=true;let processed=0,ms=0,hits=initial.cacheHits;
        let current=await load(req);
        for(const file of unique){
          if(current.result.cache.some(c=>c.audio_key===file.audio_key&&c.state==='done')){hits++;continue;}
          const start=await rpc('zentra_audio_start',{...args(req),p_operation:loaded.operation,p_key:file.audio_key});
          if(!start.allowed){if(sendFreeAccessBlock(res,start))return;throw new Error(start.reason);}
          const text=await transcribe(file);processed++;ms+=file.durationMs;
          const stored=await rpc('zentra_audio_finish',{...args(req),p_operation:loaded.operation,p_key:file.audio_key,p_text:text});
          if(stored!==true)throw new Error('audio_store_unavailable');
        }
        for(const file of files){if(unique.includes(file))continue;
          if(await rpc('zentra_audio_alias',{...args(req),p_operation:loaded.operation,p_key:file.audio_key,p_hash:file.binaryHash})!==true)
            throw new Error('audio_store_unavailable');
        }
        await rpc('zentra_audio_close',{...args(req),p_operation:loaded.operation,p_success:true});reserved=false;
        current=await load(req);
        emit({operationId:loaded.operation,audiosDetected:loaded.context.messages.filter(m=>m.type.startsWith('audio')).length,
          nativeTranscripts:loaded.context.messages.filter(m=>m.type==='audio_transcript'&&m.source!=='zentra_transcript').length,
          zentraTranscribed:processed,processedMs:ms,cacheHits:hits,quotaBeforeMs:reservation.quota_before_ms,
          quotaAfterMs:reservation.quota_before_ms+ms,model:processed?AUDIO_MODEL:null,estimatedCostUsd:ms/60000*0.0045});
        return res.json({...view(current),processedMs:ms,transcriptionAction:processed>0?1:0});
      }catch(e){return fail(res,e.message,e.message==='audio_store_unavailable'?503:400);}
      finally{
        if(reserved&&loaded)try{await rpc('zentra_audio_close',{...args(req),p_operation:loaded.operation,p_success:false});}catch(_){}
        for(const file of files)file.buffer.fill(0);
        if(req.body)delete req.body.audios;delete req.rawBody;
      }
    }
  };
}
