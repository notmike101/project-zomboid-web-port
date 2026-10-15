//! Source body injury arithmetic and six-arm thermal action inputs.
//! No climate, healing, or actor-health synchronization is inferred here.

use std::cell::RefCell;

use crate::{BAD_FORMAT, F32_MAX, NONFINITE, OK, OUT_OF_RANGE};

const PARTS: usize = 17;
const FIELDS: usize = 16;
const SURFACES: [f32; PARTS] = [
    0.01, 0.01, 0.035, 0.035, 0.045, 0.045, 0.18, 0.12, 0.08, 0.02, 0.06, 0.09, 0.09, 0.07, 0.07,
    0.02, 0.02,
];
const DISTANCES: [f32; PARTS] = [
    0.8, 0.8, 0.6, 0.6, 0.3, 0.3, 0.0, 0.05, 0.8, 0.02, 0.3, 0.45, 0.45, 0.75, 0.75, 1.0, 1.0,
];
// health, scratch/cut/bite/deep/stitch/fracture, splint, burn, infection,
// additional pain, stiffness, bandaged/bullet/glass, skin temperature.
const LIMITS: [(f64, f64, f64, u32); FIELDS] = [
    (0.0, 100.0, 100.0, 0),
    (0.0, 100.0, 0.0, 0),
    (0.0, 100.0, 0.0, 0),
    (0.0, F32_MAX, 0.0, 0),
    (0.0, F32_MAX, 0.0, 0),
    (0.0, F32_MAX, 0.0, 0),
    (0.0, F32_MAX, 0.0, 0),
    (0.0, F32_MAX, 0.0, 0),
    (0.0, F32_MAX, 0.0, 0),
    (0.0, F32_MAX, 0.0, 0),
    (-F32_MAX, F32_MAX, 0.0, 0),
    (0.0, 100.0, 0.0, 0),
    (0.0, 1.0, 0.0, 2),
    (0.0, 1.0, 0.0, 2),
    (0.0, 1.0, 0.0, 2),
    (-F32_MAX, F32_MAX, 33.0, 0),
];

#[derive(Clone, Copy)]
struct BodyPart {
    values: [f32; FIELDS],
}

impl BodyPart {
    fn initial() -> Self {
        Self {
            values: LIMITS.map(|(_, _, default, _)| default as f32),
        }
    }

    fn pain(&self, severity: u32) -> f32 {
        let v = &self.values;
        let bandaged = v[12] != 0.0;
        let mut pain = 0.0;
        if v[1] > 0.0 {
            pain += v[1] * 1.7;
        }
        if v[2] > 0.0 {
            pain += v[2] * 2.5;
        }
        if v[3] > 0.0 {
            pain += if bandaged { 30.0 } else { 50.0 };
        }
        if v[4] > 0.0 {
            pain += v[4] * 3.7;
        }
        if v[5] > 0.0 && v[5] < 35.0 {
            if bandaged {
                pain += (35.0 - v[5]) / 2.0;
            } else {
                pain += 35.0 - v[5];
            }
        }
        if v[6] > 0.0 {
            pain += if v[7] > 0.0 { v[6] / 2.0 } else { v[6] };
        }
        if v[13] != 0.0 {
            pain += 50.0;
        }
        if v[14] != 0.0 {
            pain += 10.0;
        }
        if v[8] > 0.0 {
            pain += v[8];
        }
        if bandaged {
            pain /= 1.5;
        }
        if v[9] > 0.0 {
            pain += v[9];
        }
        pain += v[10] + v[11] / 3.5;
        match severity {
            0 => pain * 0.7,
            2 => pain * 1.3,
            _ => pain,
        }
    }
}

#[derive(Clone, Copy)]
struct BodyState {
    parts: [BodyPart; PARTS],
    severity: u32,
    metabolic_target: f32,
}

impl BodyState {
    fn initial() -> Self {
        Self {
            parts: [BodyPart::initial(); PARTS],
            severity: 1,
            metabolic_target: 1.5,
        }
    }
}

enum Staging {
    Part {
        index: usize,
        part: BodyPart,
        seen: u32,
    },
    Full {
        next: usize,
        metabolic_seen: bool,
    },
}

thread_local! {
    static BODY: RefCell<BodyState> = RefCell::new(BodyState::initial());
    static FULL_BODY: RefCell<BodyState> = RefCell::new(BodyState::initial());
    static STAGING: RefCell<Option<Staging>> = const { RefCell::new(None) };
}

fn validate(field: usize, value: f64) -> Result<f32, i32> {
    let Some(&(min, max, _, kind)) = LIMITS.get(field) else {
        return Err(OUT_OF_RANGE);
    };
    if !value.is_finite() {
        return Err(NONFINITE);
    }
    if !(min..=max).contains(&value) || (kind == 2 && value != 0.0 && value != 1.0) {
        return Err(OUT_OF_RANGE);
    }
    Ok(value as f32)
}

