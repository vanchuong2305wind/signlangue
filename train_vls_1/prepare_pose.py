import os
import sys
import numpy as np
from dataset import ROOT, REPO, rows, paths
sys.path.insert(0, str(REPO))
from scripts.data_v2_viesign.extract_original import ensure_model, extract_clip

model_path = ROOT / 'cache/holistic_landmarker.task'
model_path.parent.mkdir(parents=True, exist_ok=True)
ensure_model(model_path)

folder = ROOT / 'pose'
folder.mkdir(exist_ok=True)
def xyz(frame,group):
    return np.array([[p[k] for k in ('x','y','z')] for p in frame[group]],dtype=np.float32)

def features(frame):
    joints = np.zeros((48,3),dtype=np.float32)
    present = []
    if frame['pose']:
        arms = xyz(frame,'pose')[[11,12,13,14,15,16]]
        width = max(.05,np.linalg.norm(arms[0,:2]-arms[1,:2]))
        joints[:6] = (arms-arms[:2].mean(0))/width
    present.append(bool(frame['pose']))
    for i,group in enumerate(('left_hand','right_hand')):
        present.append(bool(frame[group]))
        if frame[group]:
            hand = xyz(frame,group)
            palm = max(.01,np.linalg.norm(hand[9,:2]-hand[0,:2]))
            joints[6+i*21:27+i*21] = (hand-hand[0])/palm
    return np.r_[joints.ravel(),present].astype('float32')

for i,row in enumerate(rows):
    key = row['ID_video']
    path = folder / (key+'.npy')
    if path.exists():
        continue
    clip = extract_clip(paths[key], model_path,max_fps=12,max_width=640)
    seq = np.stack([features(fr) for fr in clip['frames']])
    seq = seq[np.linspace(0,len(seq)-1,32).round().astype(int)]
    result = np.concatenate([seq,np.diff(seq,axis=0,prepend=seq[:1])],axis=1)
    with path.with_suffix('.tmp').open('wb') as f:
        np.save(f,result)
    os.replace(path.with_suffix('.tmp'),path)
    if i%50==0:
        print('extracted',i+1,len(rows),flush=True)
