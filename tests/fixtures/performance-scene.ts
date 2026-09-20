// Full application exposed only by the standalone performance test bundle.
import { Game } from '../../src/app/Game';
import { createRenderingEngine } from '../../src/rendering/Renderer';
import { EngineInstrumentation, PassPostProcess, ShadowGenerator } from '@babylonjs/core';
import { streamingDiagnosticsSnapshot, tileTimingSummary, resetTileTimingSummary } from '../../src/diagnostics/StreamingDiagnostics';
import { creationStats } from '../../src/diagnostics/CreationStats';
import { worldTileCoordinatesAtLocation, worldTileIntersectsCircle } from '../../src/world/WorldGrid';

const probe = window as any;
void (async () => {
  const canvas = document.getElementById('renderCanvas') as HTMLCanvasElement;
  const { engine } = await createRenderingEngine(canvas, 'webgl', {
    antialias: !new URLSearchParams(location.search).has('no-aa'), stencil: false,
  });
  const game = new Game(canvas, engine);
  const query = new URLSearchParams(location.search);
  if (query.has('lat') && query.has('lon')) {
    (game as any).worldLocation.requestDestination({ lat: Number(query.get('lat')), lon: Number(query.get('lon')) });
  } else if (query.has('oslo-walk')) {
    (game as any).worldLocation.requestDestination({ lat: 59.9116, lon: 10.7334 });
  }
  probe.performanceGame = game;
  probe.performanceTools = { EngineInstrumentation, PassPostProcess, ShadowGenerator, streamingDiagnosticsSnapshot, tileTimingSummary, resetTileTimingSummary, creationStats,
    loadingCoverage: () => {
      const g = game as any;
      const location = g.worldLocation.value;
      const coordinates = worldTileCoordinatesAtLocation(location.lat, location.lon, g.gridLevel);
      const scale = 2 ** g.gridLevel;
      const x = Math.floor(coordinates.x), y = Math.floor(coordinates.y);
      const radius = g.sceneSettings.value.terrainTilesAcross / 2;
      const detailRadius = g.sceneSettings.value.detailTilesAcross / 2;
      let expected = 0, complete = 0;
      for (let dy = -Math.ceil(radius); dy <= Math.ceil(radius); dy++) {
        if (y + dy < 0 || y + dy >= scale) continue;
        for (let dx = -Math.ceil(radius); dx <= Math.ceil(radius); dx++) {
          const detail = worldTileIntersectsCircle(dx, dy, coordinates.x - x, coordinates.y - y, detailRadius);
          if (!detail && !worldTileIntersectsCircle(dx, dy, coordinates.x - x, coordinates.y - y, radius)) continue;
          expected++;
          const tile = g.tiles.get(`${g.gridLevel}/${((x + dx) % scale + scale) % scale}/${y + dy}`);
          if (tile?.sceneryRevision === g.sceneryRevision && (detail ? tile.detailed && tile.nativeTerrain
            : tile && (tile.detailed || (tile.farTreeField && tile.farBuildings && tile.farRoads)))) complete++;
        }
      }
      return { expected, complete };
    } };
  await game.initialize((step) => {
    probe.performanceProgress = step;
    if (new URLSearchParams(location.search).has('oslo-walk')) {
      // Spawn facing the route; do not introduce a camera turn at walk start.
      (game as any).flyCamera?.rotation.set(0, -Math.PI / 2, 0);
    }
  });
  document.getElementById('loading')?.remove();
  game.run();
  probe.performanceReady = true;
})().catch(error => { probe.performanceError = String(error?.stack ?? error); });
