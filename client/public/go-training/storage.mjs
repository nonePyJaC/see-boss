export class Storage {
  constructor(){this.db=null;this.fallback=false;}
  async open(){try{this.db=await new Promise((resolve,reject)=>{const r=indexedDB.open('go-training',1);r.onupgradeneeded=()=>r.result.createObjectStore('saves');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}catch{this.fallback=true;}return this;}
  async get(key){if(this.fallback){try{return JSON.parse(localStorage.getItem('go-training:'+key)||'null');}catch{return null;}}return new Promise((resolve,reject)=>{const r=this.db.transaction('saves').objectStore('saves').get(key);r.onsuccess=()=>resolve(r.result??null);r.onerror=()=>reject(r.error);});}
  async set(key,value){if(this.fallback){localStorage.setItem('go-training:'+key,JSON.stringify(value));return;}return new Promise((resolve,reject)=>{const t=this.db.transaction('saves','readwrite');t.objectStore('saves').put(value,key);t.oncomplete=()=>resolve();t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error||Error('存档写入中断'));});}
}