#[unsafe(no_mangle)]
pub extern "C" fn body_part_input_limit(field: u32, property: u32) -> f64 {
    match LIMITS.get(field as usize) {
        Some(&(min, max, default, kind)) => match property {
            0 => min,
            1 => max,
            2 => default,
            3 => kind as f64,
            _ => f64::NAN,
        },
        None => f64::NAN,
    }
}

/// Mutable fields 0..15; derived pain16, source surface17, distance18.
#[unsafe(no_mangle)]
pub extern "C" fn body_part_value(part: u32, field: u32) -> f64 {
    BODY.with(|body| {
        let body = body.borrow();
        let Some(row) = body.parts.get(part as usize) else {
            return f64::NAN;
        };
        match field as usize {
            i if i < FIELDS => row.values[i] as f64,
            16 => row.pain(body.severity) as f64,
            17 => SURFACES[part as usize] as f64,
            18 => DISTANCES[part as usize] as f64,
            _ => f64::NAN,
        }
    })
}

/// Host-normalized low0/normal1/high2, not the general damage multipliers.
#[unsafe(no_mangle)]
pub extern "C" fn body_injury_severity() -> u32 {
    BODY.with(|body| body.borrow().severity)
}

#[unsafe(no_mangle)]
pub extern "C" fn set_injury_severity(severity: u32) -> i32 {
    if severity > 2 {
        return OUT_OF_RANGE;
    }
    BODY.with(|body| body.borrow_mut().severity = severity);
    OK
}

#[unsafe(no_mangle)]
pub extern "C" fn thermal_action_modifier() -> f32 {
    BODY.with(|body| {
        let body = body.borrow();
        let mut modifier = 1.0;
        for (index, &surface) in SURFACES.iter().enumerate().take(6) {
            let skin = body.parts[index].values[15];
            if skin < 33.0 {
                let cold = 1.0 - (skin - 20.0) / 13.0;
                let q = 0.25 * (cold * cold) * surface;
                let weight = match index {
                    0 | 1 => 0.3,
                    2 | 3 => 0.15,
                    _ => 0.1,
                };
                modifier += weight * q;
            }
        }
        modifier
    })
}

/// Original Thermoregulator.setMetabolicTarget(float): accumulate the maximum
/// nonnegative request, clamped to Metabolics.MAX (10.3f), not thermal simulation.
#[unsafe(no_mangle)]
pub extern "C" fn body_metabolic_target_set(value: f64) -> i32 {
    if !value.is_finite() {
        return NONFINITE;
    }
    if value.abs() > F32_MAX {
        return OUT_OF_RANGE;
    }
    let value = value as f32;
    BODY.with(|state| {
        let mut state = state.borrow_mut();
        if value >= 0.0 && value >= state.metabolic_target {
            state.metabolic_target = value.min(10.3);
        }
    });
    OK
}

#[unsafe(no_mangle)]
pub extern "C" fn body_metabolic_target_get() -> f32 {
    BODY.with(|state| state.borrow().metabolic_target)
}

