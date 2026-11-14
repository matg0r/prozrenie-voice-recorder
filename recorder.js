'use strict';
// Offline recording/export only. No fetch, uploads, analytics or speech synthesis.
const CommandRecorder = (() => {
 const commands = [
  ['describe','Прозрение, опиши'], ['read_text','Прозрение, прочитай'],
  ['stop','Прозрение, стоп'], ['repeat','Прозрение, повтори'],
  ['shorten','Прозрение, короче'], ['help','Прозрение, помощь'],
  ['volume:10','Прозрение, громкость десять'], ['volume:50','Прозрение, громкость пятьдесят'],
  ['find:телефон','Прозрение, найди телефон'], ['find:ключи','Прозрение, найди ключи']
 ];
 const negatives = ['Сегодня на улице хорошая погода.','Пожалуйста, прочитай эту записку.',
  'Прозрение, не описывай.','Я говорю про зрение и здоровье.','Маша, опиши картинку.','Остановись, пожалуйста.'];
 function makePlan(repetitions) {
  const result=[];
  for(let repeat=1;repeat<=repetitions;repeat++) for(const [action,text] of commands)
   result.push({id:`${action.replace(/[^a-z0-9]/g,'_')}_${result.length+1}`,kind:'command',action,intended_text:text,repeat});
  negatives.forEach((text,index)=>result.push({id:`negative_${index+1}`,kind:'negative',action:null,intended_text:text,repeat:1}));
  return result;
 }
 function wav(samples,rate=16000) {
  const bytes=new Uint8Array(44+samples.length*2),v=new DataView(bytes.buffer);
  function text(offset,value){for(let i=0;i<value.length;i++)v.setUint8(offset+i,value.charCodeAt(i));}
  text(0,'RIFF');v.setUint32(4,bytes.length-8,true);text(8,'WAVE');text(12,'fmt ');
  v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);
  v.setUint32(24,rate,true);v.setUint32(28,rate*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);
  text(36,'data');v.setUint32(40,samples.length*2,true);
  for(let i=0;i<samples.length;i++){const n=Math.max(-1,Math.min(1,samples[i]));v.setInt16(44+i*2,Math.round(n*(n<0?32768:32767)),true);}
  return bytes;
 }
 function quality(samples){let sum=0,peak=0,clipped=0;for(const n of samples){sum+=n*n;peak=Math.max(peak,Math.abs(n));if(Math.abs(n)>=.999)clipped++;}
  const rms=Math.sqrt(sum/Math.max(1,samples.length));
  return {peak,rms,rms_dbfs:rms?20*Math.log10(rms):null,clipped_fraction:clipped/Math.max(1,samples.length),
   warning:peak<.005?'Очень тихая запись. Прослушайте: возможно, выбран не тот микрофон.':clipped/samples.length>.01?'Звук перегружен. Попробуйте говорить чуть дальше от микрофона.':null};
 }
 function crc32(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let j=0;j<8;j++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
 function zip(files){
  const parts=[],central=[];let offset=0,centralSize=0;
  for(const file of files){
   const name=new TextEncoder().encode(file.name),data=file.data,crc=crc32(data);
   const local=new Uint8Array(30+name.length),lv=new DataView(local.buffer);
   lv.setUint32(0,0x04034b50,true);lv.setUint16(4,20,true);lv.setUint16(6,0x800,true);
   lv.setUint16(12,33,true);lv.setUint32(14,crc,true);lv.setUint32(18,data.length,true);lv.setUint32(22,data.length,true);lv.setUint16(26,name.length,true);local.set(name,30);
   const directory=new Uint8Array(46+name.length),dv=new DataView(directory.buffer);
   dv.setUint32(0,0x02014b50,true);dv.setUint16(4,20,true);dv.setUint16(6,20,true);dv.setUint16(8,0x800,true);dv.setUint16(14,33,true);
   dv.setUint32(16,crc,true);dv.setUint32(20,data.length,true);dv.setUint32(24,data.length,true);dv.setUint16(28,name.length,true);dv.setUint32(42,offset,true);directory.set(name,46);
   parts.push(local,data);central.push(directory);offset+=local.length+data.length;centralSize+=directory.length;
  }
  const end=new Uint8Array(22),ev=new DataView(end.buffer);ev.setUint32(0,0x06054b50,true);ev.setUint16(8,files.length,true);ev.setUint16(10,files.length,true);ev.setUint32(12,centralSize,true);ev.setUint32(16,offset,true);
  return new Blob([...parts,...central,end],{type:'application/zip'});
 }
 const csv = value => '"'+String(value??'').replaceAll('"','""')+'"';
 return {makePlan,wav,quality,zip,crc32,csv};
})();
if(typeof module!=='undefined') module.exports=CommandRecorder;

