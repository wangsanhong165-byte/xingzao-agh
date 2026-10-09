"""Bounded local texture experiment, separate from AGH product execution.

Use the isolated texture environment and pinned model/source cache described in
docs/texture-model-first-run-2026-10-04.md. No network or model API is used.
The flat-illustration --skip-delight path is the currently validated path.
"""
import argparse
import gc
import hashlib
import json
import os
import sys
import time
from pathlib import Path

root=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(root/'tools/reconstruction'))
from texture_probe_core import geometry_signature,validate_mesh_bounds,validate_texture_options,ensure_new_output_directory,load_torch_checkpoint_on_meta
from texture_source_pins import verify_texture_source,PINNED_SOURCE_REVISION,PINNED_SOURCE_TREE
from gpu_reservation import reserve_gpu
from texture_uv_scale import unwrap_normalized_geometry,uv_quality_stats
source=root/'data/reconstruction/source-f8db630/Hunyuan3D-2-f8db63096c8282cb27354314d896feba5ba6ff8a'
sys.path.insert(0,str(source))
os.environ['HF_HUB_OFFLINE']='1'
os.environ['TRANSFORMERS_OFFLINE']='1'
os.environ['HF_HUB_DISABLE_IMPLICIT_TOKEN']='1'
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--mesh',type=Path,required=True)
parser.add_argument('--image',type=Path,required=True)
parser.add_argument('--run-id',required=True)
parser.add_argument('--texture-size',type=int,default=1024)
parser.add_argument('--render-size',type=int,default=512)
parser.add_argument('--views',type=int,choices=(4,6),default=4)
parser.add_argument('--offload',choices=('model','sequential'),default='model')
parser.add_argument('--skip-delight',action='store_true',help='flat-illustration experiment only; omit neural light removal')
args=parser.parse_args()
options=validate_texture_options(args.render_size,args.texture_size,args.run_id,30)
output=ensure_new_output_directory(root/'data/texture-experiments'/args.run_id)
def digest(path):
    h=hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda:stream.read(8*1024**2),b''):h.update(block)
    return h.hexdigest()
