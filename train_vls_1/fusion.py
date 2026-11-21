from pathlib import Path
import json
import torch
root = Path(__file__).resolve().parent/'results'
def data(split):
    a,y = torch.load(root/f'rgb-{split}.pt',weights_only=True)
    b,z = torch.load(root/f'pose-{split}.pt',weights_only=True)
    assert torch.equal(y,z)
    return a,b,y
def scores(a,b,y,w):
    p = a*w+b*(1-w)
    ok = p.argmax(1)==y
    macro = (y[ok].bincount(minlength=p.shape[1])/y.bincount(minlength=p.shape[1]).clamp_min(1)).mean()
    return {'macro':macro.item(),'top1':ok.float().mean().item(),'top5':(p.topk(5).indices==y[:,None]).any(1).float().mean().item()}
v = data('valid')
weight = max([i/10 for i in range(11)],key=lambda w:scores(*v,w)['macro'])
t = data('test')
report = dict(rgb_weight=weight,valid=scores(*v,weight),test=scores(*t,weight),rgb_test=scores(*t,1),pose_test=scores(*t,0))
(root/'metrics.json').write_text(json.dumps(report,indent=2))
print(report)
