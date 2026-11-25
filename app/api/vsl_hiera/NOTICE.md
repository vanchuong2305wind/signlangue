This directory vendors the Hiera implementation from the local
`train_vls_1/SignRep/models/hiera` used to train the VSL224 RGB checkpoint.
The original files identify Meta Platforms, Inc. and affiliates as copyright
holders. The supplied SignRep LICENSE is preserved verbatim in LICENSE
(CC BY-NC-SA 4.0). The upstream source is identified in the original file headers.

Local modifications: imports use this package's relative paths instead of
`models.hiera`. Model calculations, parameter names and shapes are unchanged.
No training entry point is included. `pretrained=False` prevents weight downloads.
