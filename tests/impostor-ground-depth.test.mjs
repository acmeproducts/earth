import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const treeSource = readFileSync(new URL("../src/vegetation/TreeField.ts", import.meta.url), "utf8");
const grassFieldSource = readFileSync(new URL("../src/vegetation/GrassField.ts", import.meta.url), "utf8");
const grassImpostorSource = readFileSync(
  new URL("../src/vegetation/GrassImpostor.ts", import.meta.url),
  "utf8",
);

test("the impostor depth plane can move out to a wide source's near edge", () => {
  assert.match(treeSource, /uniform float impostorDepthPull;/);
  // Depth still comes from one flattened plane; only its distance changes.
  assert.match(treeSource, /clipPosition\.z = \(centerClipPosition\.z/);
  assert.match(treeSource, /viewProjection \* vec4\(depthCenter, 1\.0\)/);
});

test("pulling the depth plane never crosses the camera", () => {
  // A plane pulled past the near clip would drop the impostor entirely, so the
  // pull stays a fraction of the distance to the camera.
  assert.match(treeSource, /min\(impostorDepthPull, viewDistance \* 0\.5\)/);
  assert.match(treeSource, /max\(viewDistance, 0\.0001\)/);
});

test("an impostor material defaults to the flattened center plane", () => {
  assert.match(treeSource, /material\.setFloat\("impostorDepthPull", 0\);/);
});

test("grass pulls its depth plane out to the near blades", () => {
  assert.match(
    grassFieldSource,
    /impostorDepthPull: grassImpostorDepthPull\(grassHeight\)/,
  );
  assert.match(
    grassFieldSource,
    /grassRenderedClumpRadius\(renderHeight\) \* averageWidthScale/,
  );
  // The pull has to follow the same clump radius the source geometry uses, or
  // it drifts away from where the near blades actually are.
  assert.match(grassImpostorSource, /const CLUMP_RADIUS = 1\.95;/);
  assert.match(
    grassImpostorSource,
    /CLUMP_RADIUS \* CLUMP_EDGE_RADIUS_SCALE_MAXIMUM \* renderHeight \/ SOURCE_HEIGHT/,
  );
  assert.match(
    grassImpostorSource,
    /const edgeRadius = CLUMP_RADIUS \* \([\s\S]*?CLUMP_EDGE_RADIUS_SCALE_MINIMUM[\s\S]*?CLUMP_EDGE_RADIUS_SCALE_SPAN/,
  );

  // A clump reaches much further sideways than up, which is why depth at the
  // capture center let the ground bury the lower half of the captured image.
  const clumpRadius = 1.95 * 0.55 / 0.85;
  const averageWidthScale = 1.1 + 0.42 / 2;
  assert.ok(clumpRadius * averageWidthScale > 0.55 * 1.5);
});

test("tall sources resolve depth against an ellipsoid instead of a plane", () => {
  // The proxy is fitted to the capture volume, so it needs no extra uniform
  // and cannot disagree with the frame the fragment is sampling.
  assert.match(
    treeSource,
    /vec3 proxyRadii = 0\.5 \* vec3\(captureDimensions\.x, captureDimensions\.y, captureDimensions\.x\);/,
  );
  assert.match(treeSource, /float discriminant = b \* b - 4\.0 \* a \* c;/);
  // A missed ray must fall back to the closest approach, not to the plane, or
  // depth jumps at every canopy silhouette.
  assert.match(treeSource, /: -b \/ \(2\.0 \* a\);/);
  assert.match(treeSource, /gl_FragDepthEXT = depthClip\.w > 0\.0/);
});

test("the depth write survives Babylon's shader processors", () => {
  // Both the WebGL2 and WebGPU GLSL processors strip this extension and rename
  // gl_FragDepthEXT, which is why the declaration is written this way.
  assert.match(treeSource, /#extension GL_EXT_frag_depth : enable/);
  assert.match(treeSource, /uniform mat4 viewProjection;[\s\S]*uniform vec3 cameraPosition;/);
});

test("depth is never left undefined and never reaches a shadow map", () => {
  const proxyBlock = treeSource.slice(
    treeSource.indexOf("#ifdef IMPOSTOR_DEPTH_PROXY"),
    treeSource.indexOf("vec3 straightColor = color.rgb;"),
  );
  // The shadow pass renders with the light's matrices, so the camera-pass depth
  // would corrupt the shadow map. Its guard has to be the absence of the
  // shadow define, not its value: point and spot lights define it as 0.
  assert.match(proxyBlock, /#ifndef SM_DIRECTIONINLIGHTDATA/);
  assert.doesNotMatch(proxyBlock, /SM_DIRECTIONINLIGHTDATA != 1/);
  // Every surviving fragment writes depth once the shader writes it at all.
  const writes = proxyBlock.match(/gl_FragDepthEXT =/g) ?? [];
  assert.equal(writes.length, 2);
  assert.match(proxyBlock, /} else {\s*gl_FragDepthEXT = gl_FragCoord\.z;/);
});

test("only tall sources pay for the depth proxy", () => {
  assert.match(treeSource, /: depth\.depthProxy \? \["#define IMPOSTOR_DEPTH_PROXY"\] : \[\]/);
  assert.match(treeSource, /rootName,\s*\{ depthProxy: true \},/);
  // Low ground cover keeps the cheap flattened plane and its forward pull.
  const renderers = readFileSync(
    new URL("../src/vegetation/VegetationFieldRenderers.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(renderers, /depthProxy/);
});

test("stone patches write ground-aligned pixel depth only in the camera pass", () => {
  const block = treeSource.slice(
    treeSource.indexOf("#ifdef IMPOSTOR_GROUND_PLANE", treeSource.indexOf("if (color.a <= alphaChoice) discard;")),
    treeSource.indexOf("#ifdef IMPOSTOR_DEPTH_PROXY"),
  );
  assert.match(block, /#ifndef SM_DIRECTIONINLIGHTDATA/);
  assert.match(block, /gl_FragDepthEXT = gl_FragCoord\.z;/);
  assert.match(block, /cameraPosition \+ groundRay \* groundHit/);
  assert.match(block, /gl_FragDepthEXT = 0\.5 \+ 0\.5 \* groundClip\.z \/ groundClip\.w;/);
  assert.match(treeSource, /cross\(finalWorld\[2\]\.xyz, finalWorld\[0\]\.xyz\)/);
  const renderers = readFileSync(new URL("../src/vegetation/VegetationFieldRenderers.ts", import.meta.url), "utf8");
  assert.match(renderers, /options\.impostorName,\s*options\.depth,/);
});
