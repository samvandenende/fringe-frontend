#!/usr/bin/env python3
"""Generate a fringe sky model (sources CSV) from the PyGDSM GSM2016 model.

Every HEALPix pixel at the requested NSIDE becomes one source at the pixel centre. GSM2016
maps are generated in MJy/sr at `--maps` frequencies spanning [fmin, fmax], converted to Jansky
per pixel (× 1e6 × pixel solid angle), and a power law S(f) = S_ref (f / f_ref)^α is fitted per
pixel in log space, with f_ref the geometric mean of the map frequencies.

GSM2016 contains non-positive pixels at low frequencies; those samples are left out of the
fit. Pixels with fewer than two positive samples get α = 0 and S_ref = max(mean S, 0).

Frames (what is written as right_ascension / declination; fringe's zenith is declination +90°):

  lunar-farside  (default) local east/north/up frame of an observer on the lunar equator at the
                 centre of the far side (selenographic longitude 180°, latitude 0°) at --epoch:
                 x = east, y = north (lunar spin axis), z = zenith, so declination is elevation.
                 Uses the IAU/WGCCRE 2009 lunar orientation model (pole and prime meridian),
                 which includes physical libration; the zenith stays within libration (~8°) of
                 the anti-Earth direction and sweeps the ecliptic once per sidereal month.
  equatorial     ICRS right ascension / declination.
  galactic       galactic longitude / latitude.

The CSV goes to --output (default stdout). A one-line JSON summary prefixed with "SUMMARY "
is written to stderr.

Example:
    python3 gsm_sky.py --nside 32 --maps 5 --fmin 15e6 --fmax 45e6 --output sky.csv
"""

import argparse
import contextlib
import json
import sys


def parse_args():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--nside", type=int, default=32, help="HEALPix NSIDE of the output sky (power of two)")
    p.add_argument("--maps", type=int, default=5, help="number of GSM maps used to fit the spectral index (>= 2)")
    p.add_argument("--fmin", type=float, required=True, help="lowest map frequency in Hz (>= 10 MHz)")
    p.add_argument("--fmax", type=float, required=True, help="highest map frequency in Hz")
    p.add_argument("--frame", choices=["lunar-farside", "equatorial", "galactic"], default="lunar-farside",
                   help="coordinate frame written as right_ascension/declination (see above)")
    p.add_argument("--epoch", default="2026-01-01T00:00:00",
                   help="UTC epoch for the lunar-farside frame (ISO 8601)")
    p.add_argument("--resolution", choices=["auto", "low", "hi"], default="auto",
                   help="GSM2016 base maps: low (NSIDE 64, 5°) or hi (NSIDE 1024, 48'); auto picks low for NSIDE <= 8")
    p.add_argument("--all-sky", action="store_true", help="keep pixels with declination <= 0 (below fringe's horizon)")
    p.add_argument("--output", default="-", help="output CSV path, or - for stdout")
    args = p.parse_args()

    if args.nside < 1 or args.nside > 1024 or args.nside & (args.nside - 1):
        p.error("--nside must be a power of two between 1 and 1024")
    if args.maps < 2:
        p.error("--maps must be at least 2 to fit a spectral index")
    if args.fmin < 10e6:
        p.error("GSM2016 is only defined above 10 MHz")
    if not args.fmax > args.fmin:
        p.error("--fmax must be larger than --fmin")
    return args


