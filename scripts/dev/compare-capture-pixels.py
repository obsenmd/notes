"""Report image differences for paired fixture captures; do not change the images."""
from pathlib import Path
from PIL import Image, ImageChops
import json
import sys

directory = Path(sys.argv[1] if len(sys.argv) > 1 else 'dist/todo-backup/bases-comparison')
results = {}
for reference_path in sorted(directory.glob('reference-*.png')):
    name = reference_path.stem.removeprefix('reference-')
    reference = Image.open(reference_path).convert('RGB')
    own = Image.open(directory / f'obsen-{name}.png').convert('RGB')
    if reference.size != own.size:
        results[name] = {'reference_size': reference.size, 'obsen_size': own.size}
        continue
    difference = ImageChops.difference(reference, own)
    changed = sum(1 for pixel in difference.get_flattened_data() if max(pixel) > 10)
    results[name] = {'size': reference.size, 'changed_percent_above_10': round(100 * changed / (reference.width * reference.height), 3)}
(directory / 'pixel-report.json').write_text(json.dumps(results, indent=2) + '\n')
print(json.dumps(results, indent=2))
