-- fct_training_examples.sql
-- One row per (layout_id, tick) = one training example.
-- Aggregates sensor readings into engineered features.
-- Target variables: leak_row, leak_col (Phase 1 — single leak only).

with base as (
    select * from {{ ref('stg_simulation_ticks') }}
),

-- Aggregate per tick across all sensors
aggregated as (
    select
        source,
        seed,
        layout_id,
        config_hash,
        locked_dimensions,
        tick,
        wind_x,
        wind_y,
        diffusion_rate,
        decay_factor,
        leak_injection,
        uploaded_at,
        leaks_arr,

        -- Sensor aggregates
        max(sensor_reading)  - min(sensor_reading)           as sensor_delta,
        avg(sensor_reading)                                   as sensor_mean,
        stddev_samp(sensor_reading)                           as reading_variance,

        -- Weighted centroid by reading value
        safe_divide(
            sum(sensor_row * sensor_reading),
            nullif(sum(sensor_reading), 0)
        )                                                     as centroid_row,

        safe_divide(
            sum(sensor_col * sensor_reading),
            nullif(sum(sensor_reading), 0)
        )                                                     as centroid_col,

        -- Coverage: fraction of sensors with non-trivial reading
        safe_divide(
            countif(sensor_reading > 0.01),
            count(*)
        )                                                     as coverage_ratio,

        count(*)                                              as sensor_count

    from base
    group by 1,2,3,4,5,6,7,8,9,10,11,12,13,14
),

-- Extract leak position from JSON (Phase 1: first leak only)
with_targets as (
    select
        a.*,

        -- Wind derived features
        atan2(a.wind_y, a.wind_x)                            as wind_angle,
        sqrt(a.wind_x * a.wind_x + a.wind_y * a.wind_y)     as wind_magnitude,

        -- Distance of centroid from nearest grid boundary (100x100 grid)
        least(
            a.centroid_row,
            100 - a.centroid_row,
            a.centroid_col,
            100 - a.centroid_col
        )                                                     as distance_to_boundary,

        -- Targets — first leak only (Phase 1)
        cast(json_extract_scalar(
            json_extract_array(a.leaks_arr)[offset(0)], '$.row'
        ) as float64)                                         as leak_row,

        cast(json_extract_scalar(
            json_extract_array(a.leaks_arr)[offset(0)], '$.col'
        ) as float64)                                         as leak_col

    from aggregated a
)

select
    source,
    seed,
    layout_id,
    config_hash,
    locked_dimensions,
    tick,
    -- Features
    sensor_delta,
    sensor_mean,
    reading_variance,
    centroid_row,
    centroid_col,
    coverage_ratio,
    wind_angle,
    wind_magnitude,
    distance_to_boundary,
    wind_x,
    wind_y,
    diffusion_rate,
    decay_factor,
    leak_injection,
    sensor_count,
    -- Targets
    leak_row,
    leak_col,
    uploaded_at
from with_targets
where
    -- Only single-leak records for Phase 1
    json_array_length(leaks_arr) = 1
    -- Require non-null targets
    and leak_row is not null
    and leak_col is not null
    -- Require meaningful sensor signal
    and sensor_delta > 0
