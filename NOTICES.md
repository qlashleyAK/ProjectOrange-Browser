# Third-party notices

Project Orange is MIT-licensed (see LICENSE). This file attributes the
third-party software it builds on, per those projects' license terms.

License census of the dependency tree (generated from `pnpm-lock.yaml` +
the npm registry, 2026-10-18): 67 MIT, 3 Apache-2.0, 1 Zlib, 0 copyleft.

## Notable dependencies

| Project | License | Use |
|---|---|---|
| [three.js](https://threejs.org) (`three`, `@types/three`) | MIT | rendering |
| [Rapier](https://rapier.rs) — `@dimforge/rapier3d-deterministic-compat`, `@dimforge/rapier3d-compat` | Apache-2.0 | deterministic physics sim (client + server + bots) |
| [postprocessing](https://github.com/pmndrs/postprocessing) | Zlib | render effects |
| [TypeScript](https://www.typescriptlang.org) | Apache-2.0 | language/tooling |
| [Vite](https://vite.dev) (`vite`, `@rolldown/*`) | MIT | client build |
| [Vitest](https://vitest.dev) (`vitest`, `@vitest/*`) | MIT | tests |
| [esbuild](https://esbuild.github.io) (`esbuild`, `@esbuild/*`) | MIT | server build |
| [ws](https://github.com/websockets/ws) (`ws`, `@types/ws`) | MIT | multiplayer transport |
| [tween.js](https://github.com/tweenjs/tween.js) | MIT | animation |
| [tsx](https://github.com/privatenumber/tsx) | MIT | dev runner |

All other dependencies and transitive packages are MIT-licensed; the full
list is reproducible from `pnpm-lock.yaml` and each package's `LICENSE` file
inside `node_modules`.
