const C='nf-v8';
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(C).then(c=>c.addAll(['./','icon-192.png','icon-maskable-512.png'])).catch(()=>{}))});
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{const r=e.request,u=new URL(r.url);if(r.method!=='GET'||u.origin!==location.origin||u.pathname.startsWith('/.netlify/'))return;
 e.respondWith(fetch(r).then(x=>{const y=x.clone();caches.open(C).then(c=>c.put(r,y)).catch(()=>{});return x}).catch(()=>caches.match(r).then(m=>m||caches.match('./'))))});
self.addEventListener('notificationclick',e=>{
 e.notification.close();
 const data=e.notification.data||{},room=data.room||'',url=data.url||((data.body||'').match(/https?:\/\/[^\s<>]+/i)||[])[0]||'';
 e.waitUntil((async()=>{
  if(url){try{await clients.openWindow(url);return}catch(x){}}
  const list=await clients.matchAll({type:'window',includeUncontrolled:true});
  const c=list.find(x=>'focus' in x);
  if(c){if(room)c.postMessage({room});return c.focus()}
  return clients.openWindow('./'+(room?'?room='+encodeURIComponent(room):''));
 })());
});
self.addEventListener('push',e=>{let d={};try{d=e.data.json()}catch(x){d={title:'NextFounder',body:e.data?e.data.text():''}}
 e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(l=>{
  const apple=/iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
  if(!apple&&!String(d.tag||'').startsWith('test')&&l.some(c=>c.visibilityState==='visible'&&c.focused))return;
  return self.registration.showNotification(d.title||'NextFounder',{body:d.body||'',icon:'icon-192.png',badge:'icon-192.png',vibrate:[200,100,200],silent:false,requireInteraction:false,tag:d.tag||'nf',renotify:true,timestamp:Date.now(),data:d})}))});
