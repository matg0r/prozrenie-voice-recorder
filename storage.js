'use strict';
// Browser-local database only; no network, third-party storage or audio upload.
const RecorderStorage=(()=>{
 let database;
 function open(){
  if(database)return database;
  database=new Promise((resolve,reject)=>{
   if(typeof indexedDB==='undefined'){reject(Error('Локальное хранилище недоступно'));return;}
   const request=indexedDB.open('prozrenie-command-recordings',1);
   request.onupgradeneeded=()=>request.result.createObjectStore('sessions',{keyPath:'session'});
   request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
   request.onblocked=()=>reject(Error('Закройте другие старые вкладки записи и обновите страницу'));
  });
  return database;
 }
 async function transaction(mode,operation){
  const db=await open();
  return new Promise((resolve,reject)=>{
   const tx=db.transaction('sessions',mode);let result;
   const request=operation(tx.objectStore('sessions'));
   request.onsuccess=()=>{result=request.result;};
   tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error||request.error);tx.onabort=()=>reject(tx.error||Error('Сохранение прервано'));
  });
 }
 return {save:row=>transaction('readwrite',store=>store.put(row)),
  list:()=>transaction('readonly',store=>store.getAll()),
  load:id=>transaction('readonly',store=>store.get(id))};
})();
if(typeof module!=='undefined')module.exports=RecorderStorage;
