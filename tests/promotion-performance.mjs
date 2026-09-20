import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function runPromotionPerformance({ evaluate, send, output, errors }) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const seconds = Number(process.argv.find(a => a.startsWith('--seconds='))?.slice(10) ?? 300);
  const maxMilliseconds = Number(process.argv.find(a => a.startsWith('--max-ms='))?.slice(9) ?? Infinity);
  if (!(seconds > 0) || !(maxMilliseconds > 0)) throw new Error('Time limits must be positive');
  let ready;
  for (let i = 0; i < 600; i++) {
    ready = await evaluate(`(() => {
      const g = window.performanceGame;
      return {ready: window.performanceReady, error: window.performanceError,
        coverage: window.performanceTools?.loadingCoverage(), active: g?.activeTileBuilds.size, fades: g?.layerFades.size};
    })()`);
    if (ready.error) throw new Error(ready.error);
    if (ready.ready && ready.active === 0 && ready.fades === 0 && ready.coverage.complete === ready.coverage.expected) break;
    if (i % 20 === 0) console.log('Preparing promotion:', JSON.stringify(ready));
    if (i === 599) throw new Error('Initial far scene did not settle');
    await sleep(1000);
  }
  await send('Profiler.enable');
  await send('Profiler.start');
  const setup = await evaluate(`(() => {
    const g = window.performanceGame;
    const [level,x,y] = g.cameraTileKey.split('/').map(Number);
    const key = [level,x+2,y].join('/');
    const t = g.tiles.get(key);
    if (!t || t.nativeTerrain || t.detailed || !t.farBuildings || !t.farRoads || !t.farTreeField)
      throw new Error('Target must begin as complete far scenery: '+key);
    window.promotionStats = {};
    const stats = window.performanceTools.creationStats;
    const record = stats.record;
    stats.record = function(name, value = 1) {
      const s = window.promotionStats[name] ??= {count:0,total:0,max:0};
      s.count++; s.total+=value; s.max=Math.max(s.max,value);
      return record.call(this,name,value);
    };
    window.performanceTools.resetTileTimingSummary();
    window.promotionFrames = [];
    const update = g.fpsCounter.update;
    let previous = performance.now();
    g.fpsCounter.update = function(...args) {
      const now=performance.now(); window.promotionFrames.push(now-previous); previous=now;
      return update.apply(this,args);
    };
    const started = performance.now();
    g.flyCamera.position.x = t.offsetX;
    g.flyCamera.position.z = t.offsetZ;
    g.flyCamera.rotation.set(0,Math.PI/2,0);
    return {key,started,settings:g.sceneSettings.value,from:[x,y],to:[x+2,y],
      position:g.flyCamera.position.asArray()};
  })()`);
  const samples = [];
  let completed;
  for (let i = 0; i < seconds * 4; i++) {
    const state = await evaluate(`(() => {
      const g=window.performanceGame,t=g.tiles.get(${JSON.stringify(setup.key)});
      return {elapsed:performance.now()-${setup.started},native:t?.nativeTerrain,detailed:t?.detailed,
        mapVisible:!!t?.mapFeatures?.isEnabled(),active:g.activeDetailBuilds.size,fades:g.layerFades.size,
        stages:window.performanceTools.streamingDiagnosticsSnapshot().activeStages};
    })()`);
    samples.push(state);
    if (i % 20 === 0) console.log('Promoting:', JSON.stringify(state));
    if (state.detailed && state.mapVisible && state.active === 0 && state.fades === 0) { completed=state.elapsed; break; }
    await sleep(250);
  }
  const { profile } = await send('Profiler.stop');
  writeFileSync(join(output,'promotion.cpuprofile'),JSON.stringify(profile));
  const detail = await evaluate('({stats:window.promotionStats,frames:window.promotionFrames,streaming:window.performanceTools.tileTimingSummary()})');
  const frames = [...detail.frames].sort((a,b) => a-b);
  const frameMilliseconds = {median:frames[Math.floor(frames.length*.5)],p95:frames[Math.floor(frames.length*.95)],max:frames.at(-1)};
  const geometry = await evaluate(`(() => {
    const root=window.performanceGame.tiles.get(${JSON.stringify(setup.key)}).mapFeatures;
    const meshes=root?.getChildMeshes().filter(m=>m.isEnabled() && m.isVisible) ?? [];
    return {meshes:meshes.length,vertices:meshes.reduce((sum,m)=>sum+m.getTotalVertices(),0)};
  })()`);
  const result = { ...setup, completedMilliseconds:completed ?? null, frameMilliseconds, geometry, samples, ...detail, errors };
  writeFileSync(join(output,'promotion.json'),JSON.stringify(result,null,2));
  const screenshot=await send('Page.captureScreenshot',{format:'png'});
  writeFileSync(join(output,'promotion.png'),Buffer.from(screenshot.data,'base64'));
  await evaluate(`(() => {
    const g=window.performanceGame;
    g.flyCamera.position.y += 450 / g.terrainMetersPerUnit;
    g.flyCamera.rotation.set(Math.PI/2,0,0);
  })()`);
  await sleep(250);
  const overview=await send('Page.captureScreenshot',{format:'png'});
  writeFileSync(join(output,'promotion-overview.png'),Buffer.from(overview.data,'base64'));
  console.log('Promotion result:',JSON.stringify({key:setup.key,completedMilliseconds:completed,errors}));
  if (!completed || errors.length || !geometry.vertices) throw new Error('Tile promotion did not finish with geometry and without errors');
  if (completed > maxMilliseconds) throw new Error(`Promotion took ${completed.toFixed(0)} ms, limit ${maxMilliseconds} ms`);
}
