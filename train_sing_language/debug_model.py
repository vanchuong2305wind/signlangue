"""
Debug script: Analyze model behavior with different input patterns.
This helps diagnose WHY the model keeps predicting the same classes.
"""
import torch
import numpy as np
from tgcn_model import GCN_muti_att
from configs import Config
from wlasl_labels import get_label, get_num_classes

# Load asl2000 model
config = Config('checkpoints/checkpoints/asl2000/config.ini')
num_classes = get_num_classes('asl2000')
print(f'Config: num_samples={config.num_samples}, hidden={config.hidden_size}, stages={config.num_stages}')
print(f'Num classes: {num_classes}')

model = GCN_muti_att(
    input_feature=config.num_samples * 2,
    hidden_feature=config.hidden_size,
    num_class=num_classes,
    p_dropout=config.drop_p,
    num_stage=config.num_stages,
)

checkpoint = torch.load('checkpoints/checkpoints/asl2000/pytorch_model.bin', map_location='cpu', weights_only=False)
state_dict = checkpoint.get('state_dict', checkpoint)
model.load_state_dict(state_dict, strict=False)
model.eval()
print('Model loaded!')

# Analyze model weights
print("\n=== Model Weight Analysis ===")
for name, param in model.named_parameters():
    if param.requires_grad:
        print(f"  {name}: shape={param.shape}, mean={param.data.mean():.6f}, std={param.data.std():.6f}, min={param.data.min():.6f}, max={param.data.max():.6f}")

# Test 1: All zeros
print("\n=== Test 1: All zeros input ===")
x_zeros = torch.zeros(1, 55, 100)
with torch.no_grad():
    output = model(x_zeros)
    probs = torch.softmax(output, dim=1)
    top5 = torch.topk(probs, 5, dim=1)
    print("Top-5 predictions for ZEROS:")
    for i in range(5):
        idx = top5.indices[0][i].item()
        prob = top5.values[0][i].item()
        print(f"  {i+1}. '{get_label(idx)}' (class {idx}): {prob:.4f}")

# Test 2: Random normal input
print("\n=== Test 2: Random normal input ===")
for trial in range(3):
    x_rand = torch.randn(1, 55, 100) * 0.1
    with torch.no_grad():
        output = model(x_rand)
        probs = torch.softmax(output, dim=1)
        top5 = torch.topk(probs, 5, dim=1)
        print(f"Trial {trial+1} - Top-3:")
        for i in range(3):
            idx = top5.indices[0][i].item()
            prob = top5.values[0][i].item()
            print(f"  {i+1}. '{get_label(idx)}' (class {idx}): {prob:.4f}")

# Test 3: Simulated normalized keypoints (centered, shoulder-scaled)
print("\n=== Test 3: Simulated normalized keypoints ===")
# Simulate a "neutral" pose - shoulders at (-0.5, 0) and (0.5, 0), hands at sides
num_samples = config.num_samples  # 50
keypoints_per_frame = np.zeros((55, 2), dtype=np.float32)
# After normalization: center=(0,0), shoulder_dist=1.0
# Nose at (0, -1)
keypoints_per_frame[0] = [0, -1]
# Left eye
keypoints_per_frame[1] = [-0.15, -1.1]
# Right eye
keypoints_per_frame[2] = [0.15, -1.1]
# Left ear
keypoints_per_frame[3] = [-0.3, -1.0]
# Right ear
keypoints_per_frame[4] = [0.3, -1.0]
# Left shoulder
keypoints_per_frame[5] = [-0.5, 0]
# Right shoulder
keypoints_per_frame[6] = [0.5, 0]
# Left elbow
keypoints_per_frame[7] = [-0.7, 0.5]
# Right elbow
keypoints_per_frame[8] = [0.7, 0.5]
# Left wrist
keypoints_per_frame[9] = [-0.7, 1.0]
# Right wrist
keypoints_per_frame[10] = [0.7, 1.0]
# Left hip
keypoints_per_frame[11] = [-0.3, 1.5]
# Right hip
keypoints_per_frame[12] = [0.3, 1.5]

