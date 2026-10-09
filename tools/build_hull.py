"""Data-only Blender export for the silhouette visual-hull control experiment."""
import bpy
import bmesh
import json
import sys
from pathlib import Path
from mathutils import Vector

args = sys.argv[sys.argv.index('--') + 1:]
source, destination = [Path(value).resolve() for value in args]
job = json.loads(source.read_text(encoding='utf-8'))
destination.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.unit_settings.system = 'METRIC'
scene.unit_settings.scale_length = 0.001
bpy.context.preferences.filepaths.save_version = 0
mesh = bpy.data.meshes.new('三视图轮廓约束网格')
mesh.from_pydata(job['vertices'], [], job['faces'])
mesh.update()
obj = bpy.data.objects.new('轮廓视觉外壳 · 非精确重建', mesh)
scene.collection.objects.link(obj)
color = mesh.color_attributes.new(name='SourceColor', type='BYTE_COLOR', domain='CORNER')
values = []
for face_color, polygon in zip(job['faceColors'], mesh.polygons):
    linear_color = [value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4 for value in face_color]
    for _ in polygon.loop_indices:
        values.extend([*linear_color, 1.0])
color.data.foreach_set('color', values)
mesh.color_attributes.active_color_index = 0
material = bpy.data.materials.new('原图多视角颜色重投影')
material.use_nodes = True
vertex = material.node_tree.nodes.new('ShaderNodeVertexColor')
vertex.layer_name = 'SourceColor'
shader = next(node for node in material.node_tree.nodes if node.type == 'BSDF_PRINCIPLED')
material.node_tree.links.new(vertex.outputs['Color'], shader.inputs['Base Color'])
shader.inputs['Roughness'].default_value = 0.9
mesh.materials.append(material)
obj['method'] = job['metrics']['algorithm']
obj['not_measured'] = True
obj['limitations'] = json.dumps(job['metrics']['algorithmLimits'])
bm = bmesh.new()
bm.from_mesh(mesh)
checks = {'boundaryEdges': sum(edge.is_boundary for edge in bm.edges), 'nonManifoldEdges': sum(not edge.is_manifold for edge in bm.edges), 'volumeMm3': abs(bm.calc_volume(signed=True)), 'vertices': len(bm.verts), 'faces': len(bm.faces)}
bm.free()
coords = [Vector(vertex.co) for vertex in mesh.vertices]
low = Vector(tuple(min(v[axis] for v in coords) for axis in range(3)))
high = Vector(tuple(max(v[axis] for v in coords) for axis in range(3)))
center = (low + high) / 2
size = max(high - low)
camera_data = bpy.data.cameras.new('对照相机')
camera = bpy.data.objects.new('对照相机', camera_data)
scene.collection.objects.link(camera)
scene.camera = camera
scene.render.engine = 'BLENDER_WORKBENCH'
scene.display.shading.light = 'FLAT'
scene.display.shading.color_type = 'VERTEX'
scene.display.shading.background_type = 'WORLD'
scene.world = bpy.data.worlds.new('白底')
scene.world.color = (1, 1, 1)
scene.view_settings.view_transform = 'Standard'
scene.render.resolution_x = 640
scene.render.resolution_y = 640
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
for name, direction in [('front', (0, -1, 0)), ('side', (1, 0, 0)), ('back', (0, 1, 0)), ('perspective', (1.4, -1.8, 1.35))]:
    camera.location = center + Vector(direction).normalized() * size * 3
    camera.rotation_euler = (center - camera.location).to_track_quat('-Z', 'Y').to_euler()
    camera_data.type = 'ORTHO'
    camera_data.ortho_scale = size * 1.35
    scene.render.filepath = str(destination / (name + '.png'))
    bpy.ops.render.render(write_still=True)
bpy.context.view_layer.objects.active = obj
obj.select_set(True)
bpy.ops.export_scene.gltf(filepath=str(destination / 'model.glb'), export_format='GLB', use_selection=True)
bpy.ops.wm.save_as_mainfile(filepath=str(destination / 'model.blend'))
(destination / 'summary.json').write_text(json.dumps({'method': job['metrics']['algorithm'], 'checks': checks, 'limitations': job['metrics']['algorithmLimits']}, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'checks': checks}))