def lunar_farside_enu(t, np):
    """East, north and up unit vectors (ICRS axes) at the lunar far-side equator at time t.

    IAU/WGCCRE 2009 (Archinal et al. 2011) lunar pole (α0, δ0) and prime meridian W.
    """
    d = t.tdb.jd - 2451545.0
    T = d / 36525
    E = np.radians([
        0, 125.045 - 0.0529921 * d, 250.089 - 0.1059842 * d, 260.008 + 13.0120009 * d,
        176.625 + 13.3407154 * d, 357.529 + 0.9856003 * d, 311.589 + 26.4057084 * d,
        134.963 + 13.0649930 * d, 276.617 + 0.3287146 * d, 34.226 + 1.7484877 * d,
        15.134 - 0.1589763 * d, 119.743 + 0.0036096 * d, 239.961 + 0.1643573 * d,
        25.053 + 12.9590088 * d,
    ])
    s, c = np.sin(E), np.cos(E)
    a0 = (269.9949 + 0.0031 * T - 3.8787 * s[1] - 0.1204 * s[2] + 0.0700 * s[3] - 0.0172 * s[4]
          + 0.0072 * s[6] - 0.0052 * s[10] + 0.0043 * s[13])
    d0 = (66.5392 + 0.0130 * T + 1.5419 * c[1] + 0.0239 * c[2] - 0.0278 * c[3] + 0.0068 * c[4]
          - 0.0029 * c[6] + 0.0009 * c[7] + 0.0008 * c[10] - 0.0009 * c[13])
    W = (38.3213 + 13.17635815 * d - 1.4e-12 * d * d + 3.5610 * s[1] + 0.1208 * s[2]
         - 0.0642 * s[3] + 0.0158 * s[4] + 0.0252 * s[5] - 0.0066 * s[6] - 0.0047 * s[7]
         - 0.0046 * s[8] + 0.0028 * s[9] + 0.0052 * s[10] + 0.0040 * s[11] + 0.0019 * s[12]
         - 0.0044 * s[13])
    a0, d0, W = np.radians([a0, d0, W])
    pole = np.array([np.cos(d0) * np.cos(a0), np.cos(d0) * np.sin(a0), np.sin(d0)])
    node = np.array([-np.sin(a0), np.cos(a0), 0.0])  # ascending node of the lunar equator on the ICRS equator
    up = node * np.cos(W + np.pi) + np.cross(pole, node) * np.sin(W + np.pi)  # longitude 180°
    north = pole  # perpendicular to up on the equator
    east = np.cross(north, up)
    return east, north, up


