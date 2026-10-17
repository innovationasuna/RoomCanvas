"""One isolated GPU process per preparation; one model load for all missing views."""
import argparse
import json
import os
from pathlib import Path
import time

from mask_images import save_prediction


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request', type=Path, required=True)
    parser.add_argument('--metrics', type=Path, required=True)
    args = parser.parse_args()
    started = time.monotonic()
    metrics = dict(status='running', images=[])
    try:
        import torch
        from torchvision import transforms
        from transformers import AutoModelForImageSegmentation
        from PIL import Image
        root = Path(os.environ['VIEWFORGE_ROOT'])
        config = json.loads((Path(__file__).resolve().parents[1]/'configs/birefnet.json').read_text())
        model_path = root/'weights/birefnet'
        # setup writes the pinned provenance next to the local snapshot.
        provenance = json.loads((model_path/'viewforge_revision.json').read_text())
        if provenance['revision'] != config['revision'] or provenance['model_id'] != config['model_id']:
            raise ValueError('Local BiRefNet revision does not match configs/birefnet.json')
        torch.set_float32_matmul_precision('high')
        model = AutoModelForImageSegmentation.from_pretrained(
            str(model_path), trust_remote_code=True, local_files_only=True).eval().half().to('cuda')
        transform = transforms.Compose([
            transforms.Resize((1024, 1024)), transforms.ToTensor(),
            transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])])
        metrics['model_load_seconds'] = round(time.monotonic() - started, 3)
        with torch.no_grad():
            for row in json.loads(args.request.read_text())['images']:
                tick = time.monotonic()
                with Image.open(row['image']) as source:
                    tensor = transform(source.convert('RGB')).unsqueeze(0).to('cuda').half()
                probability = model(tensor)[-1].sigmoid().cpu().float().squeeze(0).squeeze(0).numpy()
                save_prediction(row['image'], probability, row['mask'])
                metrics['images'].append(dict(name=row['name'], seconds=round(time.monotonic()-tick, 3)))
        torch.cuda.synchronize()
        metrics.update(status='complete', peak_allocated_mib=torch.cuda.max_memory_allocated()/2**20,
                       peak_reserved_mib=torch.cuda.max_memory_reserved()/2**20)
    except BaseException as exc:
        metrics.update(status='failed', error=str(exc))
        raise
    finally:
        metrics['elapsed_seconds'] = round(time.monotonic()-started, 3)
        args.metrics.write_text(json.dumps(metrics, ensure_ascii=False, indent=2)+'\n')


if __name__ == '__main__':
    main()
