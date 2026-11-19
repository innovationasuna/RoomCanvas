"""What Astra is asked about each item, and how its answers are read.

One question per item: drop it, keep the procedural model, or rebuild it with TRELLIS. A
read-only image question through `ask_images`; the harness is the `agent` role's (Codex / GPT-6
Astra).
"""

from __future__ import annotations

import json

DECISIONS = ("drop", "procedural", "trellis")
POLICIES = ("trellis-first",)  # LR_SMALL_OBJECTS_POLICY; unset keeps GUIDANCE as it is

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

# The operator's choice for a run where the small things matter (they named them in the author's
# notes and photographed them): rebuild what can be seen, rather than drop what is merely small.
TRELLIS_FIRST = """\
This run's policy, set by the operator, comes before the choices above and any earlier guidance:
- Choose "trellis" whenever the images show the object well enough to recognise it, even when it
  is small, flat or printed (a bottle, a tissue box, a plant, a cardboard box).
- Choose "drop" only when there is no usable evidence of the object in any image.
- Choose "procedural" only for a trivially regular shape that the current model already matches
  and TRELLIS would not improve."""

VIEWS = """\
IMAGE 1 shows the whole capture frame with the object's region outlined in red. IMAGE 2 puts
the photo crop beside a render of the CURRENT MODEL from the same camera and crop. The remaining
images are more photo crops from other frames{undetected}."""

DECIDE = """\
You are reviewing one object in a 3D reconstruction of a real room: "{label}" (id {id},
category {category}{members}), about {size} metres (width x depth x height), {support}.
The current model of it was built from Blender primitives.

{images}

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
  "description": "<{describe}: what the real object looks like, e.g. 'a light-blue paper shopping
bag with rope handles'{otherwise}>"}}"""

def _support(item: dict) -> str:
    if item.get("rests_on"):
        return f"resting on {item['rests_on']}"
    if item.get("attached_to"):
        return f"attached to {item['attached_to']}"
    return "with no recorded support"


def decide_prompt(item: dict, detected: bool, photos: int = 0, policy: str | None = None,
                  describe: bool = False) -> str:
    """`photos` close-ups from the operator follow the scan's images; `describe` asks for the
    description whatever the decision, for a reference a forced or policy-made rebuild needs."""
    members = f", a stack of {len(item['members'])} objects" if len(item["members"]) > 1 else ""
    if item.get("views", True):
        images = VIEWS.format(
            undetected="" if detected else " (the detector could not confirm the object in any "
            "frame, so these crops come from the projected box and may miss it)")
    else:  # only the operator's photos show it
        images = "No capture frame shows the object."
    if photos:
        images += (f"\nThe last {photos} image(s) are close-up photos the operator took of this "
                   "very object for this run (not from the scan, no camera pose); they show it "
                   "best.")
    return DECIDE.format(
        label=item["label"], id=item["id"], category=item["category"], members=members,
        size=" x ".join(f"{v:.2f}" for v in item["size"]), support=_support(item),
        images=images,
        guidance=GUIDANCE + ("\n\n" + TRELLIS_FIRST if policy == "trellis-first" else ""),
        describe="always, whatever you decide" if describe else "for trellis",
        otherwise="" if describe else "; otherwise empty",
    )


def parse_force(text: str) -> dict[str, str]:
    """`LR_SMALL_OBJECTS_FORCE`, e.g. "Plant0=trellis,Bottle0=drop", as {id: decision}."""
    forced = {}
    for entry in filter(None, (part.strip() for part in (text or "").split(","))):
        oid, _, decision = entry.partition("=")
        oid, decision = oid.strip(), decision.strip().lower()
        if not oid or decision not in DECISIONS:
            raise ValueError(f"LR_SMALL_OBJECTS_FORCE: {entry!r} is not ID=" + "|".join(DECISIONS))
        forced[oid] = decision
    return forced


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
