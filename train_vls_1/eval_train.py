import sys
sys.argv = ['train.py', sys.argv[1]]
source = open('train.py').read().split('for epoch in range(start,epochs):')[0]
exec(compile(source, 'train.py', 'exec'))
data = Clips('train')
data.training = False
loaders['train'] = DataLoader(data, batch_size=batch, shuffle=False, num_workers=0)
model.load_state_dict(torch.load(out/(branch+'-best.pt'),map_location='cpu',weights_only=True))
macro,acc,p,y = evaluate('train')
save((p,y),'-train.pt')
print('TRAIN',branch,'top1',acc,'macro',macro,flush=True)