if(typeof document!=='undefined') (()=>{
 const $=id=>document.getElementById(id);
 let plan=[],index=0,identity=null,session=null,draft=null,audioURL=null,busy=false,dirty=false;
 let recorder=null,countdownCancel=false,records=new Map(),skipped=new Set();
 let storageWrites=Promise.resolve();
 const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 $('participant').value='p_'+crypto.randomUUID().slice(0,8);
 function status(text){$('status').textContent=text;}
 function lock(value){busy=value;for(const id of ['record','skip','save','redo','asWritten','download','restore','newParticipant'])$(id).disabled=value||(id==='download'&&!records.size);$('transcript').disabled=value;$('verified').disabled=value;}
 async function refreshSessions(){
  if(typeof RecorderStorage==='undefined')throw Error('Локальное хранилище недоступно');
  const rows=await RecorderStorage.list();$('savedSessions').replaceChildren();
  for(const row of rows.filter(r=>r.schema_version===1&&r.records?.length).sort((a,b)=>b.updated_at.localeCompare(a.updated_at))){
   const option=document.createElement('option');option.value=row.session;option.textContent=`${row.identity.participant_id} · ${row.records.length} записей · ${new Date(row.updated_at).toLocaleString('ru-RU')}`;$('savedSessions').append(option);
  }
  $('resume').hidden=!$('savedSessions').children.length;
 }
 function persist(){
  if(!session)return;
  const snapshot={schema_version:1,session,identity,plan,index,records:[...records],skipped:[...skipped],updated_at:new Date().toISOString()};
  $('storageStatus').textContent='Сохраняю сессию в этом браузере…';
  storageWrites=storageWrites.catch(()=>{}).then(async()=>{
   if(typeof RecorderStorage==='undefined')throw Error('Локальное хранилище недоступно');
   await RecorderStorage.save(snapshot);await refreshSessions();$('storageStatus').textContent='Сохранено в этом браузере. Для резервной копии скачайте ZIP.';
  }).catch(error=>{$('storageStatus').textContent='Не удалось сохранить в браузере. Скачайте ZIP перед закрытием. '+error.message;});
 }
 $('restore').onclick=async()=>{
  if(busy)return;
  try{
   await storageWrites;const saved=await RecorderStorage.load($('savedSessions').value);
   if(!saved||saved.schema_version!==1)throw Error('Сессия не найдена');
   if(session&&dirty&&!confirm('Перейти к другой сессии? Уже сохранённые записи останутся в этом браузере.'))return;
   releasePreview();({session,identity,plan,index}=saved);records=new Map(saved.records);skipped=new Set(saved.skipped);dirty=false;
   $('setup').hidden=true;show();$('storageStatus').textContent='Сессия восстановлена. Можно продолжить или скачать ZIP.';
  }catch(error){$('storageStatus').textContent='Не удалось восстановить сессию: '+error.message;}
 };
 $('newParticipant').onclick=async()=>{
  if(busy)return;
  if(!confirm('Начать запись для другого человека? Сохранённая сессия останется на этом устройстве. Не забудьте скачать её ZIP.'))return;
  await storageWrites;releasePreview();plan=[];index=0;identity=null;session=null;records=new Map();skipped=new Set();dirty=false;
  $('participant').value='p_'+crypto.randomUUID().slice(0,8);$('consent').checked=false;$('age').value='unknown';$('pronunciation').value='natural';
  $('setup').hidden=false;$('recorder').hidden=true;$('export').hidden=true;$('setupError').textContent='';
 };
 refreshSessions().then(()=>{$('storageStatus').textContent='Сохранённые записи остаются в этом браузере. Скачивайте ZIP как резервную копию.';})
  .catch(()=>{$('storageStatus').textContent='Локальное хранилище недоступно. Записывать можно, но перед закрытием обязательно скачайте ZIP.';});
 function releasePreview(){if(audioURL)URL.revokeObjectURL(audioURL);audioURL=null;$('playback').pause();$('playback').removeAttribute('src');$('preview').hidden=true;draft=null;}
 function presentDraft(row){
  draft=row;audioURL=URL.createObjectURL(new Blob([row.bytes],{type:'audio/wav'}));$('playback').src=audioURL;
  $('transcript').value=row.transcript||'';$('verified').checked=!!row.transcript_verified;$('preview').hidden=false;
  $('quality').textContent=`Длительность: ${row.seconds.toFixed(1)} с.\n`+(row.quality.warning||'Прослушайте запись: уровень сигнала сам по себе не подтверждает разборчивость речи.');
 }
 function update(){
  $('export').hidden=false;$('savedCount').textContent=`Сохранено: ${records.size}. Пропущено: ${skipped.size}. Всего фраз: ${plan.length}.`;
  $('download').disabled=busy||!records.size;$('progress').max=plan.length;$('progress').value=records.size+skipped.size;
  $('reviewList').replaceChildren();
  for(const [i,row] of records){const button=document.createElement('button');button.textContent=`${i+1}. ${row.intended_text}`;button.disabled=busy;button.onclick=()=>{if(busy)return;releasePreview();index=i;show();};$('reviewList').append(button);}
 }
 function show(){
  releasePreview();update();$('recorder').hidden=index>=plan.length;
  if(index>=plan.length){$('exportTitle').textContent='Сессия закончена — скачайте записи';return;}
  const item=plan[index];$('counter').textContent=`Фраза ${index+1} из ${plan.length}`;
  $('kind').textContent=item.kind==='command'?`Команда · повтор ${item.repeat}`:'Обычная фраза · помощник не должен запускаться';
  $('phrase').textContent=item.intended_text;$('transcript').value='';$('verified').checked=false;
  if(records.has(index))presentDraft(records.get(index));
  status(records.has(index)?'Запись уже сохранена. Можно заменить её или перейти дальше.':'Готово к записи.');
  $('skip').textContent=records.has(index)?'Дальше без изменения':'Пропустить фразу';lock(false);
 }
 $('begin').onclick=()=>{
  const participant=$('participant').value.trim();
  if(!/^[A-Za-z0-9_-]{3,40}$/.test(participant)){$('setupError').textContent='Код: от 3 до 40 латинских букв, цифр, знаков _ или -.';return;}
  if(!$('consent').checked){$('setupError').textContent='Для записи нужно согласие говорящего, а для ребёнка — его родителя или представителя.';return;}
  if(!navigator.mediaDevices?.getUserMedia){$('setupError').textContent='Микрофон недоступен. На телефоне откройте HTTPS-ссылку в Chrome или Safari. Адрес 127.0.0.1 работает только на компьютере с запущенной страницей.';return;}
  identity={participant_id:participant,age_group:$('age').value,pronunciation:$('pronunciation').value,consent_self_reported:true};
  session='commands_'+new Date().toISOString().replace(/[:.]/g,'-')+'_'+crypto.randomUUID().slice(0,8);
  plan=CommandRecorder.makePlan(Number($('repetitions').value));$('setup').hidden=true;show();persist();
 };
 async function start(){
  if(busy)return;releasePreview();lock(true);update();countdownCancel=false;
  let stream=null,ctx=null;
  try{
   status('Разрешите браузеру использовать микрофон.');
   stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:{ideal:1},echoCancellation:false,noiseSuppression:false,autoGainControl:false},video:false});
   ctx=new AudioContext();await ctx.resume();
   $('stop').disabled=false;
   for(let n=2;n>0;n--){if(countdownCancel)break;status(`Приготовьтесь… ${n}`);await sleep(1000);}
   if(countdownCancel){stream.getTracks().forEach(t=>t.stop());await ctx.close();$('stop').disabled=true;lock(false);update();status('Запись отменена.');return;}
   const chunks=[];let count=0;const started=new Date().toISOString();
   const source=ctx.createMediaStreamSource(stream),node=ctx.createScriptProcessor(4096,1,1),mute=ctx.createGain();mute.gain.value=0;
   const settings=stream.getAudioTracks()[0].getSettings();
   recorder={stream,ctx,node,source,mute,chunks,settings,started,timer:null,ending:false,get count(){return count;}};
   node.onaudioprocess=event=>{
    if(!recorder||recorder.ending)return;
    const data=event.inputBuffer.getChannelData(0),remaining=Math.floor(ctx.sampleRate*8)-count;
    if(remaining>0){const block=new Float32Array(data.subarray(0,Math.min(data.length,remaining)));chunks.push(block);count+=block.length;}
    if(count>=ctx.sampleRate*8)void finish();
   };
   source.connect(node);node.connect(mute);mute.connect(ctx.destination);
   recorder.timer=setTimeout(()=>void finish(),8500);status('Говорите. Затем нажмите «Закончить запись».');
  }catch(error){if(stream)stream.getTracks().forEach(t=>t.stop());if(ctx&&ctx.state!=='closed')await ctx.close();recorder=null;$('stop').disabled=true;lock(false);update();status('Не удалось записать: '+error.message+'. Проверьте разрешение микрофона и попробуйте снова.');}
 }
 async function finish(){
  if(!recorder){countdownCancel=true;$('stop').disabled=true;return;}
  const r=recorder;if(r.ending)return;r.ending=true;$('stop').disabled=true;clearTimeout(r.timer);
  r.node.onaudioprocess=null;r.source.disconnect();r.node.disconnect();r.mute.disconnect();r.stream.getTracks().forEach(t=>t.stop());
  recorder=null;status('Подготавливаю запись…');
  try{
   const rate=r.ctx.sampleRate;await r.ctx.close();
   if(r.count<rate*.3)throw Error('Запись короче 0,3 секунды');
   const samples=new Float32Array(r.count);let position=0;for(const block of r.chunks){samples.set(block,position);position+=block.length;}
   const offline=new OfflineAudioContext(1,Math.round(samples.length*16000/rate),16000);
   const buffer=offline.createBuffer(1,samples.length,rate);buffer.copyToChannel(samples,0);
   const source=offline.createBufferSource();source.buffer=buffer;source.connect(offline.destination);source.start();
   const output=await offline.startRendering(),pcm=output.getChannelData(0),bytes=CommandRecorder.wav(pcm);
   draft={bytes,seconds:pcm.length/16000,quality:CommandRecorder.quality(pcm),recorded_at:r.started,
    capture:{context_sample_rate:rate,device_sample_rate:r.settings.sampleRate??null,device_channels:r.settings.channelCount??null,
     echo_cancellation:r.settings.echoCancellation??null,noise_suppression:r.settings.noiseSuppression??null,auto_gain_control:r.settings.autoGainControl??null}};
   presentDraft(draft);
   status('Запись готова. Прослушайте и сохраните либо перезапишите.');
  }catch(error){status('Запись не сохранена: '+error.message+'. Попробуйте ещё раз.');}
  lock(false);update();
 }
 $('record').onclick=start;$('stop').onclick=()=>void finish();
 $('asWritten').onclick=()=>{if(!draft)return;$('transcript').value=plan[index].intended_text;$('verified').checked=false;};
 $('transcript').oninput=()=>{$('verified').checked=false;};
 $('redo').onclick=()=>{releasePreview();void start();};
 $('save').onclick=()=>{
  if(!draft||busy)return;
  const transcript=$('transcript').value.trim(),verified=$('verified').checked;
  if(verified&&!transcript){status('Заполните подтверждаемую расшифровку или снимите отметку подтверждения.');return;}
  records.set(index,{...plan[index],...draft,transcript:transcript||null,transcript_verified:verified,
   transcript_provenance:verified?'participant_or_helper_confirmed':'unverified',file:`audio/${String(index+1).padStart(3,'0')}.wav`});
  skipped.delete(index);dirty=true;index++;show();persist();
 };
 $('skip').onclick=()=>{if(busy)return;if(!records.has(index))skipped.add(index);index++;show();persist();};
 $('download').onclick=async()=>{
  if(busy||!records.size)return;lock(true);update();$('savedCount').textContent='Подготавливаю ZIP…';
  try{
   const files=[],rows=[];
   for(const [i,row] of [...records].sort((a,b)=>a[0]-b[0])){
    const {bytes,...metadata}=row;
    const hash=await crypto.subtle.digest('SHA-256',bytes);
    rows.push({...metadata,...identity,sha256:[...new Uint8Array(hash)].map(n=>n.toString(16).padStart(2,'0')).join(''),sample_rate:16000,channels:1,encoding:'PCM_S16LE'});
    files.push({name:row.file,data:bytes});
   }
   const report={schema_version:1,session_id:session,...identity,exported_at:new Date().toISOString(),
    source:'real_microphone',browser:navigator.userAgent,training_performed:false,split:null,
    split_note:'Assign by participant_id before training; never split repeated recordings of one person across train and test.',
    transcript_note:'intended_text is a prompt, not ground truth; transcript_verified is self-reported, not an independent audit.',
    expected_commands_are_not_dispatched:true,planned_count:plan.length,skipped_ids:[...skipped].map(i=>plan[i].id),samples:rows};
   const encode=text=>new TextEncoder().encode(text);
   files.push({name:'manifest.json',data:encode(JSON.stringify(report,null,2))});
   const columns=['file','participant_id','kind','action','intended_text','transcript','transcript_verified','seconds','sha256'];
   files.push({name:'metadata.csv',data:encode('\ufeff'+[columns.map(CommandRecorder.csv).join(','),...rows.map(row=>columns.map(c=>CommandRecorder.csv(row[c])).join(','))].join('\r\n'))});
   files.push({name:'README.txt',data:encode('Записи команд ПРОЗРЕНИЯ. WAV: mono PCM16 16000 Hz.\nЗаданный текст не равен проверенной расшифровке. Смотрите manifest.json.\nПеред обучением прослушайте записи. Разделяйте по participant_id, а не по файлам.\nНе публикуйте голоса без отдельного согласия. Передача команде проекта не означает открытую лицензию.\n')});
   const url=URL.createObjectURL(CommandRecorder.zip(files)),link=document.createElement('a');link.href=url;link.download=session+'.zip';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
   dirty=false;
  }catch(error){alert('Архив не создан: '+error.message);}
  finally{lock(false);update();}
 };
 window.addEventListener('beforeunload',event=>{if(dirty||busy||draft){event.preventDefault();event.returnValue='';}});
 document.addEventListener('visibilitychange',()=>{if(document.hidden&&recorder)void finish();else if(document.hidden&&busy)countdownCancel=true;});
})();
