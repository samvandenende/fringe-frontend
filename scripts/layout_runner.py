"""Runs a user-written array layout function for the fringe frontend.

Reads {"code": str, "context": {...}} as JSON on stdin. The code must define `layout()` or
`layout(ctx)` returning antenna positions in metres: an (N, 2) or (N, 3) array-like (z = 0 when
omitted), or a sequence of {"x", "y"[, "z"]} mappings. Writes one JSON line to stdout:
{"positions": [[x, y, z], ...], "stdout": str} or {"error": str, "stdout": str}.
"""

import contextlib
import inspect
import io
import json
import linecache
import math
import sys
import traceback
import types

FILENAME = "<layout>"
MAX_ANTENNAS = 65536
MAX_STDOUT = 20000


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


def to_positions(result, np):
    if isinstance(result, (list, tuple)) and result and isinstance(result[0], dict):
        result = [[p["x"], p["y"], p.get("z", 0.0)] for p in result]
    arr = np.asarray(result, dtype=float)
    if arr.ndim != 2 or arr.shape[1] not in (2, 3):
        raise ValueError(f"layout() must return an (N, 2) or (N, 3) array of positions in metres, got shape {arr.shape}")
    if arr.shape[0] < 1:
        raise ValueError("layout() returned no antennas")
    if arr.shape[0] > MAX_ANTENNAS:
        raise ValueError(f"layout() returned {arr.shape[0]} antennas; at most {MAX_ANTENNAS} are supported")
    if not np.all(np.isfinite(arr)):
        raise ValueError("layout() returned non-finite positions")
    if arr.shape[1] == 2:
        arr = np.column_stack([arr, np.zeros(len(arr))])
    return arr


def main():
    request = json.load(sys.stdin)
    out = io.StringIO()
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
    ctx["c"] = c
    ctx = types.SimpleNamespace(**ctx)

    code = request["code"]
    # Make the source visible to tracebacks (frame.line, SyntaxError context).
    linecache.cache[FILENAME] = (len(code), None, code.splitlines(True), FILENAME)
    namespace = {"__name__": "__layout__", "np": np, "numpy": np, "math": math}
    try:
        with contextlib.redirect_stdout(out):
            exec(compile(code, FILENAME, "exec"), namespace)
            fn = namespace.get("layout")
            if not callable(fn):
                raise NameError("define a function named layout() (or layout(ctx)) that returns the antenna positions")
            takes_ctx = len(inspect.signature(fn).parameters) >= 1
            result = fn(ctx) if takes_ctx else fn()
        positions = to_positions(result, np)
    except Exception as exc:  # report everything, including the user's own exceptions
        emit(error=user_traceback(exc), stdout=out.getvalue()[-MAX_STDOUT:])
        return
    emit(positions=positions.tolist(), stdout=out.getvalue()[-MAX_STDOUT:])


if __name__ == "__main__":
    main()
