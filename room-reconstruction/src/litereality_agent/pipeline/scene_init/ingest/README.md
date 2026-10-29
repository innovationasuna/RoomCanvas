# Ingest

Ingest turns a RoomPlan capture into reconstruction evidence:

```text
capture → scene extraction → merged boxes → layout → crops → detection → references
```

[ingest.run(context, options)](__init__.py) launches the scene-init flow.
Artifacts live under `scene_init/obj_stage/object_init/`.
Reuse requires summary/reference outputs and valid layout state, including the
current box-merge policy.

## Components

- [extract](extract/): RoomPlan, camera, RGB, and depth data.
- [merge_boxes.py](merge_boxes.py): combine boxes representing one object.
- [layout](../layout/README.md): repair and validate boxes before cropping.
- [crop](crop/) and [detect](detect/): produce and refine object views.
- [references](references/): select evidence and generate clean object/opening images.

Model implementations and runtime selection belong to `models`.
Reference-image generation uses the configured provider; OpenAI is the default,
with Gemini available through `LR_IMAGE_PROVIDER`.

## Preprocessing

[preprocessing/scene_data.py](preprocessing/scene_data.py) and
[preprocessing/object_images.py](preprocessing/object_images.py) adapt the
preprocessing algorithms to project settings, including `LR_ENLARGED_CROP_OBJECTS`.

| Module under [preprocessing/vendor/litereality](preprocessing/vendor/litereality/) | Role |
|---|---|
| `scene_preprocessing.py` | Parse scenes and prepare camera/crop data |
| `object_image_extraction.py` | Project point clouds, rank views, and write crops |
| `roomplan.py` | Read RoomPlan USD and RGBD data |
| `scanner_capture.py` | Load capture frames and camera data |

Keep workflow decisions and project configuration in the adapters and pipeline.