def main():
    args = parse_args()

    # pygdsm downloads/loads its data at import time and may print progress; keep stdout for the CSV.
    with contextlib.redirect_stdout(sys.stderr):
        import healpy as hp
        import numpy as np
        from pygdsm import GlobalSkyModel16

        resolution = args.resolution
        if resolution == "auto":
            resolution = "low" if args.nside <= 8 else "hi"
        gsm = GlobalSkyModel16(freq_unit="MHz", data_unit="MJysr", resolution=resolution)

        freqs = np.linspace(args.fmin, args.fmax, args.maps)
        npix = hp.nside2npix(args.nside)
        pixel_sr = hp.nside2pixarea(args.nside)

        # One map at a time keeps memory bounded for the NSIDE-1024 base maps.
        flux = np.empty((args.maps, npix))
        for i, f in enumerate(freqs):
            mjysr = gsm.generate(f / 1e6)  # galactic, RING ordering
            flux[i] = hp.ud_grade(mjysr, args.nside, order_in="RING", order_out="RING") * 1e6 * pixel_sr

        # Least-squares power law in log space around the geometric-mean frequency.
        f_ref = float(np.exp(np.mean(np.log(freqs))))
        x = np.log(freqs / f_ref)[:, None] * np.ones((1, npix))
        valid = flux > 0
        y = np.log(np.where(valid, flux, 1.0))
        n = valid.sum(axis=0)
        sx = np.where(valid, x, 0).sum(axis=0)
        sy = np.where(valid, y, 0).sum(axis=0)
        sxx = np.where(valid, x * x, 0).sum(axis=0)
        sxy = np.where(valid, x * y, 0).sum(axis=0)
        denom = n * sxx - sx * sx
        fit = (n >= 2) & (denom > 0)
        alpha = np.where(fit, (n * sxy - sx * sy) / np.where(fit, denom, 1), 0.0)
        log_ref = np.where(fit, (sy - alpha * sx) / np.maximum(n, 1), 0.0)
        s_ref = np.where(fit, np.exp(log_ref), np.maximum(flux.mean(axis=0), 0.0))
        partial = int(((n < args.maps) & fit).sum())
        fallback = int((~fit).sum())

        residual = np.where(valid & fit, y - (log_ref + alpha * x), 0)
        fit_rms = float(np.sqrt((residual ** 2).sum() / max(1, (valid & fit).sum())))

        lon, lat = hp.pix2ang(args.nside, np.arange(npix), lonlat=True)  # galactic l, b in degrees
        frame_info = {}
        if args.frame != "galactic":
            from astropy.coordinates import SkyCoord
            import astropy.units as u
            icrs = SkyCoord(l=lon * u.deg, b=lat * u.deg, frame="galactic").icrs
            lon, lat = icrs.ra.deg, icrs.dec.deg
        if args.frame == "lunar-farside":
            import warnings
            from astropy.coordinates import get_body
            from astropy.time import Time
            import erfa

            warnings.simplefilter("ignore", erfa.ErfaWarning)  # leap seconds unknown for future epochs
            try:
                t = Time(args.epoch, format="isot", scale="utc")
            except ValueError:
                sys.exit(f"error: --epoch {args.epoch!r} is not an ISO 8601 UTC time such as 2026-01-01T00:00:00")
            east, north, up = lunar_farside_enu(t, np)
            v = icrs.cartesian.xyz.value  # (3, npix) unit vectors
            e, n, z = east @ v, north @ v, up @ v
            lon = np.degrees(np.arctan2(n, e))
            lat = np.degrees(np.arcsin(np.clip(z, -1, 1)))

            # Report where the zenith points and where Earth and the Sun are in the local sky.
            moon = get_body("moon", t).cartesian.xyz.to_value(u.km)
            sun = get_body("sun", t).cartesian.xyz.to_value(u.km)
            elevation = lambda vec: float(np.degrees(np.arcsin(up @ vec / np.linalg.norm(vec))))
            zenith = SkyCoord(x=up[0], y=up[1], z=up[2], representation_type="cartesian", frame="icrs")
            zenith.representation_type = "spherical"
            frame_info = {
                "epoch_utc": t.utc.isot,
                "zenith_icrs_deg": [float(zenith.ra.deg), float(zenith.dec.deg)],
                "zenith_galactic_deg": [float(zenith.galactic.l.deg), float(zenith.galactic.b.deg)],
                "earth_elevation_deg": elevation(-moon),
                "sun_elevation_deg": elevation(sun - moon),
            }
        ra = np.radians(lon) % (2 * np.pi)
        dec = np.radians(lat)

        keep = np.ones(npix, bool) if args.all_sky else dec > 0

    out = sys.stdout if args.output == "-" else open(args.output, "w")
    out.write("right_ascension,declination,reference_frequency,reference_intensity,spectral_index\n")
    for r, d, s, a in zip(ra[keep], dec[keep], s_ref[keep], alpha[keep]):
        out.write(f"{float(r)!r},{float(d)!r},{f_ref!r},{float(s)!r},{float(a)!r}\n")
    if out is not sys.stdout:
        out.close()

    summary = {
        "sources": int(keep.sum()),
        "pixels": int(npix),
        "nside": args.nside,
        "frame": args.frame,
        **frame_info,
        "resolution": resolution,
        "map_frequencies": [float(f) for f in freqs],
        "reference_frequency": f_ref,
        "pixel_solid_angle_sr": float(pixel_sr),
        "total_flux_jy": float(s_ref[keep].sum()),
        "alpha_percentiles": [float(v) for v in np.percentile(alpha[keep], [1, 50, 99])] if keep.any() else [],
        "fit_rms_ln": fit_rms,
        "pixels_with_nonpositive_samples": partial,
        "pixels_without_fit": fallback,
    }
    print("SUMMARY " + json.dumps(summary), file=sys.stderr)


if __name__ == "__main__":
    main()
