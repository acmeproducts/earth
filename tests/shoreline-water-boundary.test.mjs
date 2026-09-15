import assert from 'node:assert/strict';
import test from 'node:test';
import { clipShorelineToWater } from '../src/water/ShorelineWaterBoundary.ts';
import { signedArea } from '../src/core/PlanarGeometry.ts';
const ring = (x,z,w,d) => [{x,z},{x:x+w,z},{x:x+w,z:z+d},{x,z:z+d}];
const geometry = {positions:[-30,5,-30,30,5,-30,30,5,30,-30,5,30],indices:[0,2,1,0,3,2],depths:[-0.3,0.3,0.3,-0.3]};
const area = g => {let sum=0;for(let i=0;i<g.indices.length;i+=3) sum+=Math.abs(signedArea(g.indices.slice(i,i+3).map(v=>({x:g.positions[v*3],z:g.positions[v*3+2]}))));return sum;};
test('small urban pond wave apron cannot create puddles on surrounding streets',()=>{
  const g=clipShorelineToWater(geometry,{outline:ring(-4,-5,8,10),holes:[]});
  assert.ok(Math.abs(area(g)-80)<1e-8);
  for(let i=0;i<g.depths.length;i++){
    const [x,y,z]=g.positions.slice(i*3,i*3+3);
    assert.ok(x>=-4-1e-8&&x<=4+1e-8&&z>=-5-1e-8&&z<=5+1e-8);
    assert.equal(y,5);
    assert.ok(Math.abs(g.depths[i]-x/100)<1e-8,'depth interpolation preserves wave shape');
  }
});
test('keeps islands dry and respects concave water outlines and reversed winding',()=>{
  const outline=[{x:0,z:0},{x:10,z:0},{x:10,z:4},{x:4,z:4},{x:4,z:10},{x:0,z:10}];
  for(const ring of [outline,[...outline].reverse()]){
    const g=clipShorelineToWater(geometry,{outline:ring,holes:[[{x:1,z:1},{x:3,z:1},{x:3,z:3},{x:1,z:3}]]});
    assert.ok(Math.abs(area(g)-60)<1e-8);
  }
});
test('separate same-height ground produces no wave surface',()=>{
  assert.equal(clipShorelineToWater(geometry,{outline:ring(40,40,5,5),holes:[]}).indices.length,0);
});
