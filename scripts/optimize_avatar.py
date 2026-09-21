"""Compress embedded VRM textures for faster avatar cold starts.

The script preserves node, mesh, skin, accessor, and VRM extension indices. It
only repacks buffer views and switches embedded images to EXT_texture_webp.
Textures used exclusively by accessories removed at runtime become a 1x1 image.
"""

from __future__ import annotations

import argparse
import io
import json
import struct
from pathlib import Path

from PIL import Image


JSON_CHUNK = b"JSON"
BIN_CHUNK = b"BIN\x00"
ACCESSORY_IMAGES = {
    "robo_arm",
    "backpack",
    "planekun_face",
    "nm_backpack_normals",
}
ACCESSORY_MATERIALS = {
    "backpack_metal",
    "backpack_nm",
    "backpack_plastic",
    "green_emit",
    "robo_face",
    "glass",
    "anim_logo",
    "arm_mat",
    "arm_plastic",
}


def pad4(data: bytes, fill: bytes) -> bytes:
    return data + fill * ((-len(data)) % 4)


def read_glb(path: Path) -> tuple[dict, bytes]:
    raw = path.read_bytes()
    magic, version, total_length = struct.unpack_from("<4sII", raw, 0)
    if magic != b"glTF" or version != 2 or total_length != len(raw):
        raise ValueError(f"{path} is not a valid GLB 2.0 file")

    json_length, json_type = struct.unpack_from("<I4s", raw, 12)
    if json_type != JSON_CHUNK:
        raise ValueError("GLB JSON chunk is missing")
    json_start = 20
    document = json.loads(raw[json_start:json_start + json_length])

    binary_header = json_start + json_length
    binary_length, binary_type = struct.unpack_from("<I4s", raw, binary_header)
    if binary_type != BIN_CHUNK:
        raise ValueError("GLB binary chunk is missing")
    binary_start = binary_header + 8
    return document, raw[binary_start:binary_start + binary_length]


def encode_webp(raw: bytes, name: str, quality: int) -> bytes:
    if name in ACCESSORY_IMAGES:
        image = Image.new("RGBA", (1, 1), (0, 0, 0, 0))
        lossless = True
    else:
        image = Image.open(io.BytesIO(raw))
        image.load()
        lossless = name.startswith("mask_") or "outline" in name

    output = io.BytesIO()
    image.save(
        output,
        format="WEBP",
        quality=quality,
        method=6,
        lossless=lossless,
    )
    return output.getvalue()


def optimize(input_path: Path, output_path: Path, quality: int) -> None:
    original_size = input_path.stat().st_size
    document, binary = read_glb(input_path)
    buffer_views = document.get("bufferViews", [])
    images = document.get("images", [])

    material_names = {
        index: str(material.get("name", "")).lower()
        for index, material in enumerate(document.get("materials", []))
    }
    for mesh in document.get("meshes", []):
        mesh["primitives"] = [
            primitive
            for primitive in mesh.get("primitives", [])
            if material_names.get(primitive.get("material")) not in ACCESSORY_MATERIALS
        ]
    for node in document.get("nodes", []):
        mesh_index = node.get("mesh")
        if mesh_index is not None and not document["meshes"][mesh_index]["primitives"]:
            node.pop("mesh")

    used_accessors: set[int] = set()
    for mesh in document.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            used_accessors.update(primitive.get("attributes", {}).values())
            if primitive.get("indices") is not None:
                used_accessors.add(primitive["indices"])
            for target in primitive.get("targets", []):
                used_accessors.update(target.values())
    for skin in document.get("skins", []):
        if skin.get("inverseBindMatrices") is not None:
            used_accessors.add(skin["inverseBindMatrices"])
    for animation in document.get("animations", []):
        for sampler in animation.get("samplers", []):
            used_accessors.update((sampler["input"], sampler["output"]))

    for accessor_index, accessor in enumerate(document.get("accessors", [])):
        if accessor_index not in used_accessors:
            accessor.pop("bufferView", None)
            accessor.pop("sparse", None)

    referenced_views: set[int] = set()
    for accessor in document.get("accessors", []):
        if accessor.get("bufferView") is not None:
            referenced_views.add(accessor["bufferView"])
        sparse = accessor.get("sparse") or {}
        for sparse_part in (sparse.get("indices"), sparse.get("values")):
            if sparse_part and sparse_part.get("bufferView") is not None:
                referenced_views.add(sparse_part["bufferView"])
    referenced_views.update(
        image["bufferView"] for image in images if image.get("bufferView") is not None
    )

    replacements: dict[int, bytes] = {}
    image_index_by_view: dict[int, int] = {}
    for image_index, image_info in enumerate(images):
        view_index = image_info.get("bufferView")
        if view_index is None:
            continue
        view = buffer_views[view_index]
        start = int(view.get("byteOffset", 0))
        end = start + int(view["byteLength"])
        raw_image = binary[start:end]
        name = str(image_info.get("name", "")).lower()

        if image_info.get("mimeType") == "image/webp":
            encoded = raw_image
        else:
            encoded = encode_webp(raw_image, name, quality)
        replacements[view_index] = encoded
        image_index_by_view[view_index] = image_index
        image_info["mimeType"] = "image/webp"

    rebuilt = bytearray()
    for view_index, view in enumerate(buffer_views):
        start = int(view.get("byteOffset", 0))
        end = start + int(view["byteLength"])
        payload = (
            replacements.get(view_index, binary[start:end])
            if view_index in referenced_views
            else b""
        )
        while len(rebuilt) % 4:
            rebuilt.append(0)
        view["byteOffset"] = len(rebuilt)
        view["byteLength"] = len(payload)
        rebuilt.extend(payload)

    document["buffers"][0]["byteLength"] = len(rebuilt)
    extensions_used = document.setdefault("extensionsUsed", [])
    extensions_required = document.setdefault("extensionsRequired", [])
    if "EXT_texture_webp" not in extensions_used:
        extensions_used.append("EXT_texture_webp")
    if "EXT_texture_webp" not in extensions_required:
        extensions_required.append("EXT_texture_webp")

    for texture in document.get("textures", []):
        source = texture.get("source")
        if source is None:
            continue
        texture.setdefault("extensions", {})["EXT_texture_webp"] = {
            "source": source,
        }

    json_chunk = pad4(
        json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        b" ",
    )
    binary_chunk = pad4(bytes(rebuilt), b"\x00")
    total_length = 12 + 8 + len(json_chunk) + 8 + len(binary_chunk)
    output = (
        struct.pack("<4sII", b"glTF", 2, total_length)
        + struct.pack("<I4s", len(json_chunk), JSON_CHUNK)
        + json_chunk
        + struct.pack("<I4s", len(binary_chunk), BIN_CHUNK)
        + binary_chunk
    )

    temporary_path = output_path.with_suffix(output_path.suffix + ".tmp")
    temporary_path.write_bytes(output)
    temporary_path.replace(output_path)
    print(
        f"Optimized {input_path.name}: "
        f"{original_size / 1_048_576:.2f} MB -> "
        f"{output_path.stat().st_size / 1_048_576:.2f} MB"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--quality", type=int, default=82)
    args = parser.parse_args()
    optimize(args.input, args.output, min(max(args.quality, 1), 100))


if __name__ == "__main__":
    main()
