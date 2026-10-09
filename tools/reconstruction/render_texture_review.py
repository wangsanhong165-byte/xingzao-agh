"""Render actual GLB base-color textures without lighting embellishment."""
import bpy
import hashlib
import json
import sys
from pathlib import Path
from mathutils import Vector

args=sys.argv[sys.argv.index('--')+1:]
if len(args)!=2:
    raise SystemExit('expected input GLB and new output directory')
source=Path(args[0]).resolve(); out=Path(args[1]).resolve()
if source.suffix.lower()!='.glb' or not source.is_file():raise ValueError('GLB missing')
out.mkdir(exist_ok=False)
source_digest=hashlib.sha256(source.read_bytes()).hexdigest()
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(source))
scene=bpy.context.scene
objects=[obj for obj in scene.objects if obj.type=='MESH']
if not objects:raise RuntimeError('no mesh imported')
textures=[]
for obj in objects:
    for material in obj.data.materials:
        if not material or not material.use_nodes:raise ValueError('texture material missing')
        image_nodes=[node for node in material.node_tree.nodes if node.type=='TEX_IMAGE' and node.image]
        if len(image_nodes)!=1:raise ValueError('expected exactly one RGB texture')
        image=image_nodes[0].image
        textures.append({'name':image.name,'size':list(image.size)})
        nodes=material.node_tree.nodes;links=material.node_tree.links
        output=next(node for node in nodes if node.type=='OUTPUT_MATERIAL')
        for link in list(output.inputs['Surface'].links):links.remove(link)
        emission=nodes.new('ShaderNodeEmission');emission.inputs['Strength'].default_value=1
        links.new(image_nodes[0].outputs['Color'],emission.inputs['Color'])
        links.new(emission.outputs[0],output.inputs['Surface'])
scene.render.engine='BLENDER_EEVEE_NEXT'
scene.world=bpy.data.worlds.new('Neutral background');scene.world.use_nodes=True
next(node for node in scene.world.node_tree.nodes if node.type=='BACKGROUND').inputs['Color'].default_value=(.93,.93,.93,1)
scene.view_settings.view_transform='Standard';scene.view_settings.look='None'
scene.render.resolution_x=scene.render.resolution_y=576
scene.render.resolution_percentage=100;scene.render.image_settings.file_format='PNG'
points=[obj.matrix_world@Vector(corner) for obj in objects for corner in obj.bound_box]
lo=Vector([min(point[i] for point in points) for i in range(3)])
hi=Vector([max(point[i] for point in points) for i in range(3)])
center=(lo+hi)/2; extent=max(hi-lo)
camera_data=bpy.data.cameras.new('Fixed orthographic texture review')
camera=bpy.data.objects.new('Review camera',camera_data);scene.collection.objects.link(camera)
scene.camera=camera;camera_data.type='ORTHO';camera_data.ortho_scale=extent*1.2
camera_data.clip_start=extent*.001;camera_data.clip_end=extent*100
views={'front':(0,-1,0),'side-reference':(1,0,0),'back':(0,1,0),'unseen-side':(-1,0,0),'oblique':(1.3,-1.8,1.2)}
for name,direction in views.items():
    camera.location=center+Vector(direction).normalized()*extent*4
    camera.rotation_euler=(center-camera.location).to_track_quat('-Z','Y').to_euler()
    scene.render.filepath=str(out/(name+'.png'));bpy.ops.render.render(write_still=True)
assert hashlib.sha256(source.read_bytes()).hexdigest()==source_digest
record={'sourceSha256':source_digest,'renderMode':'RGB base-color texture linked to emission, no added lighting or geometry retouch','textures':textures,'viewsBlenderZUp':views,'bounds':[list(lo),list(hi)],'geometrySource':'glTF Y-up imported once to Blender Z-up'}
(out/'render-metadata.json').write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
print('PAINT_REVIEW_RENDERED')
