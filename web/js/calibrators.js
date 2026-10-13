// Example Python functions for the calibrator: its trajectory (one state per integration) and its
// transmit buffer.

const HEADER = `# positions(ctx) returns one calibrator state per integration, in the array frame (x = east,
# y = north, z = up), relative to the array centroid or origin ("Positions relative to" under
# Calibrator). Either
#   - an (N, 3) array of positions (m), or (N, 4) with a transmit power column (EIRP in W; NaN
#     uses the EIRP field), or
#   - a dict {"position": (N, 3), "velocity": (N, 3), "acceleration": (N, 3), "power": (N,)},
#     where all but "position" are optional.
# Velocity (m/s) sets the Doppler shift; without it, it can be estimated from successive positions.
# numpy is available as np and math as math; print() goes to the console.
#
# ctx: integrations, interval (s), offsets (s after the start epoch, one per integration),
#      epoch (ISO 8601 UTC), epoch_unix, antennas (N, 3) and centroid (m), origin,
#      moon_radius (m), moon_gm (m³/s²), fmin / fmax (sky band, Hz), frequency (carrier, Hz), c.
# The function runs again when the integrations, interval or epoch change.
`;

export const CALIBRATOR_EXAMPLES = [
  {
    name: 'Lunar orbiter (circular orbit)',
    code: `${HEADER}
def positions(ctx):
    """Circular lunar orbit, overhead (or beside the array) at the middle of the timeline.

    Long timelines cover several orbits; skip the integrations with the orbiter below the
    horizon under Calibrator.
    """
    altitude = 100e3      # orbit altitude above the mean lunar radius (m)
    track_azimuth = 30.0  # direction of motion when closest to the array:
                          # degrees from north (+y) towards east (+x); 0 flies north, 90 east
    cross_track = 0.0     # distance of the ground track from the array, along the surface (m);
                          # positive is to the left of the direction of motion, 0 passes overhead

    r = ctx.moon_radius + altitude
    omega = math.sqrt(ctx.moon_gm / r) / r  # orbital angular rate (rad/s)
    span = ctx.offsets[-1]
    print(f"orbital period {2 * math.pi / omega / 60:.1f} min, speed {omega * r:.0f} m/s; "
          f"timeline {span:.0f} s = {span * omega / (2 * math.pi):.2f} orbits")

    theta = omega * (ctx.offsets - span / 2)[:, None]  # angle along the orbit from closest approach
    az = math.radians(track_azimuth)
    along = np.array([math.sin(az), math.cos(az), 0.0])  # direction of motion at closest approach
    left = np.array([-along[1], along[0], 0.0])           # cross-track direction
    up = np.array([0.0, 0.0, 1.0])
    beta = cross_track / ctx.moon_radius
    # Relative to the Moon's centre in the array's east/north/up axes, then to the surface below
    # the array. Velocity and acceleration are the derivatives of the orbit.
    u = np.cos(theta) * up + np.sin(theta) * along
    du = -np.sin(theta) * up + np.cos(theta) * along
    p = r * (math.cos(beta) * u + math.sin(beta) * left)
    v = r * omega * math.cos(beta) * du
    a = -r * omega**2 * math.cos(beta) * u
    p[:, 2] -= ctx.moon_radius
    return {"position": p, "velocity": v, "acceleration": a}
`,
  },
  {
    name: 'Drone circling the array',
    code: `${HEADER}
def positions(ctx):
    """Circle around the array at constant height, counter-clockwise seen from above."""
    radius = 100.0  # m
    height = 150.0  # m above the array
    period = 360.0  # s per circle, starting due east
    w = 2 * np.pi / period
    phi = w * ctx.offsets
    zero = np.zeros_like(phi)
    return {
        "position": np.column_stack([radius * np.cos(phi), radius * np.sin(phi), zero + height]),
        "velocity": np.column_stack([-radius * w * np.sin(phi), radius * w * np.cos(phi), zero]),
    }
`,
  },
  {
    name: 'Straight flyover, transmitting near the array',
    code: `${HEADER}
def positions(ctx):
    """Straight line over the array at constant speed and height, overhead mid-timeline.

    The power column switches the transmitter off beyond 500 m (0 W) and uses the EIRP field
    (NaN) near the array.
    """
    speed = 10.0     # m/s
    height = 200.0   # m
    heading = 90.0   # degrees from north (+y) towards east (+x)
    s = speed * (ctx.offsets - ctx.offsets[-1] / 2)  # distance along the track from overhead
    h = math.radians(heading)
    direction = np.array([math.sin(h), math.cos(h), 0.0])
    return {
        "position": s[:, None] * direction + [0.0, 0.0, height],
        "velocity": np.tile(speed * direction, (len(s), 1)),
        "power": np.where(np.abs(s) < 500.0, np.nan, 0.0),
    }
`,
  },
  {
    name: 'Load from a file on the server',
    code: `${HEADER}
def positions(ctx):
    """Positions from a CSV on the machine running the server (header row, then x, y, z columns).

    Unlike the sidebar's Load CSV, this re-reads the file (and can resample it) whenever the
    timeline changes.
    """
    path = "/path/to/positions.csv"
    data = np.loadtxt(path, delimiter=",", skiprows=1, usecols=(0, 1, 2), ndmin=2)
    # Resample to the timeline: here the file is assumed to hold one row per second.
    t = np.arange(len(data), dtype=float)
    p = np.column_stack([np.interp(ctx.offsets, t, data[:, k]) for k in range(3)])
    v = np.gradient(data, t, axis=0)  # velocity for the Doppler shift
    return {"position": p, "velocity": np.column_stack([np.interp(ctx.offsets, t, v[:, k]) for k in range(3)])}
`,
  },
];

