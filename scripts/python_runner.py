"""Runs a user-written Python function for the fringe frontend.

Reads {"kind": "layout" | "calibrator" | "transmitter", "code": str, "context": {...}} as JSON on
stdin and calls the function the code defines, with or without a `ctx` argument:

- layout:      `layout(ctx)` returns antenna positions in metres: an (N, 2) or (N, 3) array-like
               (z = 0 when omitted), or a sequence of {"x", "y"[, "z"]} mappings.
- calibrator:  `positions(ctx)` returns one calibrator state per integration: an (N, 3) array-like
               of positions (m), or (N, 4) with a transmit power column (W; NaN = use the power
               field); or a dict {"position": (N, 3), "velocity": (N, 3)?, "acceleration": (N, 3)?,
               "power": (N,)?}; or a sequence of {"x", "y", "z"[, "vx", "vy", "vz", "ax", "ay",
               "az", "power"]} mappings.
- transmitter: `buffer(ctx)` returns the transmit buffer: a 1-D array-like of complex baseband
               samples (or real ones), or an (N, 2) array of I and Q.

Writes one JSON line to stdout: {"positions": [[x, y, z], ...], "velocity"?: ..., "acceleration"?:
..., "power"?: [...], "stdout": str}, {"buffer": base64 cf32_le, "stdout": str}, or
{"error": str, "stdout": str}.
"""

import base64
import contextlib
import inspect
import io
import json
import linecache
import math
import sys
import traceback
import types

FILENAME = "<code>"
MAX_STDOUT = 20000

KINDS = {
    "layout": {"function": "layout", "what": "antenna positions", "max_rows": 65536},
    "calibrator": {"function": "positions", "what": "calibrator positions", "max_rows": 1_000_000},
    "transmitter": {"function": "buffer", "what": "transmit buffer samples", "max_rows": 1 << 22},
}


def emit(**payload):
    sys.__stdout__.write(json.dumps(payload) + "\n")
    sys.__stdout__.flush()


def user_traceback(exc):
    """Traceback restricted to frames in the user's code, with their source lines."""
    lines = []
    for frame in traceback.extract_tb(exc.__traceback__):
        if frame.filename == FILENAME:
            lines.append(f"  line {frame.lineno}, in {frame.name}")
            if frame.line:
                lines.append(f"    {frame.line.strip()}")
    head = ["Traceback (your code):"] if lines else []
    tail = "".join(traceback.format_exception_only(type(exc), exc)).rstrip("\n").split("\n")
    return "\n".join(head + lines + tail)


def check_rows(arr, name, what, max_rows):
    if arr.shape[0] < 1:
        raise ValueError(f"{name} returned no {what}")
    if arr.shape[0] > max_rows:
        raise ValueError(f"{name} returned {arr.shape[0]} rows; at most {max_rows} are supported")


def layout_payload(result, np):
    name = "layout()"
    if isinstance(result, (list, tuple)) and result and isinstance(result[0], dict):
        result = [[p["x"], p["y"], p.get("z", 0.0)] for p in result]
    arr = np.asarray(result, dtype=float)
    if arr.ndim != 2 or arr.shape[1] not in (2, 3):
        raise ValueError(f"{name} must return an (N, 2) or (N, 3) array of antenna positions, got shape {arr.shape}")
    check_rows(arr, name, "antenna positions", KINDS["layout"]["max_rows"])
    if not np.all(np.isfinite(arr)):
        raise ValueError(f"{name} returned non-finite positions")
    if arr.shape[1] == 2:
        arr = np.column_stack([arr, np.zeros(len(arr))])
    return {"positions": arr.tolist()}


