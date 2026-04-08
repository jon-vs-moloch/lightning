# Backends

Lightning backends should implement the adapter contract in [src/core/adapter.ts](/Users/jon/Projects/lightning/src/core/adapter.ts).

Planned early backends:
- `llama.cpp`
- `MLX`
- later `vLLM`

The adapter should expose whether branch operations are:
- native
- emulated
- unsupported

This repository should not assume that all backends offer identical cache/state primitives.