# Left hand (21 pts) - near left wrist
for j in range(21):
    keypoints_per_frame[13 + j] = [-0.7 + (j % 5) * 0.05, 1.0 + (j // 5) * 0.05]

# Right hand (21 pts) - near right wrist
for j in range(21):
    keypoints_per_frame[34 + j] = [0.7 + (j % 5) * 0.05, 1.0 + (j // 5) * 0.05]

# Build input tensor
feature = np.zeros((55, num_samples * 2), dtype=np.float32)
for t in range(num_samples):
    feature[:, t * 2] = keypoints_per_frame[:, 0]      # x
    feature[:, t * 2 + 1] = keypoints_per_frame[:, 1]  # y

x_sim = torch.FloatTensor(feature).unsqueeze(0)
print(f"Input shape: {x_sim.shape}")
print(f"Input range: min={x_sim.min():.3f}, max={x_sim.max():.3f}, mean={x_sim.mean():.3f}")

with torch.no_grad():
    output = model(x_sim)
    probs = torch.softmax(output, dim=1)
    top5 = torch.topk(probs, 5, dim=1)
    print("Top-5 predictions for SIMULATED POSE:")
    for i in range(5):
        idx = top5.indices[0][i].item()
        prob = top5.values[0][i].item()
        print(f"  {i+1}. '{get_label(idx)}' (class {idx}): {prob:.4f}")

# Test 4: Check what raw MediaPipe coords look like (unnormalized)
print("\n=== Test 4: Raw MediaPipe coordinates (0-1 range, NOT normalized) ===")
raw_kp = np.zeros((55, 2), dtype=np.float32)
# Typical MediaPipe coords: x in [0.3-0.7], y in [0.2-0.8]
raw_kp[0] = [0.5, 0.25]   # nose
raw_kp[1] = [0.47, 0.23]  # left eye
raw_kp[2] = [0.53, 0.23]  # right eye
raw_kp[3] = [0.44, 0.25]  # left ear
raw_kp[4] = [0.56, 0.25]  # right ear
raw_kp[5] = [0.4, 0.4]    # left shoulder
raw_kp[6] = [0.6, 0.4]    # right shoulder
raw_kp[7] = [0.35, 0.55]  # left elbow
raw_kp[8] = [0.65, 0.55]  # right elbow
raw_kp[9] = [0.35, 0.65]  # left wrist
raw_kp[10] = [0.65, 0.65] # right wrist
raw_kp[11] = [0.45, 0.7]  # left hip
raw_kp[12] = [0.55, 0.7]  # right hip

for j in range(21):
    raw_kp[13 + j] = [0.35 + (j % 5) * 0.01, 0.65 + (j // 5) * 0.01]
for j in range(21):
    raw_kp[34 + j] = [0.65 + (j % 5) * 0.01, 0.65 + (j // 5) * 0.01]

feature_raw = np.zeros((55, num_samples * 2), dtype=np.float32)
for t in range(num_samples):
    feature_raw[:, t * 2] = raw_kp[:, 0]
    feature_raw[:, t * 2 + 1] = raw_kp[:, 1]

x_raw = torch.FloatTensor(feature_raw).unsqueeze(0)
print(f"RAW input range: min={x_raw.min():.3f}, max={x_raw.max():.3f}")

with torch.no_grad():
    output = model(x_raw)
    probs = torch.softmax(output, dim=1)
    top5 = torch.topk(probs, 5, dim=1)
    print("Top-5 predictions for RAW coords:")
    for i in range(5):
        idx = top5.indices[0][i].item()
        prob = top5.values[0][i].item()
        print(f"  {i+1}. '{get_label(idx)}' (class {idx}): {prob:.4f}")

# Test 5: Check if model is sensitive to input scale
print("\n=== Test 5: Input sensitivity test ===")
for scale in [0.01, 0.1, 0.5, 1.0, 5.0, 10.0]:
    x_scaled = x_sim * scale
    with torch.no_grad():
        output = model(x_scaled)
        probs = torch.softmax(output, dim=1)
        conf, pred = torch.max(probs, dim=1)
        print(f"  Scale {scale:>5.2f}: '{get_label(pred.item()):>20s}' conf={conf.item():.4f}")

print("\n=== DONE ===")
