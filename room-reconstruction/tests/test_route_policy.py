"""$LR_ROUTE_POLICY / $LR_ROUTE_OVERRIDE, and routing that stays put across reruns.

No model is called: the classifier is replaced by a table of answers, which is the point — what is
under test is what the router does with an answer, and when it asks at all.
"""

from __future__ import annotations

import json

import pytest

from litereality_agent.pipeline.scene_init import paths as config
from litereality_agent.pipeline.scene_init.reconstruct.classify import classify_complexity as cc

SCAN = "policy-scan"


def answer(route="procedural", organic=False, footprint=None):
    out = {"route": route, "complexity": "low", "is_organic": organic,
           "primitive_buildable": route == "procedural", "reason": "test"}
    if footprint:
        out["footprint"] = footprint
    return out


@pytest.mark.parametrize(("kind", "category", "decision", "expected"), [
    # Storage of any kind, merged units included, whatever the classifier said about its route.
    ("objects", "storage", answer("trellis"), "procedural"),
    ("objects", "sink storage", answer("trellis"), "procedural"),
    ("objects", "bookshelf", answer("procedural"), "procedural"),
    ("objects", "cabinet", answer("trellis"), "procedural"),
    ("objects", "wardrobe", answer("trellis"), "procedural"),
    # ...unless the always-trellis rule applies: organic shape or an organic category.
    ("objects", "storage", answer("procedural", organic=True), "trellis"),
    ("objects", "sofa storage", answer("procedural"), "trellis"),
    # Tables and desks only when the classifier calls them plainly rectangular.
    ("objects", "table", answer("procedural", footprint="rectangular"), "procedural"),
    ("objects", "table", answer("trellis", footprint="rectangular"), "procedural"),
    ("objects", "desk", answer("procedural", footprint="rectangular"), "procedural"),
    ("objects", "table", answer("procedural", footprint="round"), "trellis"),
    ("objects", "table", answer("procedural", footprint="irregular"), "trellis"),
    ("objects", "table", answer("procedural", footprint="other"), "trellis"),
    ("objects", "table", answer("procedural"), "trellis"),  # no footprint: not rectangular
    # Everything else goes to TRELLIS, regular-looking or not.
    ("objects", "television", answer("procedural"), "trellis"),
    ("objects", "refrigerator", answer("procedural"), "trellis"),
    ("objects", "oven", answer("procedural", footprint="rectangular"), "trellis"),
    ("objects", "sofa", answer("procedural"), "trellis"),
    ("chairs", "chair", answer("procedural", footprint="rectangular"), "trellis"),
])
def test_trellis_first_policy(kind, category, decision, expected):
    assert cc.apply_policy(kind, category, decision, "trellis-first")["route"] == expected


@pytest.mark.parametrize(("kind", "category", "decision", "expected"), [
    ("objects", "storage", answer("trellis"), "trellis"),
    ("objects", "television", answer("procedural"), "procedural"),
    ("objects", "table", answer("procedural", footprint="round"), "procedural"),
    ("objects", "storage", answer("procedural", organic=True), "trellis"),
    ("chairs", "chair", answer("procedural"), "trellis"),
])
def test_without_a_policy_the_classifier_decides_as_before(kind, category, decision, expected):
    assert cc.apply_policy(kind, category, decision)["route"] == expected


def test_an_unknown_policy_is_an_error(monkeypatch):
    monkeypatch.setenv("LR_ROUTE_POLICY", "trellis-only")
    with pytest.raises(ValueError, match="unknown policy"):
        cc.route_policy()
    monkeypatch.delenv("LR_ROUTE_POLICY")
    assert cc.route_policy() == ""


def test_overrides_are_checked_against_routes_and_names(monkeypatch):
    names = {"Table0", "Sofa0"}
    monkeypatch.setenv("LR_ROUTE_OVERRIDE", " Table0=trellis , Sofa0=procedural ")
    assert cc.route_overrides(names) == {"Table0": "trellis", "Sofa0": "procedural"}
    monkeypatch.setenv("LR_ROUTE_OVERRIDE", "Table0=neural")
    with pytest.raises(ValueError, match="unknown route"):
        cc.route_overrides(names)
    monkeypatch.setenv("LR_ROUTE_OVERRIDE", "Tabel0=trellis")
    with pytest.raises(ValueError, match="Tabel0 not routed.*Sofa0, Table0"):
        cc.route_overrides(names)
    monkeypatch.setenv("LR_ROUTE_OVERRIDE", "Table0")
    with pytest.raises(ValueError, match="expected Name=value"):
        cc.route_overrides(names)


