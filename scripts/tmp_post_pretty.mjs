const port = process.env.PORT || '3000';
(async ()=>{
  const url = `http://localhost:${port}/process?limit=1`;
  const r = await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'draft',folderPath:'/EBAY'})});
  const text = await r.text();
  console.log('STATUS', r.status);
  try{ console.log(JSON.stringify(JSON.parse(text), null, 2)); }catch(e){ console.log(text); }
})();
