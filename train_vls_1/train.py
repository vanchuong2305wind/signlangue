import json
import os
import sys
import random
from pathlib import Path
import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader, Dataset
from dataset import ROOT, rows, labels, read_clip

sys.path.insert(0, str(ROOT / 'SignRep'))
from models.hiera.hiera_nodec_mae import mae_hiera_base_16x224

branch = sys.argv[1]
assert branch in ('rgb','pose')
out = ROOT / 'results'
out.mkdir(exist_ok=True)
random.seed(42)
np.random.seed(42)
torch.manual_seed(42)
torch.set_num_threads(2)
classes = {word:i for i,word in enumerate(labels)}
(out / 'labels.json').write_text(json.dumps(labels, ensure_ascii=False))

class Clips(Dataset):
    def __init__(self, split):
        self.items = [r for r in rows if r['split'] == split]
        self.training = split == 'train'
    def __len__(self):
        return len(self.items)
    def __getitem__(self, i):
        r = self.items[i]
        key = r['ID_video']
        if branch == 'rgb':
            data = torch.from_numpy(read_clip(key, self.training)).permute(3,0,1,2)
        else:
            data = torch.from_numpy(np.load(ROOT / 'pose' / (key + '.npy')))
        return data, classes[r['Meaning']]

class RGB(nn.Module):
    def __init__(self):
        super().__init__()
        self.encoder = mae_hiera_base_16x224(pretrained=False,num_cls_tokens=0,drop_path_rate=0.)
        ckpt = torch.load(ROOT / 'ckpt.pt', map_location='cpu', weights_only=False)['model']
        self.encoder.load_state_dict({k[9:]:v for k,v in ckpt.items() if k.startswith('backbone.')})
        self.head = nn.Sequential(nn.LayerNorm(768), nn.Dropout(0.2), nn.Linear(768,len(labels)))
        self.register_buffer('mean',torch.tensor([.485,.456,.406]).view(1,3,1,1,1))
        self.register_buffer('std',torch.tensor([.229,.224,.225]).view(1,3,1,1,1))
    def forward(self,x):
        z,_,_ = self.encoder((x.float()/255-self.mean)/self.std,mask_ratio=0.)
        return self.head(z)

class Pose(nn.Module):
    def __init__(self):
        super().__init__()
        self.net = nn.Sequential(nn.Conv1d(294,256,5,padding=2),nn.BatchNorm1d(256),nn.GELU(),
                                 nn.Conv1d(256,256,3,padding=2,dilation=2),nn.BatchNorm1d(256),nn.GELU(),
                                 nn.AdaptiveAvgPool1d(4),nn.Flatten(),nn.Dropout(.35),nn.Linear(1024,len(labels)))
    def forward(self,x):
        return self.net(x.transpose(1,2))

model = (RGB() if branch=='rgb' else Pose()).cuda()
batch = 2 if branch=='rgb' else 32
accum = 8 if branch=='rgb' else 1
if branch=='rgb':
    model.encoder.requires_grad_(False)
    optimizer = torch.optim.AdamW([{'params':model.head.parameters(),'lr':.001},
                                    {'params':model.encoder.blocks[-2:].parameters(),'lr':.000025}])
else:
    optimizer = torch.optim.AdamW(model.parameters(),lr=.0007)
loaders = {s:DataLoader(Clips(s),batch_size=batch,shuffle=s=='train',num_workers=2 if branch=='rgb' else 0)
           for s in ('train','valid','test')}
epochs = 28 if branch=='rgb' else 70
sched = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer,epochs)
scaler = torch.amp.GradScaler('cuda')
loss_fn = nn.CrossEntropyLoss(label_smoothing=.05)
best, since, start = -1., 0, 0

def save(value, name):
    path = out / (branch + name)
    torch.save(value, path.with_suffix('.tmp'))
    os.replace(path.with_suffix('.tmp'),path)

resume = out / (branch + '-last.pt')
if resume.exists():
    state = torch.load(resume,map_location='cpu',weights_only=False)
    model.load_state_dict(state['model'])
    optimizer.load_state_dict(state['opt'])
    sched.load_state_dict(state['sched'])
    scaler.load_state_dict(state['scaler'])
    start,best,since = state['epoch']+1,state['best'],state['since']
    del state

@torch.no_grad()
def evaluate(split):
    model.eval()
    ps, ys = [], []
    for x,y in loaders[split]:
        with torch.autocast('cuda',dtype=torch.float16):
            logits = model(x.cuda())
        ps.append(logits.float().softmax(1).cpu())
        ys.append(y)
    p,y = torch.cat(ps),torch.cat(ys)
    ok = p.argmax(1)==y
    counts = y.bincount(minlength=len(labels))
    macro = (y[ok].bincount(minlength=len(labels))[counts>0]/counts[counts>0]).mean().item()
    return macro,ok.float().mean().item(),p,y

for epoch in range(start,epochs):
    model.train()
    if branch=='rgb':
        model.encoder.eval()
        model.encoder.blocks[-2:].requires_grad_(epoch>=3)
    optimizer.zero_grad(set_to_none=True)
    n = len(loaders['train'])
    for i,(x,y) in enumerate(loaders['train']):
        with torch.autocast('cuda',dtype=torch.float16):
            loss = loss_fn(model(x.cuda()),y.cuda())
        scaler.scale(loss/min(accum,n-(i//accum)*accum)).backward()
        if (i+1)%accum==0 or i+1==n:
            scaler.step(optimizer)
            scaler.update()
            optimizer.zero_grad(set_to_none=True)
        if i==0 or (i+1)%200==0:
            print(branch,epoch+1,i+1,n,'loss',round(loss.item(),4),flush=True)
    macro,acc,_,_ = evaluate('valid')
    print('validation',epoch+1,'macro',macro,'top1',acc,flush=True)
    if macro>best:
        best,since = macro,0
        save(model.state_dict(),'-best.pt')
    else:
        since += 1
    sched.step()
    save(dict(model=model.state_dict(),opt=optimizer.state_dict(),sched=sched.state_dict(),
              scaler=scaler.state_dict(),epoch=epoch,best=best,since=since),'-last.pt')
    if since>=10:
        break
model.load_state_dict(torch.load(out/(branch+'-best.pt'),map_location='cpu',weights_only=True))
for split in ('valid','test'):
    macro,acc,p,y = evaluate(split)
    save((p,y),'-'+split+'.pt')
print(branch,'complete',flush=True)
