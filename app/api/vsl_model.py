"""Inference-only architecture matching trian_vls3's RGB state_dict."""

import torch
from torch import nn

from .vsl_hiera.hiera_nodec_mae import mae_hiera_base_16x224


class VSLRGB(nn.Module):
    def __init__(self, num_classes: int = 224):
        super().__init__()
        self.encoder = mae_hiera_base_16x224(
            pretrained=False, num_cls_tokens=0, drop_path_rate=0.0,
        )
        self.head = nn.Sequential(
            nn.LayerNorm(768), nn.Dropout(0.2), nn.Linear(768, num_classes),
        )
        self.register_buffer("mean", torch.tensor([.485, .456, .406]).view(1, 3, 1, 1, 1))
        self.register_buffer("std", torch.tensor([.229, .224, .225]).view(1, 3, 1, 1, 1))

    def forward(self, x):
        # Input is RGB uint8 (or unscaled float); normalize exactly once here.
        features, _, _ = self.encoder(
            (x.float() / 255 - self.mean) / self.std, mask_ratio=0.0,
        )
        return self.head(features)