def calibrator_payload(result, np):
    name = "positions()"
    columns = {}
    if isinstance(result, dict):
        unknown = set(result) - {"position", "velocity", "acceleration", "power"}
        if unknown:
            raise ValueError(f"{name} returned unknown keys {sorted(unknown)}; use position, velocity, acceleration and power")
        if "position" not in result:
            raise ValueError(f'{name} returned a dict without "position"')
        columns = {k: np.asarray(v, dtype=float) for k, v in result.items()}
    else:
        if isinstance(result, (list, tuple)) and result and isinstance(result[0], dict):
            get = lambda p, keys, default: [p.get(k, default) for k in keys]  # noqa: E731
            columns["position"] = np.asarray([[p["x"], p["y"], p["z"]] for p in result], dtype=float)
            if any("vx" in p for p in result):
                columns["velocity"] = np.asarray([get(p, ("vx", "vy", "vz"), 0.0) for p in result], dtype=float)
            if any("ax" in p for p in result):
                columns["acceleration"] = np.asarray([get(p, ("ax", "ay", "az"), 0.0) for p in result], dtype=float)
            if any("power" in p for p in result):
                columns["power"] = np.asarray([p.get("power", math.nan) for p in result], dtype=float)
        else:
            arr = np.asarray(result, dtype=float)
            if arr.ndim != 2 or arr.shape[1] not in (3, 4):
                raise ValueError(
                    f"{name} must return an (N, 3) or (N, 4) array of positions (and power), or a dict with "
                    f'"position" and optionally "velocity", "acceleration" and "power"; got shape {arr.shape}'
                )
            columns["position"] = arr[:, :3]
            if arr.shape[1] == 4:
                columns["power"] = arr[:, 3]

    pos = columns["position"]
    if pos.ndim != 2 or pos.shape[1] != 3:
        raise ValueError(f"{name}: position must have shape (N, 3), got {pos.shape}")
    check_rows(pos, name, "calibrator positions", KINDS["calibrator"]["max_rows"])
    n = len(pos)
    payload = {}
    for key in ("position", "velocity", "acceleration"):
        if key not in columns:
            continue
        v = columns[key]
        if v.shape != (n, 3):
            raise ValueError(f"{name}: {key} must have shape ({n}, 3), got {v.shape}")
        if not np.all(np.isfinite(v)):
            raise ValueError(f"{name} returned a non-finite {key}")
        payload["positions" if key == "position" else key] = v.tolist()
    if "power" in columns:
        power = columns["power"]
        if power.shape != (n,):
            raise ValueError(f"{name}: power must have shape ({n},), got {power.shape}")
        if np.any(power[np.isfinite(power)] < 0) or np.any(np.isinf(power)):
            raise ValueError(f"{name} returned a negative or infinite power")
        # JSON has no NaN: rows without a power are sent as null.
        payload["power"] = [None if math.isnan(v) else v for v in power.tolist()]
    return payload


def transmitter_payload(result, np):
    name = "buffer()"
    arr = np.asarray(result)
    if arr.ndim == 2 and arr.shape[1] == 2 and not np.iscomplexobj(arr):
        arr = arr[:, 0] + 1j * arr[:, 1]
    if arr.ndim != 1:
        raise ValueError(f"{name} must return a 1-D array of complex samples (or an (N, 2) array of I and Q), got shape {arr.shape}")
    try:
        samples = arr.astype(np.complex64)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must return numbers: {exc}") from None
    check_rows(samples, name, "samples", KINDS["transmitter"]["max_rows"])
    if not np.all(np.isfinite(samples)):
        raise ValueError(f"{name} returned non-finite samples")
    if not np.any(samples != 0):
        raise ValueError(f"{name} returned only zeros")
    iq = np.empty(2 * len(samples), dtype="<f4")
    iq[0::2] = samples.real
    iq[1::2] = samples.imag
    return {"buffer": base64.b64encode(iq.tobytes()).decode("ascii")}


PAYLOADS = {"layout": layout_payload, "calibrator": calibrator_payload, "transmitter": transmitter_payload}


def main():
    request = json.load(sys.stdin)
    out = io.StringIO()
    kind = request.get("kind", "layout")
    if kind not in KINDS:
        emit(error=f"unknown kind {kind!r}", stdout="")
        return
    try:
        import numpy as np
    except ImportError:
        emit(error="numpy is not installed for this Python interpreter", stdout="")
        return

    c = 299792458.0
    ctx = dict(request.get("context") or {})
    if "fmin" in ctx and "fmax" in ctx:
        ctx.setdefault("wavelength_min", c / ctx["fmax"])
        ctx.setdefault("wavelength_max", c / ctx["fmin"])
    for key in ("offsets", "positions", "antennas", "centroid"):
        if key in ctx:
            ctx[key] = np.asarray(ctx[key], dtype=float)
    ctx["c"] = c
    ctx = types.SimpleNamespace(**ctx)

    code = request["code"]
    function = KINDS[kind]["function"]
    # Make the source visible to tracebacks (frame.line, SyntaxError context).
    linecache.cache[FILENAME] = (len(code), None, code.splitlines(True), FILENAME)
    namespace = {"__name__": "__fringe__", "np": np, "numpy": np, "math": math}
    try:
        with contextlib.redirect_stdout(out):
            exec(compile(code, FILENAME, "exec"), namespace)
            fn = namespace.get(function)
            if not callable(fn):
                raise NameError(f"define a function named {function}() (or {function}(ctx)) that returns the {KINDS[kind]['what']}")
            takes_ctx = len(inspect.signature(fn).parameters) >= 1
            result = fn(ctx) if takes_ctx else fn()
        payload = PAYLOADS[kind](result, np)
    except Exception as exc:  # report everything, including the user's own exceptions
        emit(error=user_traceback(exc), stdout=out.getvalue()[-MAX_STDOUT:])
        return
    emit(**payload, stdout=out.getvalue()[-MAX_STDOUT:])


if __name__ == "__main__":
    main()
