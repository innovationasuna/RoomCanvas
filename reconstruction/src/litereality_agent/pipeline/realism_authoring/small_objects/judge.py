"""What Astra is asked about each item, and how its answers are read.

One question per item: drop it, keep the procedural model, or rebuild it with TRELLIS. A
read-only image question through `ask_images`; the harness is the `agent` role's (Codex / GPT-6
Astra).
"""

from __future__ import annotations

import json

DECISIONS = ("drop", "procedural", "trellis")

GUIDANCE = """\
Observations from earlier tests in this project (guidance, not rules):
- TRELLIS works well when the photos show the object clearly and completely: soft or wrinkled
  things and complex shapes (duvets, pillows, shopping bags, bins) came out far more realistic
  than primitives.
- When the photos are blurry, tiny or the object is mostly hidden, TRELLIS tends to produce an
  unrelated object; and the reference image becomes a generic product rather than this one.
- Flat things (a sheet of music, a single closed book, a paper) gain nothing from TRELLIS;
  printed patterns blur into colour patches.
- A pile of books is best rebuilt as one object.
- Very small or barely visible things that do not matter to the room (bottles, magnets,
  markers) are better dropped than kept as a crude box."""

DECIDE = """\
You are reviewing one object in a 3D reconstruction of a real room: "{label}" (id {id},
category {category}{members}), about {size} metres (width x depth x height), {support}.
The current model of it was built from Blender primitives.

IMAGE 1 shows the whole capture frame with the object's region outlined in red. IMAGE 2 puts
the photo crop beside a render of the CURRENT MODEL from the same camera and crop. The remaining
images are more photo crops from other frames{undetected}.

Choose exactly one:
- "drop": remove it. Choose this when it is too small, too unclear in the photos, or too
  unimportant to be worth modelling, or when no model is likely to look like the real thing.
  A realistic room without it is better than one with an object that obviously looks fake.
- "procedural": keep the current primitive model. Choose this ONLY if the render in IMAGE 2
  already reads as the same object as the photo (shape, proportions, colour), e.g. a flat paper
  or a plain box-like thing.
- "trellis": rebuild it with an image-to-3D model from the photos. Choose this for soft,
  wrinkled or complex shapes that primitives cannot match, but only when the photos show the
  object clearly enough to generate it.

{guidance}

Reply with ONLY a JSON object:
{{"decision": "drop" | "procedural" | "trellis",
  "reason": "<one or two sentences>",
  "description": "<for trellis: what the real object looks like, e.g. 'a light-blue paper shopping
bag with rope handles'; otherwise empty>"}}"""

def _support(item: dict) -> str:
    if item.get("rests_on"):
        return f"resting on {item['rests_on']}"
    if item.get("attached_to"):
        return f"attached to {item['attached_to']}"
    return "with no recorded support"


def decide_prompt(item: dict, detected: bool) -> str:
    members = f", a stack of {len(item['members'])} objects" if len(item["members"]) > 1 else ""
    return DECIDE.format(
        label=item["label"], id=item["id"], category=item["category"], members=members,
        size=" x ".join(f"{v:.2f}" for v in item["size"]), support=_support(item),
        undetected="" if detected else " (the detector could not confirm the object in any "
        "frame, so these crops come from the projected box and may miss it)",
        guidance=GUIDANCE,
    )


def parse_json(text: str) -> dict:
    """The last JSON object in a reply; the model sometimes wraps it in prose or a code fence."""
    decoder, found, at = json.JSONDecoder(), None, 0
    while (at := text.find("{", at)) >= 0:
        try:
            value, end = decoder.raw_decode(text, at)
        except json.JSONDecodeError:
            at += 1
            continue
        if isinstance(value, dict):
            found = value
        at = end
    if found is None:
        raise ValueError(f"no JSON object in reply: {text[:200]!r}")
    return found


def parse_decision(text: str) -> dict:
    answer = parse_json(text)
    decision = str(answer.get("decision", "")).strip().lower()
    if decision not in DECISIONS:
        raise ValueError(f"unknown decision {decision!r}")
    return {"decision": decision, "reason": str(answer.get("reason", "")).strip(),
            "description": str(answer.get("description", "") or "").strip()}