const TX_HEADER = `# buffer(ctx) returns the transmit buffer: complex baseband samples (a 1-D array, or (N, 2) of
# I and Q) that the transmitter plays cyclically at the sample rate, upconverted to the carrier.
# Samples are relative levels: fringe scales the buffer so that playing it radiates the EIRP field
# (W), whatever its RMS; parts of its spectrum outside the filter bandwidth or the array's bandpass
# are lost. numpy is available as np and math as math; print() goes to the console.
#
# ctx: sample_rate, frequency (carrier), bandwidth (or None), power, start_time, fmin / fmax
#      (sky band, Hz), sample_frequency, downmix_frequency, window (samples), window_duration (s).
# A buffer at least as long as a window (window_duration × sample_rate samples) keeps the signal
# from repeating within one integration.
`;

export const TRANSMITTER_EXAMPLES = [
  {
    name: 'Gold code (BPSK), oversampled',
    code: `${TX_HEADER}
def buffer(ctx):
    """A Gold code (GPS-style PRN) at a chip rate below the sample rate, with rectangular chips."""
    degree = 10
    chip_rate = ctx.sample_rate / 4  # 4 samples per chip
    prn = 3                          # code number

    def m_sequence(taps):
        state = [1] * degree
        out = []
        for _ in range(2**degree - 1):
            out.append(state[-1])
            feedback = 0
            for t in taps:
                feedback ^= state[t - 1]
            state = [feedback] + state[:-1]
        return np.array(out)

    a = m_sequence([3, 10])
    b = m_sequence([2, 3, 6, 8, 9, 10])
    chips = 1 - 2 * (a ^ np.roll(b, prn))  # ±1
    per_chip = int(round(ctx.sample_rate / chip_rate))
    print(f"{len(chips)} chips at {ctx.sample_rate / per_chip / 1e6:.3f} Mchip/s, "
          f"period {len(chips) * per_chip / ctx.sample_rate * 1e6:.1f} µs")
    return np.repeat(chips, per_chip).astype(complex)
`,
  },
  {
    name: 'QPSK with root-raised-cosine pulses',
    code: `${TX_HEADER}
def buffer(ctx):
    """Random QPSK symbols shaped with a root-raised-cosine filter (applied cyclically)."""
    samples_per_symbol = 4
    rolloff = 0.35
    symbols = 4096
    rng = np.random.default_rng(1)
    data = (rng.choice([-1, 1], symbols) + 1j * rng.choice([-1, 1], symbols)) / math.sqrt(2)
    x = np.zeros(symbols * samples_per_symbol, complex)
    x[::samples_per_symbol] = data
    # Root-raised-cosine frequency response, applied by FFT (the buffer is cyclic).
    f = np.abs(np.fft.fftfreq(len(x), d=1 / samples_per_symbol))  # in units of the symbol rate
    lo, hi = (1 - rolloff) / 2, (1 + rolloff) / 2
    h = np.where(f <= lo, 1.0, np.where(f <= hi, np.cos(np.pi / (2 * rolloff) * (f - lo)), 0.0))
    y = np.fft.ifft(np.fft.fft(x) * h)
    print(f"symbol rate {ctx.sample_rate / samples_per_symbol / 1e6:.3f} MBd, "
          f"occupied bandwidth {(1 + rolloff) * ctx.sample_rate / samples_per_symbol / 1e6:.3f} MHz")
    return y  # any scale: fringe normalises the buffer to the EIRP
`,
  },
  {
    name: 'Comb of tones across the band',
    code: `${TX_HEADER}
def buffer(ctx):
    """Equal tones every 1 MHz within the sky band, with random phases (a multi-tone sounder)."""
    spacing = 1e6
    n = int(round(ctx.sample_rate / 1e3))  # 1 kHz resolution
    t = np.arange(n) / ctx.sample_rate
    offsets = np.arange(ctx.fmin, ctx.fmax + 1, spacing) - ctx.frequency
    offsets = offsets[np.abs(offsets) < ctx.sample_rate / 2]
    phases = np.random.default_rng(0).uniform(0, 2 * np.pi, len(offsets))
    y = sum(np.exp(1j * (2 * np.pi * f * t + p)) for f, p in zip(offsets, phases))
    print(f"{len(offsets)} tones, {n} samples")
    return y  # any scale: fringe normalises the buffer to the EIRP
`,
  },
  {
    name: 'Pulsed noise (on/off keying)',
    code: `${TX_HEADER}
def buffer(ctx):
    """White noise that is on for the first quarter of each period and off for the rest."""
    period = 4 * ctx.window_duration  # s, so the duty cycle shows across integrations
    n = int(round(period * ctx.sample_rate))
    rng = np.random.default_rng(2)
    x = (rng.standard_normal(n) + 1j * rng.standard_normal(n)) / math.sqrt(2)
    x[n // 4:] = 0
    return x  # fringe scales it to radiate the EIRP on average over the period, 4× that while on
`,
  },
  {
    name: 'Load a .cf32 file on the server',
    code: `${TX_HEADER}
def buffer(ctx):
    """Samples from a raw interleaved float32 IQ file (fringe's .cf32 buffer files, or an SDR's)."""
    path = "/path/to/buffer.cf32"
    return np.fromfile(path, dtype="<f4").view(np.complex64)
`,
  },
];
