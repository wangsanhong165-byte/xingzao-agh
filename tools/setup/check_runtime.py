"""Import/runtime smoke check; never loads neural-network weights or API credentials."""
import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--kind', choices=['cpu', 'shape', 'texture'], default='cpu')
    parser.add_argument('--gpu-smoke', action='store_true')
    args = parser.parse_args()
    import numpy as np
    import cv2
    import trimesh
    import scipy
    import rtree
    import manifold3d
    box = trimesh.creation.box()
    assert box.is_watertight and float(box.volume) > 0
    assert cv2.resize(np.zeros((2, 2, 3), dtype=np.uint8), (4, 4)).shape == (4, 4, 3)
    report = dict(kind=args.kind, python=sys.version.split()[0], prefix=sys.prefix,
                  meshImport=True, imageImport=True, modelWeightsLoaded=False)
    if args.kind != 'cpu':
        sys.path.insert(0, str(ROOT/'tools/reconstruction'))
        from texture_source_pins import verify_texture_source
        source = ROOT/'data/reconstruction/source-f8db630/Hunyuan3D-2-f8db63096c8282cb27354314d896feba5ba6ff8a'
        manifest = json.loads((ROOT/'tools/reconstruction/texture_source_manifest.json').read_text('utf-8'))
        report['source'] = verify_texture_source(source, manifest)
        sys.path.insert(0, str(source))
        import torch
        from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline
        report.update(torch=torch.__version__, torchCuda=torch.version.cuda, shapeImport=True)
        if args.kind == 'texture':
            import xatlas
            import mesh_processor
            import custom_rasterizer
            import custom_rasterizer_kernel
            from hy3dgen.texgen import Hunyuan3DPaintPipeline
            report.update(textureImport=True, nativeExtensions=True,
                          nativeModules={'rasterizer': custom_rasterizer_kernel.__file__,
                                         'meshProcessor': mesh_processor.__file__})
        if args.gpu_smoke:
            if not torch.cuda.is_available():
                raise RuntimeError('CUDA device is unavailable')
            value = torch.tensor([1.0], device='cuda')
            assert (value+1).item() == 2
            report.update(gpu=torch.cuda.get_device_name(), capability=torch.cuda.get_device_capability())
            if args.kind == 'texture':
                from custom_rasterizer.render import rasterize
                pos = torch.tensor([[[-.8, -.8, 0, 1], [.8, -.8, 0, 1], [0, .8, 0, 1]]], device='cuda')
                tri = torch.tensor([[0, 1, 2]], dtype=torch.int32, device='cuda')
                indices, barycentric = rasterize(pos, tri, (32, 32))
                visible = int((indices > 0).sum())
                assert visible > 0 and bool(torch.isfinite(barycentric).all())
                report['rasterVisiblePixels'] = visible
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
