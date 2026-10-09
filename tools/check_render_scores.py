"""Independent silhouette check on actual Blender PNGs; not the fitting proxy."""
import json
from pathlib import Path
import sys
import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from visual_hull import extract_silhouette

root = Path(__file__).resolve().parents[1] / 'data' / 'character-test'
image = cv2.imdecode(np.frombuffer((root / 'source.png').read_bytes(), np.uint8), cv2.IMREAD_COLOR)
panels = {'front': (25, 28, 180, 265), 'side': (187, 28, 327, 265), 'back': (331, 28, 471, 265)}
canvas_size = 256
height_px = 213

def normalize(mask):
    rows, cols = np.where(mask != 0)
    if not len(rows):
        raise ValueError('Empty silhouette')
    cropped = mask[rows.min():rows.max()+1, cols.min():cols.max()+1]
    width = max(1, round(cropped.shape[1] / cropped.shape[0] * height_px))
    resized = cv2.resize(cropped, (width, height_px), interpolation=cv2.INTER_NEAREST)
    canvas = np.zeros((canvas_size, canvas_size), np.uint8)
    left = (canvas_size - width) // 2
    if width > canvas_size:
        resized = resized[:, -left:-left+canvas_size]
        left = 0
    top = (canvas_size - height_px) // 2
    canvas[top:top+height_px, left:left+resized.shape[1]] = resized
    return canvas != 0

targets = {name: normalize(extract_silhouette(image, panel)['mask']) for name, panel in panels.items()}
results = {}
all_panels = []
for label, directory in [('baseline', 'output'), ('fitted', 'fitted-output')]:
    per_view = {}
    for name, target in targets.items():
        raster = cv2.imdecode(np.frombuffer((root / directory / (name + '.png')).read_bytes(), np.uint8), cv2.IMREAD_COLOR)
        mask = cv2.cvtColor(raster, cv2.COLOR_BGR2GRAY) < 246
        prediction = normalize(mask.astype(np.uint8) * 255)
        intersection = np.count_nonzero(prediction & target)
        union = np.count_nonzero(prediction | target)
        per_view[name] = round(intersection / union, 5)
        overlay = np.full((canvas_size, canvas_size, 3), 255, np.uint8)
        overlay[target] = [100, 220, 170]
        overlay[prediction] = [220, 160, 100]
        overlay[target & prediction] = [90, 100, 80]
        cv2.putText(overlay, f'{label}/{name} IoU={per_view[name]:.3f}', (5, 15), cv2.FONT_HERSHEY_SIMPLEX, .39, (0, 0, 0), 1)
        all_panels.append(overlay)
    results[label] = {'perViewIou': per_view, 'meanIou': round(sum(per_view.values()) / 3, 5)}
results['limitations'] = ['Uses the same supplied views as fitting; does not measure unseen-view generalization.', 'Silhouette overlap does not evaluate texture, facial detail, concavity or overall artistic quality.', 'Images are aligned by height and bounding-box center; real camera pose and scale are not measured.']
(root / 'render-score.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
success, encoded = cv2.imencode('.png', np.vstack([np.hstack(all_panels[:3]), np.hstack(all_panels[3:])]))
if success:
    (root / 'actual-render-comparison.png').write_bytes(encoded.tobytes())
print(json.dumps(results))