@pytest.fixture
def scan(monkeypatch):
    """Three object references and a classifier whose answers the test controls."""
    config.set_scan(SCAN)
    for name in ("Table0", "Storage0", "Television0"):
        ref = config.object_refs_root() / SCAN / name / "reference_1024.png"
        ref.parent.mkdir(parents=True, exist_ok=True)
        ref.write_bytes(name.encode())
    answers = {"Table0": answer("procedural", footprint="rectangular"),
               "Storage0": answer("procedural"), "Television0": answer("procedural")}
    asked = []

    def classify_image(ref, prompt, schema, model=None):
        name = ref.parent.name
        asked.append((name, "footprint" in prompt, "footprint" in schema["properties"]))
        return dict(answers[name])

    monkeypatch.setattr(cc.classification, "classify_image", classify_image)
    for var in ("LR_ROUTE_POLICY", "LR_ROUTE_OVERRIDE", "LR_PROVIDED_MODELS"):
        monkeypatch.delenv(var, raising=False)
    return answers, asked


def routes():
    return {r["name"]: r["route"] for r in cc.classify_for_scan(SCAN)["records"]}


def test_the_footprint_is_asked_only_under_the_policy(scan, monkeypatch):
    _, asked = scan
    routes()
    assert {(f1, f2) for _, f1, f2 in asked} == {(False, False)}
    monkeypatch.setenv("LR_ROUTE_POLICY", "trellis-first")
    asked.clear()
    assert routes() == {"Table0": "procedural", "Storage0": "procedural", "Television0": "trellis"}
    assert {(f1, f2) for _, f1, f2 in asked} == {(True, True)}


def test_an_override_wins_over_the_policy(scan, monkeypatch):
    monkeypatch.setenv("LR_ROUTE_POLICY", "trellis-first")
    monkeypatch.setenv("LR_ROUTE_OVERRIDE", "Table0=trellis,Television0=procedural")
    got = cc.classify_for_scan(SCAN)["records"]
    assert {r["name"]: r["route"] for r in got} == {
        "Table0": "trellis", "Storage0": "procedural", "Television0": "procedural"}
    assert all(r.get("forced_by_override") for r in got if r["name"] != "Storage0")


def test_a_rerun_keeps_each_decision_until_what_it_was_made_from_changes(scan, monkeypatch):
    answers, asked = scan
    first = routes()
    assert len(asked) == 3
    # The classifier would now answer differently; nothing it decided from has changed.
    answers["Table0"] = answers["Television0"] = answer("trellis")
    asked.clear()
    assert routes() == first and asked == []
    # A new reference image re-decides that object only.
    (config.object_refs_root() / SCAN / "Table0" / "reference_1024.png").write_bytes(b"new")
    assert routes()["Table0"] == "trellis"
    assert [name for name, *_ in asked] == ["Table0"]
    # An override on one object re-decides that object only.
    asked.clear()
    monkeypatch.setenv("LR_ROUTE_OVERRIDE", "Storage0=trellis")
    assert routes()["Storage0"] == "trellis" and [name for name, *_ in asked] == ["Storage0"]
    # A policy change re-decides everything.
    asked.clear()
    monkeypatch.setenv("LR_ROUTE_POLICY", "trellis-first")
    routes()
    assert sorted(name for name, *_ in asked) == ["Storage0", "Table0", "Television0"]
    manifest = json.loads((config.work_root() / "routing" / "routing_manifest.json").read_text())
    assert all(r["decided_from"]["policy"] == "trellis-first" for r in manifest["scans"][SCAN])


def test_a_failed_classification_is_asked_again(scan, monkeypatch):
    _, asked = scan

    def broken(*_args, **_kwargs):
        raise RuntimeError("rate limited")

    monkeypatch.setattr(cc.classification, "classify_image", broken)
    assert set(routes().values()) == {"trellis"}
    monkeypatch.setattr(cc.classification, "classify_image",
                        lambda ref, *_a, **_k: asked.append(ref.parent.name) or answer("procedural"))
    assert set(routes().values()) == {"procedural"} and len(asked) == 3
