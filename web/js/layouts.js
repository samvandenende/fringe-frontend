// Example Python layout functions for the layout editor.

const HEADER = `# layout(ctx) returns antenna positions in metres: an (N, 2) or (N, 3) array-like
# (z = 0 when omitted). numpy is available as np and math as math; print() goes to the console.
#
# ctx: sample_frequency, downmix_frequency, bandpass (baseband, Hz), fmin / fmax (sky band, Hz),
#      wavelength_min / wavelength_max (m), sample_window_size, c, positions (current array).
`;

export const LAYOUT_EXAMPLES = [
  {
    name: 'Regular grid (λ/2)',
    code: `${HEADER}
def layout(ctx):
    """Square grid spaced λ_min / 2: no grating lobes anywhere in the band."""
    n = 32
    spacing = ctx.wavelength_min / 2
    print(f"spacing {spacing:.2f} m")
    i, j = np.meshgrid(np.arange(n), np.arange(n))
    return np.column_stack([i.ravel(), j.ravel()]) * spacing
`,
  },
  {
    name: 'Hexagonal disk',
    code: `${HEADER}
def layout(ctx):
    """Hexagonal grid filling a disk, spaced λ_min / 2."""
    d = ctx.wavelength_min / 2
    radius = 60.0
    n = int(radius / d) + 2
    pts = []
    for row in range(-2 * n, 2 * n + 1):
        y = row * d * math.sqrt(3) / 2
        offset = (row % 2) * d / 2
        for col in range(-n, n + 1):
            x = col * d + offset
            if x * x + y * y <= radius ** 2:
                pts.append((x, y))
    return pts
`,
  },
  {
    name: 'Random, minimum spacing',
    code: `${HEADER}
def layout(ctx):
    """Random antennas in a disk, rejecting any closer than a minimum spacing."""
    rng = np.random.default_rng(seed=1)
    n, radius, min_spacing = 256, 60.0, 4.0
    pts = np.zeros((n, 2))
    k = 0
    for _ in range(200_000):
        if k == n:
            break
        r, t = radius * np.sqrt(rng.random()), 2 * np.pi * rng.random()
        p = (r * np.cos(t), r * np.sin(t))
        if k == 0 or np.hypot(pts[:k, 0] - p[0], pts[:k, 1] - p[1]).min() >= min_spacing:
            pts[k] = p
            k += 1
    print(f"placed {k} of {n} antennas")
    return pts[:k]
`,
  },
  {
    name: 'Core + spiral arms',
    code: `${HEADER}
def layout(ctx):
    """Dense random core plus three logarithmic spiral arms."""
    rng = np.random.default_rng(seed=2)
    core = rng.normal(scale=10.0, size=(96, 2))
    arms, per_arm, pitch = 3, 40, np.radians(60)
    r = np.geomspace(15.0, 150.0, per_arm)
    theta = np.log(r / r[0]) / np.tan(pitch)
    spirals = [
        np.column_stack([r * np.cos(theta + 2 * np.pi * a / arms), r * np.sin(theta + 2 * np.pi * a / arms)])
        for a in range(arms)
    ]
    return np.vstack([core, *spirals])
`,
  },
  {
    name: 'Concentric rings',
    code: `${HEADER}
def layout(ctx):
    """Concentric rings with roughly constant spacing along each ring."""
    spacing = ctx.wavelength_min / 2
    pts = [(0.0, 0.0)]
    for radius in np.arange(spacing, 60.0, spacing):
        n = int(2 * np.pi * radius / spacing)
        t = np.linspace(0, 2 * np.pi, n, endpoint=False) + radius  # stagger the rings
        pts += list(zip(radius * np.cos(t), radius * np.sin(t)))
    return pts
`,
  },
  {
    name: 'Perturb current array',
    code: `${HEADER}
def layout(ctx):
    """Current array with a few centimetres of horizontal placement error."""
    rng = np.random.default_rng(seed=3)
    current = np.array(ctx.positions)
    return current + rng.normal(scale=0.05, size=current.shape) * [1, 1, 0]
`,
  },
  {
    name: 'Load from file',
    code: `${HEADER}
def layout(ctx):
    """Positions from a text file on the server machine: columns x y [z] in metres."""
    return np.loadtxt("/path/to/antennas.txt")
`,
  },
];
