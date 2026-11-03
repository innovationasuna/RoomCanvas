# Tests

Run from `room-reconstruction/` after installing the development dependency group:

```bash
uv run pytest -q
uv run pytest -m blender
```

The [pytest configuration](../pyproject.toml) excludes `blender`, `scan`, and
`live` tests by default. Blender tests require `LITEREALITY_BLENDER`;
scan tests require capture data; live tests can invoke paid services.

## Coverage

| Test file | Contract |
|---|---|
| [test_architecture.py](test_architecture.py) | Package dependency boundaries |
| [test_scan_inference.py](test_scan_inference.py) | Scan discovery from room paths and environment |
| [test_capability_tools.py](test_capability_tools.py) | Capability schemas and tool reachability |
| [test_surfaces.py](test_surfaces.py) | Surface discovery and ordering |
| [test_agent_trace.py](test_agent_trace.py) | Trace events and failure isolation |
| [test_projection.py](test_projection.py) | Projection validity and visibility masks |
| [test_module_paths.py](test_module_paths.py) | Module strings used by entry points/subprocesses |
| [test_console.py](test_console.py) | Stage display and reconstruction accounting |
| [test_scan_input.py](test_scan_input.py) | Capture-name and folder resolution |
| [test_scene_package.py](test_scene_package.py) | Portable package paths and argument binding |

## Conventions

[conftest.py](conftest.py) provides `stage_tree` with both symlinked and
physical paths, and isolates `LITEREALITY_SCAN` between tests.
Use fixtures matching the real artifact layout when testing path discovery.
Async calls can be driven with `asyncio.run` inside synchronous tests.

Offline tests validate code contracts; they do not establish GPU inference,
capture-specific reconstruction quality, or final scene acceptance.
