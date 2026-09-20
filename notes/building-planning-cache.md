# Floor planning profile and cache

## Shared Stair Reservations

Matching complex floor footprints now share a deduplicated set of all stair,
landing and roof-access clearances used anywhere in that footprint group.
Footprint matching includes courtyard holes and ignores ring start/winding and
hole ordering. The same reservations are used for layout planning and fallback
interior contents. Actual stair flights and slab openings remain attached only
to their real floor connections; this does not punch unused holes through slabs.

This intentionally changes some floor layouts: space occupied by the common
stair core on another floor is also kept clear on this floor. Entrances and
different footprints can still require different layouts.

The real-map capture now has 28 unique requests out of 40, versus 34 before
sharing reservations. Five isolated cold-cache replays measured building-layout
time of 812 ms and apartment-layout time of 303 ms. The original uncached
profile below measured 1,286 ms and 317 ms respectively. These are planner CPU
measurements, not browser loading times. The current local input/profile
artifacts reflect shared reservations, so old expected-output captures must
not be used as an equality baseline for this intentional layout change.

Validation: 32 targeted tests passed, including actual stair access, floor
constraints, worker geometry parity, cache isolation, and new floor-reuse tests
for courtyard and multi-tower buildings at two scene scales. TypeScript passed.

## Measured Bottleneck

The real-map building in `scripts/benchmark-building-planning.mjs` makes 20
building-layout and 20 apartment-layout requests. Before caching, five isolated
replays measured median totals of 1,286 ms for building layouts and 317 ms for
apartment layouts. The two slowest building requests took 522 and 567 ms and
produced 504 and 507 apartment pieces, respectively.

Shared-wall detection (`longestSharedSegment`) accounted for 3,531 ms of the
7,241 ms sampled inside planner execution over five replays. Its nested
`overlappingSegment` checks and temporary `ringEdges` generator arrays dominate.
GC was another 763 ms, not attributed to individual planner stacks.

Only six whole requests were exact duplicates. That comparison misses reuse
inside the planners: the two slowest floors have identical footprints and
openings, but different stair clearances. Their unconstrained base plan can be
shared even though their final floor plans must differ.

## Implementation

- Cache building layouts in their local planning frame, including the recursive
  unconstrained base plan used before applying floor voids and stair clearances.
- Cache individual apartment layouts in their local frame, keyed by geometry,
  openings and the effective room-size target. Seed-derived size variation is
  therefore preserved.
- Keys retain opening IDs/order, polygon ordering, holes, building type and
  circulation constraints. No approximate coordinate matching is used.
- Return independent copies on hits; retain an independent copy on misses.
  Cached plans cannot be modified by subsequent floor-specific work.
- Use LRU eviction: building plans have an 8 MiB serialized-size budget and
  256-entry cap; apartments have 16 MiB and 4,096 entries. These are storage
  estimates, not exact JS heap measurements. Exceptions are not cached.
- Both the existing worker and synchronous path use the same planner caches.

## Verification

Five sequential replays of the captured 40 requests, with checks outside the
timed region against outputs saved before the code change:

| Mode | Median planning time |
| --- | ---: |
| Cache bypassed | 1,533 ms |
| Empty caches at start of each building | 1,271 ms |
| Layouts already cached | 89 ms |

That is a 17% improvement on this first build and 94% on repeated requests.
The latter is reuse of an already planned workload, not a first-load claim.
The cold run reused six building subplans and 75 apartment plans. Warm runs
reused all 20 building plans and 1,335 apartment plans. The remaining 96
apartment attempts hit existing invalid-layout fallbacks and are retried.
All captured outputs matched exactly after JSON serialization.

These are CPU-only planner measurements, excluding exterior mesh generation,
worker communication, frame scheduling and GPU work. The adjacency
algorithm itself was not changed in this optimization.

Run the original profile/capture and compare cold/warm planning with:

```powershell
yarn node --import ./tests/register-typescript.mjs scripts/benchmark-building-planning.mjs --profile
yarn node --import ./tests/register-typescript.mjs scripts/benchmark-building-planning-cache.mjs
```

The cache benchmark accepts an input capture path and optional pre-change
expected-results path as its two positional arguments. Local validation used
`.building-planning-inputs.json` and `.building-planning-expected.json`.
