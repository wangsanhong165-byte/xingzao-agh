"""Fixed Blender batch tool: model JSON -> editable scene, orthographic views and mesh checks."""
import bpy
import bmesh
import json
import math
import os
import sys
from mathutils import Vector

args = sys.argv[sys.argv.index('--') + 1:]
input_path, output_dir = args
with open(input_path, encoding='utf-8') as stream:
    job = json.load(stream)
os.makedirs(output_dir, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.unit_settings.system = 'METRIC'
scene.unit_settings.scale_length = 0.001

def build_mesh(name, positions):
    if not positions or len(positions) % 9:
        raise ValueError('Expected triangle position array')
    vertices, faces, lookup = [], [], {}
    for start in range(0, len(positions), 9):
        face = []
        for step in (0, 3, 6):
            point = tuple(round(float(v), 6) for v in positions[start + step:start + step + 3])
            if not all(math.isfinite(v) for v in point):
                raise ValueError('Non-finite vertex')
            if point not in lookup:
                lookup[point] = len(vertices)
                vertices.append(point)
            face.append(lookup[point])
        if len(set(face)) == 3:
            faces.append(face)
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    scene.collection.objects.link(obj)
    return obj

obj = build_mesh('当前模型', job['mesh']['positions'])
baseline = build_mesh('原版对照', job['baselineMesh']['positions'])
baseline.hide_render = True
baseline.hide_set(True)
obj['spec_json'] = json.dumps(job['spec'], ensure_ascii=False)
obj['options_json'] = json.dumps(job.get('options', {}), ensure_ascii=False)
obj['说明'] = '参数请在照片建模工具中修改后重生成；此场景可进行普通网格编辑。'
obj.color = (0.05, 0.53, 0.49, 1)
baseline.color = (0.45, 0.48, 0.55, 1)
material = bpy.data.materials.new('青绿模型')
material.diffuse_color = obj.color
obj.data.materials.append(material)

bm = bmesh.new()
bm.from_mesh(obj.data)
checks = {
    'vertices': len(bm.verts),
    'triangles': len(bm.faces),
    'boundaryEdges': sum(1 for edge in bm.edges if edge.is_boundary),
    'nonManifoldEdges': sum(1 for edge in bm.edges if not edge.is_manifold),
    'volumeMm3': abs(bm.calc_volume(signed=True)),
}
bm.free()
coords = [Vector(vertex.co) for vertex in obj.data.vertices]
low = Vector(tuple(min(v[i] for v in coords) for i in range(3)))
high = Vector(tuple(max(v[i] for v in coords) for i in range(3)))
center = (low + high) / 2
checks['dimensionsMm'] = list(high - low)

camera_data = bpy.data.cameras.new('对照相机')
camera = bpy.data.objects.new('对照相机', camera_data)
scene.collection.objects.link(camera)
scene.camera = camera
camera_data.type = 'ORTHO'
scene.render.engine = 'BLENDER_WORKBENCH'
scene.display.shading.light = 'STUDIO'
scene.display.shading.color_type = 'MATERIAL'
scene.display.shading.show_shadows = False
scene.display.shading.show_cavity = True
scene.display.shading.cavity_type = 'BOTH'
scene.display.shading.background_type = 'WORLD'
scene.world = bpy.data.worlds.new('背景')
scene.world.color = (1.0, 1.0, 1.0)
scene.view_settings.view_transform = 'Standard'
scene.render.resolution_x = 640
scene.render.resolution_y = 640
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.film_transparent = False

extent = max(high - low)
distance = max(extent * 4, 50)
views = [('top', Vector((0, 0, 1))), ('front', Vector((0, -1, 0))), ('side', Vector((1, 0, 0)))]
for name, direction in views:
    camera.location = center + direction * distance
    camera.rotation_euler = (center - camera.location).to_track_quat('-Z', 'Y').to_euler()
    camera_data.ortho_scale = extent * 1.22
    scene.render.filepath = os.path.join(output_dir, name + '.png')
    bpy.ops.render.render(write_still=True)

camera.location = center + Vector((1.4, -1.8, 1.4)) * distance
camera.rotation_euler = (center - camera.location).to_track_quat('-Z', 'Y').to_euler()
bpy.context.view_layer.objects.active = obj
obj.select_set(True)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(output_dir, 'model.blend'))
with open(os.path.join(output_dir, 'checks.json'), 'w', encoding='utf-8') as stream:
    json.dump(checks, stream, ensure_ascii=False)
