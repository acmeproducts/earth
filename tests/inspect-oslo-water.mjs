import { writeFileSync } from 'node:fs';
const t=(await(await fetch('http://localhost:9363/json')).json()).find(t=>t.type==='page');
const s=new WebSocket(t.webSocketDebuggerUrl);await new Promise(r=>s.onopen=r);
let id=0;const pending=new Map();s.onmessage=e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}};
const send=(method,params={})=>new Promise(r=>{pending.set(++id,r);s.send(JSON.stringify({id,method,params}));});
const ev=async(expression)=>(await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result;
for(let i=0;i<240;i++){
  const state=await ev(`!!document.querySelector('.place-form') && !document.getElementById('loading')`);
  if(state.result?.value)break;
  if(i%20===0)console.log('Waiting for scene',i);
  await new Promise(r=>setTimeout(r,1000));
}
await ev(`(() => {let req;window[Object.keys(window).find(k=>k.startsWith('webpackChunk'))].push([['inspect-oslo'],{},r=>req=r]);window.__osloReq=req;window.__osloScene=Object.values(req.c).map(m=>m.exports?.EngineStore?.LastCreatedScene).find(Boolean);})()`);
await ev(`(() => {const s=window.__osloScene;s.activeCamera.position.set(0,25,0);s.activeCamera.rotation.set(Math.PI/2,0,0);s.meshes.filter(m=>m.name.includes('shoreline')).forEach(m=>m.setEnabled(true));const slider=document.querySelector('input[aria-label="Time of day"]');if(slider){slider.value='12';slider.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
console.log(JSON.stringify(await ev(`(() => {const s=window.__osloScene;return {camera:s.activeCamera.position.asArray(),water:s.meshes.filter(m=>/water|lake|shoreline/i.test(m.name)).map(m=>({name:m.name,parent:m.parent?.name,material:m.material?.name,position:m.getAbsolutePosition().asArray(),vertices:m.getTotalVertices()}))};})()`)));
const comparisons = process.argv.includes('--compare') ? [
 ['fixed',''],
 ['legacy-aprons',`(async () => {
   const s=window.__osloScene, modules=Object.values(window.__osloReq.c).map(m=>m.exports);
   const attach=modules.find(m=>m.attachShoreline)?.attachShoreline;
   const planar=modules.find(m=>m.distanceToRing&&m.pointInRing);
   const lakes=s.meshes.filter(m=>m.name.startsWith('terrainLake-'));
   for(const lake of lakes){
     const parent=lake.parent, offset=parent.getAbsolutePosition();
     const ground=s.meshes.find(m=>m.name.startsWith('terrain ')&&!m.name.includes('shoreline')&&Math.abs(m.position.x-offset.x)<0.01&&Math.abs(m.position.z-offset.z)<0.01);
     if(!ground)continue;
     const p=lake.getVerticesData('position'),outline=[];
     for(let i=0;i<p.length;i+=3)outline.push({x:p[i],z:p[i+2]});
     const scale=12.3,padding=24/scale;
     await attach(ground,ground.getVerticesData('position'),ground.getIndices(),scale,undefined,{
       kind:'lake',elevation:lake.position.y,parent,
       includesPoint:(x,z)=>planar.pointInRing({x,z},outline)||planar.distanceToRing({x,z},outline)<=padding,
     });
   }
 })()`],
] : [['before',''],['no-shore',`window.__osloScene.meshes.filter(m=>m.name.includes('shoreline')).forEach(m=>m.setEnabled(false))`]];
for(const [name,expression] of comparisons){
 if(expression)await ev(expression);
 await new Promise(r=>setTimeout(r,1500));
 const shot=await send('Page.captureScreenshot',{format:'png'});
 writeFileSync(`C:/Users/TobiasElinder/AppData/Local/Temp/earth-oslo-water/${name}.png`,Buffer.from(shot.result.data,'base64'));
}
s.close();
