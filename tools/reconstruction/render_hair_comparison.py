"""Blender-only neutral-clay review of two local generation runs.

Invoke Blender with --background --python this_file -- --baseline RUN --candidate RUN.
This renders actual full-resolution meshes; it does not modify either asset.
"""

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
GENERATED = ROOT / "data" / "reconstruction" / "generated"
OUTPUT = ROOT / "data" / "hair-diagnosis"


def source_run(run_id):
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", run_id):
        raise ValueError("invalid local generation run identifier")
    directory = GENERATED / run_id
    report = json.loads((directory / "generation.json").read_text(encoding="utf-8"))
    path = directory / "print-ready-z-up-full.stl"
    if path.resolve().parent != directory.resolve() or not path.is_file():
        raise ValueError("full local mesh is missing")
    if hashlib.sha256(path.read_bytes()).hexdigest() != report["fullPrintMesh"]["sha256"]:
        raise ValueError("full local mesh no longer matches generation evidence")
    return path, report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--candidate", required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    sources = {name: source_run(run_id) for name, run_id in
               (("baseline", args.baseline), ("candidate", args.candidate))}
    out = OUTPUT / (args.candidate + "-compare")
    out.mkdir(parents=True, exist_ok=False)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    objects, reports = {}, {}
    for name, run_id in (("baseline", args.baseline), ("candidate", args.candidate)):
        path, report = sources[name]
        bpy.ops.wm.stl_import(filepath=str(path))
        obj = bpy.context.selected_objects[0]
        obj.name = name
        material = bpy.data.materials.new(name + " neutral clay")
        material.diffuse_color = (0.34, 0.42, 0.54, 1.0)
        obj.data.materials.append(material)
        objects[name] = obj
        reports[name] = {"runId": run_id, "settings": report["settings"],
                         "mesh": report["fullPrintMesh"], "runtime": report["runtime"],
                         "inputViews": report["inputViews"]}

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    shading = scene.display.shading
    shading.light = "STUDIO"
    shading.studio_light = "paint.sl"
    shading.color_type = "MATERIAL"
    shading.show_shadows = True
    shading.show_cavity = True
    shading.cavity_type = "BOTH"
    shading.show_specular_highlight = True
    shading.background_type = "WORLD"
    scene.world = bpy.data.worlds.new("Neutral review background")
    scene.world.color = (0.94, 0.94, 0.94)
    scene.view_settings.view_transform = "Standard"
    scene.render.resolution_x = scene.render.resolution_y = 720
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    camera_data = bpy.data.cameras.new("Same-view hair comparison")
    camera = bpy.data.objects.new("Same-view hair comparison", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = 68.0
    camera_data.clip_start, camera_data.clip_end = 0.05, 1000
    target = Vector((0, 0, 66))
    views = {"front": Vector((0, -1, 0)), "left": Vector((-1, 0, 0)), "back": Vector((0, 1, 0))}
    for name in objects:
        for obj_name, obj in objects.items():
            obj.hide_render = obj_name != name
        for view, direction in views.items():
            camera.location = target + direction * 200
            camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
            scene.render.filepath = str(out / f"{name}-{view}.png")
            bpy.ops.render.render(write_still=True)
    evidence = {"runs": reports, "render": {"engine": scene.render.engine, "material": "neutral clay; no texture",
                "targetMm": list(target), "orthoScaleMm": 68, "resolutionPx": [720, 720],
                "viewDirections": {k: list(v) for k, v in views.items()}},
                "scope": "same-view qualitative geometry comparison; no calibrated geometry ground truth"}
    (out / "comparison.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("HAIR_COMPARISON_RENDERED", out)


if __name__ == "__main__":
    main()
