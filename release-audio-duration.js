import {spawn} from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

// Decode locally into a null sink: no playback, files, URL protocols or third-party request.
// Counting decoded samples avoids trusting editable MPEG/Xing/container duration metadata.
export function decodedAudioDuration(buffer) {
  return new Promise((resolve,reject)=>{
    if(!ffmpegPath)return reject(new Error('audio_decoder_unavailable'));
    const child=spawn(ffmpegPath,['-nostdin','-v','error','-protocol_whitelist','pipe','-threads','1',
      '-i','pipe:0','-map','0:a:0','-vn','-t','601','-ac','1','-ar','16000','-f','s16le','pipe:1'],{stdio:['pipe','pipe','pipe']});
    let decodedBytes=0,failed=false;
    const fail=()=>{failed=true;child.kill('SIGKILL');};
    const timer=setTimeout(fail,30000);
    child.stdin.on('error',()=>{});
    child.stdout.on('data',chunk=>{decodedBytes+=chunk.length;chunk.fill(0);if(decodedBytes>602*32000)fail();});
    // Never persist or print decoder stderr: it can contain embedded file metadata.
    child.stderr.on('data',()=>{});
    child.on('error',()=>{clearTimeout(timer);reject(new Error('audio_decoder_unavailable'));});
    child.on('close',code=>{
      clearTimeout(timer);
      const ms=Math.ceil(decodedBytes/32000*1000);
      if(code!==0||failed||!Number.isSafeInteger(ms)||ms<=0)return reject(new Error('audio_invalid'));
      resolve(ms);
    });
    child.stdin.end(buffer);
  });
}