report={'status':'initializing','scope':'development texture-only experiment; not an AGH production run','options':{**{key:value for key,value in options.items() if key!='budget_steps'},'generatedViews':args.views,'referenceViews':1,'weightOffload':args.offload,'paintOuterRequestedSteps':30,'paintActualTurboTimesteps':10,'delightStepsPerReference':0 if args.skip_delight else 50,'delighting':'skipped explicitly for flat illustration' if args.skip_delight else 'learned removal'},'offloadScope':'model weights only; renderer, Turbo solver and condition tensors remain on GPU','sourceRevisionExpected':PINNED_SOURCE_REVISION,'sourceGitTreeExpected':PINNED_SOURCE_TREE,'inputMeshSha256':digest(args.mesh),'inputImageSha256':digest(args.image),'notValidated':['physical printing','face or hair reconstruction','PBR materials']}
started=time.monotonic()
def save():
    report['elapsedSeconds']=round(time.monotonic()-started,3)
    (output/'texture-probe.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
def stage(name):
    report['stage']=name;save();print(name,flush=True)
try:
    stage('verify-pinned-source-files')
    source_manifest=json.loads(Path(__file__).with_name('texture_source_manifest.json').read_text(encoding='utf8'))
    report['sourceVerification']=verify_texture_source(source,source_manifest)
    report['sourceRevision']=report['sourceVerification']['revision']
    save()
    import numpy as np
    import trimesh
    from PIL import Image
    import torch
    from diffusers import AutoencoderKL,UNet2DConditionModel,LCMScheduler,StableDiffusionInstructPix2PixPipeline,EulerAncestralDiscreteScheduler
    from transformers import CLIPTextModel,CLIPTokenizer,CLIPImageProcessor
    from hy3dgen.texgen.pipelines import Hunyuan3DTexGenConfig,Hunyuan3DPaintPipeline
    import hy3dgen.texgen.pipelines as paint_pipeline_module
    from hy3dgen.texgen.hunyuanpaint.pipeline import HunyuanPaintPipeline
    from hy3dgen.texgen.hunyuanpaint.unet.modules import UNet2p5DConditionModel
    from hy3dgen.texgen.utils.multiview_utils import Multiview_Diffusion_Net
    from hy3dgen.texgen.utils.dehighlight_utils import Light_Shadow_Remover
    from hy3dgen.texgen.differentiable_renderer.mesh_render import MeshRender
    if args.mesh.stat().st_size>25*1024**2:raise ValueError('mesh exceeds 25MiB probe bound')
    mesh=trimesh.load(args.mesh,process=False,force='mesh')
    validate_mesh_bounds(len(mesh.faces),args.mesh.stat().st_size)
    before_signature=geometry_signature(mesh.vertices,mesh.faces)
    report['inputGeometrySignature']=before_signature
    report['inputFaces']=len(mesh.faces)
    def normalized_uv_operator(candidate):
        unwrapped,proof=unwrap_normalized_geometry(candidate)
        report['uvNormalization']=proof
        report['uvHelperSha256']=digest(Path(__file__).with_name('texture_uv_scale.py'))
        save()
        return unwrapped
    # Bridge the upstream entry point in this single-use worker only; pinned
    # upstream files and final model coordinates remain unchanged.
    paint_pipeline_module.mesh_uv_wrap=normalized_uv_operator
    with Image.open(args.image) as original:
        if args.image.stat().st_size>5*1024**2 or original.width*original.height>12_000_000:raise ValueError('reference exceeds image bound')
        reference=original.convert('RGBA')
    manifest=json.loads((Path(__file__).with_name('texture_model_manifest.json')).read_text(encoding='utf-8'))
    cache=root/'data/reconstruction/modelcache/hunyuan3d-paint-probe'
    stage('verify-pinned-model-files')
    for item in manifest['files']:
        if args.skip_delight and item['path'].startswith('hunyuan3d-delight-v2-0/'):continue
        path=cache/item['path']
        if not path.is_file() or path.stat().st_size!=item['size']:raise FileNotFoundError('required pinned model file missing or wrong length: '+item['path'])
        actual=digest(path)
        if item['sha256'] and actual!=item['sha256']:raise ValueError('pinned model file hash mismatch: '+item['path'])
        if not item['sha256']:
            contents=path.read_bytes()
            blob=hashlib.sha1(b'blob '+str(len(contents)).encode('ascii')+b'\0'+contents).hexdigest()
            if blob!=item['gitBlobId']:raise ValueError('pinned model config blob mismatch: '+item['path'])
    report['modelRevision']=manifest['revision']
    with reserve_gpu(root,args.run_id):
        torch.manual_seed(0)
        torch.cuda.reset_peak_memory_stats()
        def cpu_offload(pipe):
            if args.offload=='model':pipe.enable_model_cpu_offload()
            else:pipe.enable_sequential_cpu_offload()
            pipe.vae.enable_slicing();pipe.vae.enable_tiling()
            pipe.set_progress_bar_config(disable=False)
        paint_dir=cache/'hunyuan3d-paint-v2-0-turbo'
        delight_dir=cache/'hunyuan3d-delight-v2-0'
        config=Hunyuan3DTexGenConfig(str(delight_dir),str(paint_dir),'hunyuan3d-paint-v2-0-turbo')
        config.device='cpu'
        config.render_size=args.render_size;config.texture_size=args.texture_size
        config.candidate_camera_azims=config.candidate_camera_azims[:args.views]
        config.candidate_camera_elevs=config.candidate_camera_elevs[:args.views]
        config.candidate_view_weights=config.candidate_view_weights[:args.views]
        if args.skip_delight:
            stage('skip-delighting-flat-illustration')
            delight=lambda image:image
        else:
            stage('load-delight-on-cpu')
            delight=Light_Shadow_Remover(config)
            cpu_offload(delight.pipeline)
        stage('load-turbo-unet-mmap-meta-strict')
        unet_config=json.loads((paint_dir/'unet/config.json').read_text(encoding='utf-8'))
        def factory():return UNet2p5DConditionModel(UNet2DConditionModel(**unet_config))
        unet=load_torch_checkpoint_on_meta(factory,paint_dir/'unet/diffusion_pytorch_model.bin',dtype=torch.float16)
        stage('load-paint-components-on-cpu')
        vae=AutoencoderKL.from_pretrained(str(paint_dir/'vae'),torch_dtype=torch.float16,local_files_only=True,low_cpu_mem_usage=True)
        text_encoder=CLIPTextModel.from_pretrained(str(paint_dir/'text_encoder'),torch_dtype=torch.float16,local_files_only=True,low_cpu_mem_usage=True)
        tokenizer=CLIPTokenizer.from_pretrained(str(paint_dir/'tokenizer'),local_files_only=True)
        feature_extractor=CLIPImageProcessor.from_pretrained(str(paint_dir/'feature_extractor'),local_files_only=True)
        scheduler=LCMScheduler.from_pretrained(str(paint_dir/'scheduler'),local_files_only=True)
        scheduler=LCMScheduler.from_config(scheduler.config,timestep_spacing='trailing')
        learned_pipeline=HunyuanPaintPipeline(vae=vae,text_encoder=text_encoder,tokenizer=tokenizer,unet=unet,scheduler=scheduler,feature_extractor=feature_extractor)
        learned_pipeline.set_turbo(True)
        report['executionFlags']={'pipelineTurbo':learned_pipeline.is_turbo,'unetTurbo':unet.is_turbo,'schedulerTimestepSpacing':scheduler.config.timestep_spacing,'attentionPath':'unchanged pinned official UNet flags; no claimed sparse position-mask acceleration'}
        cpu_offload(learned_pipeline)
        class ObservedMultiview(Multiview_Diffusion_Net):
            def __call__(self,input_images,control_images,camera_info):
                for i,img in enumerate(input_images):img.save(output/f'reference-centered-{i}.png')
                for i,img in enumerate(control_images):img.save(output/f'control-{i}.png')
                generated=super().__call__(input_images,control_images,camera_info)
                for i,img in enumerate(generated):img.save(output/f'generated-view-{i}.png')
                return generated
        multiview=object.__new__(ObservedMultiview)
        multiview.device='cpu';multiview.view_size=512;multiview.pipeline=learned_pipeline
        pipeline=object.__new__(Hunyuan3DPaintPipeline)
        pipeline.config=config
        pipeline.models={'delight_model':delight,'multiview_model':multiview}
        pipeline.render=MeshRender(default_resolution=args.render_size,texture_size=args.texture_size)
        original_bake=pipeline.bake_from_multiview
        def recorded_bake(*bake_args,**bake_kwargs):
            texture,mask=original_bake(*bake_args,**bake_kwargs)
            Image.fromarray(np.clip(texture.detach().cpu().numpy()*255,0,255).astype(np.uint8)).save(output/'pre-inpaint-atlas.png')
            Image.fromarray(mask.squeeze(-1).detach().cpu().numpy().astype(np.uint8)*255).save(output/'baked-trust-mask.png')
            report['bakedTrustedPixels']=int(mask.sum().item())
            report['bakeMaskMetricNote']='trusted atlas pixels only; not a surface-coverage or reconstruction-quality percentage'
            return texture,mask
        pipeline.bake_from_multiview=recorded_bake
        stage('run-delight-multiview-bake-inpaint')
        textured=pipeline(mesh.copy(),reference)
        torch.cuda.synchronize()
        after_signature=geometry_signature(textured.vertices,textured.faces)
        if before_signature!=after_signature:raise ValueError('texturing changed oriented triangle geometry')
        glb=output/'textured.glb'
        textured.export(glb)
        exported=trimesh.load(glb,process=False,force='mesh')
        exported_signature=geometry_signature(exported.vertices,exported.faces)
        if exported_signature!=before_signature:raise ValueError('GLB export changed oriented triangle geometry')
        if not hasattr(exported.visual,'uv') or exported.visual.uv is None:raise ValueError('exported GLB has no UV data')
        report['outputUvStatistics']=uv_quality_stats(exported.faces,exported.visual.uv)
        material=exported.visual.material
        image=getattr(material,'baseColorTexture',None)
        if image is None:image=getattr(material,'image',None)
        if not isinstance(image,Image.Image) or image.width<1 or image.height<1:raise ValueError('exported GLB has no decoded base-color texture image')
        image.save(output/'texture-atlas.png')
        report.update({'status':'generated-awaiting-visual-review','geometryPreservedAtFloat32':True,'outputGeometrySignature':exported_signature,'outputGlbSha256':digest(glb),'outputGlbBytes':glb.stat().st_size,'outputVertices':len(exported.vertices),'outputFaces':len(exported.faces),'textureSizePixels':list(image.size),'peakAllocatedGpuMiB':round(torch.cuda.max_memory_allocated()/2**20,1),'peakReservedGpuMiB':round(torch.cuda.max_memory_reserved()/2**20,1),'torch':torch.__version__,'colorModel':'Hunyuan3D-Paint-v2-0-Turbo RGB; complete compatible BIN state strictly assigned and converted from FP32 to FP16','visualReviewRequired':True})
        save()
        print(json.dumps({'status':report['status'],'glb':str(glb),'geometryPreservedAtFloat32':True}),flush=True)
except Exception as exc:
    report.update({'status':'failed','exception':type(exc).__name__,'message':str(exc).split('https:')[0][:1800]})
    save()
    print(json.dumps({'status':'failed','stage':report.get('stage'),'exception':type(exc).__name__,'message':report['message']},ensure_ascii=False),flush=True)
    raise SystemExit(1)
