"""Landmark cleanup and temporal smoothing for sign animation data."""

from __future__ import annotations

import math
from copy import deepcopy


TRACK_SIZES = {
    "pose": 33,
    "left_hand": 21,
    "right_hand": 21,
    "face": None,
}


def _valid_track(track, expected_size=None):
    if not isinstance(track, list) or not track:
        return False
    if expected_size and len(track) < expected_size:
        return False
    return any(
        abs(float(point.get("x", 0))) +
        abs(float(point.get("y", 0))) +
        abs(float(point.get("z", 0))) > 1e-7
        for point in track
        if isinstance(point, dict)
    )


def _interpolate_track(left, right, amount):
    result = []
    for index in range(min(len(left), len(right))):
        a = left[index]
        b = right[index]
        result.append({
            axis: float(a.get(axis, 0)) +
            (float(b.get(axis, 0)) - float(a.get(axis, 0))) * amount
            for axis in ("x", "y", "z")
        })
    return result


def _fill_short_gaps(values, max_gap):
    filled = list(values)
    index = 0
    while index < len(filled):
        if filled[index] is not None:
            index += 1
            continue

        start = index
        while index < len(filled) and filled[index] is None:
            index += 1
        end = index
        gap = end - start

        if (
            gap <= max_gap and
            start > 0 and
            end < len(filled) and
            filled[start - 1] is not None and
            filled[end] is not None
        ):
            for offset in range(gap):
                amount = (offset + 1) / (gap + 1)
                filled[start + offset] = _interpolate_track(
                    filled[start - 1], filled[end], amount
                )
    return filled


def _smooth_track(values, fps, cutoff_hz):
    """Zero-phase exponential smoothing to avoid adding visible latency."""
    if not values:
        return values

    dt = 1.0 / max(float(fps), 1.0)
    rc = 1.0 / (2.0 * math.pi * max(cutoff_hz, 0.01))
    alpha = dt / (rc + dt)

    def pass_once(items):
        output = deepcopy(items)
        previous = None
        for index, track in enumerate(items):
            if track is None:
                continue
            if previous is None:
                previous = deepcopy(track)
            else:
                for point_index, point in enumerate(track):
                    for axis in ("x", "y", "z"):
                        current = float(point.get(axis, 0))
                        old = float(previous[point_index].get(axis, 0))
                        previous[point_index][axis] = old + alpha * (current - old)
            output[index] = deepcopy(previous)
        return output

    forward = pass_once(values)
    backward = list(reversed(pass_once(list(reversed(forward)))))
    return backward


def process_landmark_entry(entry, cutoff_hz=7.0, max_gap=4):
    frames = entry.get("frames") or []
    fps = float(entry.get("fps") or 25)
    processed_frames = [dict(frame) for frame in frames]

    available_tracks = set(TRACK_SIZES)
    for frame in frames:
        available_tracks.update(frame.keys())

    for track_name in available_tracks:
        if track_name not in TRACK_SIZES:
            continue
        expected_size = TRACK_SIZES[track_name]
        track_values = [
            deepcopy(frame.get(track_name))
            if _valid_track(frame.get(track_name), expected_size)
            else None
            for frame in frames
        ]
        track_values = _fill_short_gaps(track_values, max_gap)
        track_values = _smooth_track(track_values, fps, cutoff_hz)

        for index, value in enumerate(track_values):
            processed_frames[index][track_name] = value

    result = dict(entry)
    result["schema_version"] = 2
    result["processing"] = {
        "filter": "zero_phase_exponential",
        "cutoff_hz": cutoff_hz,
        "max_interpolated_gap": max_gap,
    }
    result["frames"] = processed_frames
    return result