/// Saved targets include the original -1f end-of-thermal-update sentinel.
#[unsafe(no_mangle)]
pub extern "C" fn body_import_metabolic_stage(value: f64) -> i32 {
    if !value.is_finite() {
        body_import_abort();
        return NONFINITE;
    }
    if !(-1.0..=10.3_f32 as f64).contains(&value) {
        body_import_abort();
        return OUT_OF_RANGE;
    }
    STAGING.with(|staging| {
        let mut staging = staging.borrow_mut();
        if let Some(Staging::Full { metabolic_seen, .. }) = staging.as_mut()
            && !*metabolic_seen
        {
            FULL_BODY.with(|state| state.borrow_mut().metabolic_target = value as f32);
            *metabolic_seen = true;
            return OK;
        }
        *staging = None;
        BAD_FORMAT
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn body_update_begin(part: u32) -> i32 {
    body_import_abort();
    if part as usize >= PARTS {
        return OUT_OF_RANGE;
    }
    let candidate = BODY.with(|body| body.borrow().parts[part as usize]);
    STAGING.with(|staging| {
        *staging.borrow_mut() = Some(Staging::Part {
            index: part as usize,
            part: candidate,
            seen: 0,
        })
    });
    OK
}

#[unsafe(no_mangle)]
pub extern "C" fn body_update_stage(field: u32, value: f64) -> i32 {
    let value = match validate(field as usize, value) {
        Ok(value) => value,
        Err(code) => {
            body_import_abort();
            return code;
        }
    };
    STAGING.with(|staging| {
        let mut staging = staging.borrow_mut();
        if let Some(Staging::Part { part, seen, .. }) = staging.as_mut()
            && *seen & (1 << field) == 0
        {
            part.values[field as usize] = value;
            *seen |= 1 << field;
            return OK;
        }
        *staging = None;
        BAD_FORMAT
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn body_update_commit() -> i32 {
    STAGING.with(|staging| {
        let Some(Staging::Part { index, part, seen }) = staging.borrow_mut().take() else {
            return BAD_FORMAT;
        };
        if seen == 0 {
            return BAD_FORMAT;
        }
        BODY.with(|body| body.borrow_mut().parts[index] = part);
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn body_import_begin(severity: u32) -> i32 {
    body_import_abort();
    if severity > 2 {
        return OUT_OF_RANGE;
    }
    FULL_BODY.with(|body| {
        let mut body = body.borrow_mut();
        body.severity = severity;
        body.metabolic_target = 1.5;
    });
    STAGING.with(|staging| {
        *staging.borrow_mut() = Some(Staging::Full {
            next: 0,
            metabolic_seen: false,
        })
    });
    OK
}

/// Exactly 272 consecutive mutable-field words, canonical part-major order.
#[unsafe(no_mangle)]
pub extern "C" fn body_import_stage(index: u32, value: f64) -> i32 {
    if index as usize >= PARTS * FIELDS {
        body_import_abort();
        return OUT_OF_RANGE;
    }
    let value = match validate(index as usize % FIELDS, value) {
        Ok(value) => value,
        Err(code) => {
            body_import_abort();
            return code;
        }
    };
    STAGING.with(|staging| {
        let mut staging = staging.borrow_mut();
        if let Some(Staging::Full { next, .. }) = staging.as_mut()
            && index as usize == *next
        {
            FULL_BODY.with(|body| {
                body.borrow_mut().parts[*next / FIELDS].values[*next % FIELDS] = value;
            });
            *next += 1;
            return OK;
        }
        *staging = None;
        BAD_FORMAT
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn body_import_commit() -> i32 {
    STAGING.with(|staging| {
        let Some(Staging::Full { next, .. }) = staging.borrow_mut().take() else {
            return BAD_FORMAT;
        };
        if next != PARTS * FIELDS {
            return BAD_FORMAT;
        }
        FULL_BODY.with(|body| BODY.with(|state| *state.borrow_mut() = *body.borrow()));
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn body_import_abort() {
    STAGING.with(|staging| *staging.borrow_mut() = None);
}

pub(crate) fn reset() {
    BODY.with(|body| *body.borrow_mut() = BodyState::initial());
    body_import_abort();
}

#[cfg(test)]
mod metabolic_tests {
    use super::*;

    #[test]
    fn source_metabolic_target_accumulates_max_and_clamps_original_enum_limit() {
        reset();
        assert_eq!(body_metabolic_target_get(), 1.5);
        assert_eq!(body_metabolic_target_set(3.2), OK);
        assert_eq!(body_metabolic_target_get(), 3.2_f32);
        assert_eq!(body_metabolic_target_set(1.0), OK);
        assert_eq!(body_metabolic_target_set(-1.0), OK);
        assert_eq!(body_metabolic_target_get(), 3.2_f32);
        assert_eq!(body_metabolic_target_set(100.0), OK);
        assert_eq!(body_metabolic_target_get(), 10.3_f32);
        assert_eq!(body_metabolic_target_set(f64::NAN), NONFINITE);
        assert_eq!(body_metabolic_target_set(f64::MAX), OUT_OF_RANGE);
        assert_eq!(body_metabolic_target_get(), 10.3_f32);
        reset();
        assert_eq!(body_metabolic_target_get(), 1.5);
    }

    #[test]
    fn full_body_import_stages_exact_metabolic_target_and_failed_stage_is_atomic() {
        reset();
        assert_eq!(body_metabolic_target_set(3.2), OK);
        assert_eq!(body_import_begin(1), OK);
        assert_eq!(body_import_metabolic_stage(-1.0), OK);
        assert_eq!(body_metabolic_target_get(), 3.2_f32);
        for (index, value) in BodyState::initial()
            .parts
            .iter()
            .flat_map(|part| part.values.iter())
            .enumerate()
        {
            assert_eq!(body_import_stage(index as u32, *value as f64), OK);
        }
        assert_eq!(body_import_commit(), OK);
        assert_eq!(body_metabolic_target_get(), -1.0);
        assert_eq!(body_import_begin(1), OK);
        assert_eq!(body_import_metabolic_stage(11.0), OUT_OF_RANGE);
        assert_eq!(body_import_commit(), BAD_FORMAT);
        assert_eq!(body_metabolic_target_get(), -1.0);
    }
}
