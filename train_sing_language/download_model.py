"""
Download pre-trained TGCN model from HuggingFace Hub.
Repository: sharonn18/tgcn-wlasl
"""
import os
from huggingface_hub import hf_hub_download

REPO_ID = "sharonn18/tgcn-wlasl"

# Available model variants
VARIANTS = {
    "asl100":  {"num_class": 100,  "hidden": 64,  "stages": 20},
    "asl300":  {"num_class": 300,  "hidden": 256, "stages": 24},
    "asl1000": {"num_class": 1000, "hidden": 256, "stages": 24},
    "asl2000": {"num_class": 2000, "hidden": 256, "stages": 24},
}


def download_model(variant="asl100", save_dir="checkpoints"):
    """
    Download pre-trained TGCN checkpoint from HuggingFace.
    
    Args:
        variant: one of 'asl100', 'asl300', 'asl1000', 'asl2000'
        save_dir: local directory to save files
    """
    if variant not in VARIANTS:
        raise ValueError(f"Unknown variant '{variant}'. Choose from: {list(VARIANTS.keys())}")
    
    os.makedirs(os.path.join(save_dir, variant), exist_ok=True)
    
    # Download model weights
    print(f"[1/2] Downloading {variant} model weights...")
    model_path = hf_hub_download(
        repo_id=REPO_ID,
        filename=f"checkpoints/{variant}/pytorch_model.bin",
        local_dir=save_dir,
    )
    print(f"  -> Saved to: {model_path}")
    
    # Download config
    print(f"[2/2] Downloading {variant} config...")
    config_path = hf_hub_download(
        repo_id=REPO_ID,
        filename=f"checkpoints/{variant}/config.ini",
        local_dir=save_dir,
    )
    print(f"  -> Saved to: {config_path}")
    
    print(f"\n[OK] Model '{variant}' downloaded successfully!")
    print(f"   Classes: {VARIANTS[variant]['num_class']}")
    print(f"   Hidden size: {VARIANTS[variant]['hidden']}")
    print(f"   Stages: {VARIANTS[variant]['stages']}")
    
    return model_path, config_path


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description="Download TGCN pre-trained model")
    parser.add_argument("--variant", type=str, default="asl100",
                        choices=list(VARIANTS.keys()),
                        help="Model variant to download (default: asl100)")
    parser.add_argument("--save-dir", type=str, default="checkpoints",
                        help="Directory to save model files (default: checkpoints)")
    args = parser.parse_args()
    
    download_model(args.variant, args.save_dir)
