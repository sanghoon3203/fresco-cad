#!/usr/bin/env python3
"""Check benchmark evidence, not performance acceptance: python3 tests/benchmark_check.py FILE.json [...].

The scene is synthetic; text below two logical pixels is culled by the renderer.
Submission timestamps do not measure GPU completion or physical pointer latency.
Slow frames must remain in the evidence, even when they fail the 16.7 ms target.
"""
import json
import math
import sys
from pathlib import Path


def close(actual, expected):
    assert math.isfinite(actual) and math.isclose(actual, expected, rel_tol=1e-8, abs_tol=1e-5), (actual, expected)


def summary(actual, values):
    assert all(math.isfinite(value) and value >= 0 for value in values)
    assert actual["samples"] == len(values)
    if not values:
        return
    values = sorted(values)
    close(actual["p50_ms"], values[(len(values) - 1) // 2])
    close(actual["p95_ms"], values[math.ceil(len(values) * 0.95) - 1])
    close(actual["max_ms"], values[-1])
    close(actual["mean_ms"], sum(values) / len(values))
    assert actual["over_16_7_ms"] == sum(value > 16.7 for value in values)


def check(path):
    data = json.loads(path.read_text())
    assert data["harness_version"] in {2, 3, 4} and data["complete"] is True
    assert data["mode"] in {"zoom", "pan", "hover"}
    assert data["entities"] == 100000 and "synthetic" in data["scene"]
    assert data["physical_pointer_to_preview"] == "not measured"
    assert data["layout_unchanged"] is True and data["initial_view_scale"] > 0
    assert data["warmup_dispatches"] == 30 and data["requested_measured_dispatches"] == 150
    assert data["target_feed_hz"] == 60 and data["frame_time_target_ms"] == 16.7
    if data["harness_version"] == 4:
        assert data["window_logical_px"] == [1320, 800]
    assert data["device_pixel_ratio"] > 0
    for logical, physical in zip(data["window_logical_px"], data["window_physical_px"]):
        assert logical > 0 and physical == math.floor(logical * data["device_pixel_ratio"] + 0.5)
    assert len(data["canvas_logical_px"]) == 2 and min(data["canvas_logical_px"]) > 0

    inputs, frames = data["raw_dispatches"], data["raw_frames"]
    assert [row["sequence"] for row in inputs] == list(range(31, 181))
    assert frames and frames[-1]["sequence"] == 180
    timestamps = {row["sequence"]: row["dispatched_at_ms"] for row in inputs}
    views = {}
    if data["harness_version"] >= 3:
        initial_scale, initial_center = data["initial_view_scale"], data["initial_view_center_mm"]
        for row in inputs:
            seq = row["sequence"]
            phase = seq % 60
            level = min(phase, 60 - phase)
            scale = initial_scale * (1.002 ** level if data["mode"] == "zoom" else 1)
            center = [initial_center[0] - (4 * level / initial_scale if data["mode"] == "pan" else 0), initial_center[1]]
            close(row["view_scale"], scale)
            for actual, expected in zip(row["view_center_mm"], center):
                close(actual, expected)
            pointer = [value / 2 for value in data["canvas_logical_px"]]
            if data["mode"] == "hover":
                pointer[0] += (seq % 60 - 30) * 4
                pointer[1] += (1 if (seq // 60) % 2 else -1) * 40
            for actual, expected in zip(row["pointer_logical_px"], pointer):
                close(actual, expected)
            views[seq] = [row["view_scale"], *row["view_center_mm"]] if data["mode"] != "hover" else row["pointer_logical_px"]
    assert all(math.isfinite(value) and value > 0 for value in timestamps.values())
    feed = [inputs[i]["dispatched_at_ms"] - inputs[i - 1]["dispatched_at_ms"] for i in range(1, len(inputs))]
    assert min(feed) > 0
    duration = inputs[-1]["dispatched_at_ms"] - inputs[0]["dispatched_at_ms"]
    close(data["feed_duration_ms"], duration)
    close(data["feed_actual_hz"], 149000 / duration)
    summary(data["feed_interval"], feed)
    summary(data["handler"], [row["handler_ms"] for row in inputs])

    previous, previous_time, submitted = 30, 0, 0
    changed_views, unchanged_views, previous_view = 0, 0, None
    latest, oldest = [], []
    for frame in frames:
        seq, time = frame["sequence"], frame["submitted_at_ms"]
        assert all(math.isfinite(frame[key]) and frame[key] >= 0
                   for key in ("frame_interval_ms", "cpu_ms", "latest_input_ms", "oldest_pending_input_ms"))
        assert previous <= seq <= 180 and math.isfinite(time) and time > previous_time
        assert frame["new_input"] is (seq > previous)
        close(frame["latest_input_ms"], time - timestamps[seq])
        if frame["new_input"]:
            close(frame["oldest_pending_input_ms"], time - timestamps[previous + 1])
            latest.append(frame["latest_input_ms"])
            oldest.append(frame["oldest_pending_input_ms"])
            submitted += 1
            if views:
                view = views[seq]
                if previous_view is not None:
                    if all(math.isclose(a, b, rel_tol=1e-10, abs_tol=1e-8) for a, b in zip(view, previous_view)):
                        unchanged_views += 1
                    else:
                        changed_views += 1
                previous_view = view
        else:
            assert frame["oldest_pending_input_ms"] == 0
        previous, previous_time = seq, time
    assert data["dispatched_updates"] == 150
    assert data["submitted_updates"] == submitted
    assert data["coalesced_updates"] == 150 - submitted and data["unsubmitted_updates"] == 0
    close(data["submitted_dispatch_ratio"], submitted / 150)
    summary(data["frame_interval"], [row["frame_interval_ms"] for row in frames if row["frame_interval_ms"] > 0])
    summary(data["cpu_sync_to_after_rendering"], [row["cpu_ms"] for row in frames])
    summary(data["latest_input_to_submitted"], latest)
    summary(data["oldest_pending_input_to_submitted"], oldest)
    if views:
        assert changed_views > 0, "No submitted change in camera/pointer state"
        assert changed_views + unchanged_views == submitted - 1
    print(f"PASS {path.name}: {data['mode']}, 150 inputs, {submitted} submitted, "
          f"frame p95 {data['frame_interval']['p95_ms']:.3f} ms (evidence integrity only)"
          + (f", {changed_views} changed / {unchanged_views} unchanged submitted camera/pointer states" if views else ""))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("Usage: python3 tests/benchmark_check.py FILE.json [...]")
    for argument in sys.argv[1:]:
        check(Path(argument))
