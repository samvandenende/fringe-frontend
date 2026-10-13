//! Local frame of an observer on the lunar far-side equator, and UTC time parsing.
//!
//! Mirrors `lunar_farside_enu` in `scripts/gsm_sky.py`: the IAU/WGCCRE 2009 (Archinal et al.
//! 2011) lunar pole (α0, δ0) and prime meridian W give the outward normal at selenographic
//! longitude 180°, latitude 0°. The frame is x = east, y = north (lunar spin axis), z = up, with
//! all vectors in ICRS axes.

/// East, north and up unit vectors in ICRS axes.
#[derive(Clone, Copy, Debug)]
pub struct Basis {
    pub east: [f64; 3],
    pub north: [f64; 3],
    pub up: [f64; 3],
}

impl Basis {
    /// Components of an ICRS vector in the local (east, north, up) frame.
    pub fn to_local(self, v: [f64; 3]) -> [f64; 3] {
        [dot(self.east, v), dot(self.north, v), dot(self.up, v)]
    }
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/// TT − UTC (TAI − UTC = 37 s since 2017, plus 32.184 s). TDB differs from TT by < 2 ms. Earlier
/// epochs are off by their missing leap seconds, which moves the frame by < 0.01°.
const TT_MINUS_UTC_S: f64 = 69.184;

/// Parses an ISO 8601 UTC timestamp (`YYYY-MM-DD[T| ]HH:MM[:SS[.fff]][Z]`) into Unix seconds.
pub fn parse_utc(s: &str) -> Result<f64, String> {
    parse_utc_parts(s).map(|(whole, frac)| whole as f64 + frac)
}

/// Like [`parse_utc`], split into whole Unix seconds and the fraction, so differences between
/// nearby timestamps keep sub-microsecond precision.
pub fn parse_utc_parts(s: &str) -> Result<(i64, f64), String> {
    let err = || format!("{s:?} is not an ISO 8601 UTC time such as 2026-01-01T00:00:00");
    let s = s.trim().trim_end_matches(['Z', 'z']);
    let (date, time) = s.split_once(['T', 't', ' ']).unwrap_or((s, "00:00:00"));
    let d: Vec<&str> = date.split('-').collect();
    let t: Vec<&str> = time.split(':').collect();
    if d.len() != 3 || !(2..=3).contains(&t.len()) {
        return Err(err());
    }
    let int = |v: &str| v.parse::<i64>().map_err(|_| err());
    let (year, month, day) = (int(d[0])?, int(d[1])?, int(d[2])?);
    let (hour, minute) = (int(t[0])?, int(t[1])?);
    let second: f64 = t.get(2).map_or(Ok(0.0), |v| v.parse::<f64>().map_err(|_| err()))?;
    let (whole_second, fraction) = (second.trunc() as i64, second.fract());
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || !(0..24).contains(&hour)
        || !(0..60).contains(&minute) || !(0.0..61.0).contains(&second)
    {
        return Err(err());
    }
    // Days since 1970-01-01 (Howard Hinnant's days_from_civil).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Ok((days * 86400 + hour * 3600 + minute * 60 + whole_second, fraction))
}

/// Days since J2000.0 (TDB) for Unix seconds (UTC).
pub fn days_since_j2000(unix_utc: f64) -> f64 {
    (unix_utc + TT_MINUS_UTC_S) / 86400.0 + 2440587.5 - 2451545.0
}

/// Local frame at the centre of the lunar far side (longitude 180°, latitude 0°).
pub fn farside_basis(unix_utc: f64) -> Basis {
    let d = days_since_j2000(unix_utc);
    let t = d / 36525.0;
    let e = [
        0.0,
        125.045 - 0.0529921 * d,
        250.089 - 0.1059842 * d,
        260.008 + 13.0120009 * d,
        176.625 + 13.3407154 * d,
        357.529 + 0.9856003 * d,
        311.589 + 26.4057084 * d,
        134.963 + 13.0649930 * d,
        276.617 + 0.3287146 * d,
        34.226 + 1.7484877 * d,
        15.134 - 0.1589763 * d,
        119.743 + 0.0036096 * d,
        239.961 + 0.1643573 * d,
        25.053 + 12.9590088 * d,
    ]
    .map(f64::to_radians);
    let s = e.map(f64::sin);
    let c = e.map(f64::cos);
    let a0 = 269.9949 + 0.0031 * t - 3.8787 * s[1] - 0.1204 * s[2] + 0.0700 * s[3] - 0.0172 * s[4]
        + 0.0072 * s[6] - 0.0052 * s[10] + 0.0043 * s[13];
    let d0 = 66.5392 + 0.0130 * t + 1.5419 * c[1] + 0.0239 * c[2] - 0.0278 * c[3] + 0.0068 * c[4]
        - 0.0029 * c[6] + 0.0009 * c[7] + 0.0008 * c[10] - 0.0009 * c[13];
    let w = 38.3213 + 13.17635815 * d - 1.4e-12 * d * d + 3.5610 * s[1] + 0.1208 * s[2]
        - 0.0642 * s[3] + 0.0158 * s[4] + 0.0252 * s[5] - 0.0066 * s[6] - 0.0047 * s[7]
        - 0.0046 * s[8] + 0.0028 * s[9] + 0.0052 * s[10] + 0.0040 * s[11] + 0.0019 * s[12]
        - 0.0044 * s[13];
    let (a0, d0, w) = (a0.to_radians(), d0.to_radians(), w.to_radians());

    let pole = [d0.cos() * a0.cos(), d0.cos() * a0.sin(), d0.sin()];
    // Ascending node of the lunar equator on the ICRS equator.
    let node = [-a0.sin(), a0.cos(), 0.0];
    let q = cross(pole, node);
    let angle = w + std::f64::consts::PI; // longitude 180°
    let up = [
        node[0] * angle.cos() + q[0] * angle.sin(),
        node[1] * angle.cos() + q[1] * angle.sin(),
        node[2] * angle.cos() + q[2] * angle.sin(),
    ];
    let north = pole; // perpendicular to `up` on the equator
    let east = cross(north, up);
    Basis { east, north, up }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_utc() {
        assert_eq!(parse_utc("1970-01-01T00:00:00").unwrap(), 0.0);
        assert_eq!(parse_utc("2000-01-01T12:00:00Z").unwrap(), 946728000.0);
        assert_eq!(parse_utc("2026-01-01 00:00").unwrap(), 1767225600.0);
        assert_eq!(parse_utc("2024-02-29T06:30:15.5").unwrap(), 1709188215.5);
        let (a, b) = (parse_utc_parts("2026-01-01T00:00:00Z").unwrap(), parse_utc_parts("2026-01-01T00:00:00.000034133Z").unwrap());
        assert!(((b.0 - a.0) as f64 + (b.1 - a.1) - 34.133e-6).abs() < 1e-12);
        for bad in ["", "2026-13-01T00:00:00", "2026-01-01T25:00:00", "yesterday", "2026-01"] {
            assert!(parse_utc(bad).is_err(), "{bad} should not parse");
        }
    }

    #[test]
    fn basis_is_orthonormal_and_right_handed() {
        let b = farside_basis(parse_utc("2026-01-01T00:00:00").unwrap());
        for v in [b.east, b.north, b.up] {
            assert!((dot(v, v) - 1.0).abs() < 1e-12);
        }
        assert!(dot(b.east, b.north).abs() < 1e-12 && dot(b.north, b.up).abs() < 1e-12);
        let z = cross(b.east, b.north);
        assert!((0..3).all(|i| (z[i] - b.up[i]).abs() < 1e-12));
    }

    #[test]
    fn matches_python_generator() {
        // scripts/gsm_sky.py at 2026-01-01T00:00:00 UTC reports the zenith at
        // RA 66.0833°, Dec 20.0875° (ICRS).
        let b = farside_basis(parse_utc("2026-01-01T00:00:00").unwrap());
        let ra = b.up[1].atan2(b.up[0]).to_degrees().rem_euclid(360.0);
        let dec = b.up[2].asin().to_degrees();
        assert!((ra - 66.0833).abs() < 0.01, "ra {ra}");
        assert!((dec - 20.0875).abs() < 0.01, "dec {dec}");
    }
}
