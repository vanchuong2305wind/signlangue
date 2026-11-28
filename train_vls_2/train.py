import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np
import torch
from torch import nn
from torch.utils.data import Dataset, DataLoader
from torchvision.models.video import r2plus1d_18, R2Plus1D_18_Weights

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent / 'train_vls_1'))
from dataset import labels, rows, read_clip

WEIGHTS = R2Plus1D_18_Weights.KINETICS400_V1
EPOCHS = 30
CLASS_INDEX = {name: i for i, name in enumerate(labels)}

class Clips(Dataset):
    def __init__(self, split):
        self.rows = [r for r in rows if r['split'] == split]
        self.train = split == 'train'
        self.transform = WEIGHTS.transforms()

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, i):
        row = self.rows[i]
        frames = read_clip(row['ID_video'], jitter=self.train)
        frames = torch.from_numpy(frames).permute(0, 3, 1, 2)
        return self.transform(frames), CLASS_INDEX[row['Meaning']]

def make_model():
    model = r2plus1d_18(weights=WEIGHTS, progress=False)
    model.requires_grad_(False)
    model.fc = nn.Sequential(nn.Dropout(0.25), nn.Linear(model.fc.in_features, len(labels)))
    return model

@torch.inference_mode()
def evaluate(model, loader, device):
    model.eval()
    predictions, targets = [], []
    for x, y in loader:
        with torch.autocast(device.type, enabled=device.type == 'cuda'):
            top5 = model(x.to(device)).topk(5).indices.cpu()
        predictions.append(top5)
        targets.append(y)
    top5, y = torch.cat(predictions), torch.cat(targets)
    correct = top5[:, 0].eq(y)
    counts = y.bincount(minlength=len(labels))
    hits = y[correct].bincount(minlength=len(labels))
    return dict(top1=correct.float().mean().item(),
                macro=(hits[counts > 0] / counts[counts > 0]).mean().item(),
                top5=top5.eq(y[:, None]).any(1).float().mean().item())

def save(obj, path):
    temporary = path.with_suffix('.tmp')
    torch.save(obj, temporary)
    os.replace(temporary, path)

def main(smoke):
    torch.manual_seed(42)
    np.random.seed(42)
    torch.set_num_threads(2)
    device = torch.device('cpu' if smoke else 'cuda')
    model = make_model().to(device)
    clips = Clips('train')
    loss_fn = nn.CrossEntropyLoss(label_smoothing=.05)
    if smoke:
        x, y = clips[0]
        model.eval()
        model.fc.train()
        logits = model(x.unsqueeze(0))
        loss_fn(logits, torch.tensor([y])).backward()
        assert logits.shape == (1, 1182) and model.fc[1].weight.grad.isfinite().all()
        print('CPU smoke passed:', logits.shape, flush=True)
        return
    out = ROOT / 'results'
    out.mkdir(exist_ok=True)
    (out / 'labels.json').write_text(json.dumps(labels, ensure_ascii=False))
    train = DataLoader(clips, batch_size=4, shuffle=True, num_workers=2)
    valid = DataLoader(Clips('valid'), batch_size=4, num_workers=2)
    optimizer = torch.optim.AdamW([{'params': model.fc.parameters(), 'lr': .001},
                                   {'params': model.layer4.parameters(), 'lr': .00008},
                                   {'params': model.layer3.parameters(), 'lr': .00003}], weight_decay=.01)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, EPOCHS)
    scaler = torch.amp.GradScaler('cuda')
    start, best, stale = 0, -1, 0
    last = out / 'last.pt'
    if last.exists():
        state = torch.load(last, map_location='cpu', weights_only=True)
        model.load_state_dict(state['model'])
        optimizer.load_state_dict(state['opt'])
        scheduler.load_state_dict(state['scheduler'])
        scaler.load_state_dict(state['scaler'])
        start, best, stale = state['epoch'] + 1, state['best'], state['stale']
        del state
    for epoch in range(start, EPOCHS):
        if stale >= 8:
            break
        model.eval()  # Keep pretrained batch norm statistics with small batches.
        model.fc.train()
        model.layer4.requires_grad_(epoch >= 2)
        model.layer3.requires_grad_(epoch >= 5)
        optimizer.zero_grad(set_to_none=True)
        for i, (x, y) in enumerate(train):
            with torch.autocast('cuda', dtype=torch.float16):
                loss = loss_fn(model(x.cuda()), y.cuda())
            group_size = min(4, len(train) - 4*(i//4))
            scaler.scale(loss / group_size).backward()
            if (i+1)%4 == 0 or i+1 == len(train):
                scaler.step(optimizer)
                scaler.update()
                optimizer.zero_grad(set_to_none=True)
            if i%100 == 0:
                print('train',epoch+1,i+1,len(train),'loss',round(loss.item(),4),flush=True)
        scores = evaluate(model, valid, device)
        print('validation',epoch+1,scores,flush=True)
        if scores['macro'] > best:
            best, stale = scores['macro'], 0
            save(model.state_dict(), out/'best.pt')
        else:
            stale += 1
        scheduler.step()
        save(dict(model=model.state_dict(), opt=optimizer.state_dict(), scheduler=scheduler.state_dict(),
                  scaler=scaler.state_dict(), epoch=epoch, best=best, stale=stale), last)
    model.load_state_dict(torch.load(out/'best.pt',map_location='cpu',weights_only=True))
    test = evaluate(model, DataLoader(Clips('test'), batch_size=4, num_workers=2), device)
    (out/'metrics.json').write_text(json.dumps(dict(valid_macro=best,test=test), indent=2))
    print('test',test,flush=True)

if __name__ == '__main__':
    args = argparse.ArgumentParser()
    args.add_argument('--smoke', action='store_true')
    main(args.parse_args().smoke)
