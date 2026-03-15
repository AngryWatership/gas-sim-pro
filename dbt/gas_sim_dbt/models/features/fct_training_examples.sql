-- fct_training_examples.sql
-- One row per (layout_id, tick) = one training example.
-- Aggregates sensor readings into engineered features.
-- Target variables: leak_row, leak_col (Phase 1 — single leak only).

with base as (
    select * from {{ ref('stg_simulation_ticks') }}
),

aggregated as (
    select
        source,
        seed,
        layout_id,
        config_hash,
        tick,
        wind_x,
        wind_y,
        diffusion_rate,
        decay_factor,
        leak_injection,
        uploaded_at,

        -- Array/JSON columns cannot be in GROUP BY — use ANY_VALUE
        any_value(locked_dimensions)  as locked_dimensions,
        any_value(leaks_arr)          as leaks_arr,
        any_value(walls_arr)          as walls_arr,
        any_value(doors_arr)          as doors_arr,

        -- Sensor aggregates
        max(sensor_reading) - min(sensor_reading)            as sensor_delta,
        avg(sensor_reading)                                  as sensor_mean,
        stddev_samp(sensor_reading)                          as reading_variance,

        -- Weighted centroid by reading value
        safe_divide(
            sum(sensor_row * sensor_reading),
            nullif(sum(sensor_reading), 0)
        )                                                    as centroid_row,

        safe_divide(
            sum(sensor_col * sensor_reading),
            nullif(sum(sensor_reading), 0)
        )                                                    as centroid_col,

        -- Coverage: fraction of sensors with non-trivial reading
        safe_divide(
            countif(sensor_reading > 0.01),
            count(*)
        )                                                    as coverage_ratio,

        count(*)                                             as sensor_count

    from base
    group by
        source, seed, layout_id, config_hash, tick,
        wind_x, wind_y, diffusion_rate, decay_factor,
        leak_injection, uploaded_at
),

with_targets as (
    select
        a.*,

        -- Wind derived features
        atan2(a.wind_y, a.wind_x)                           as wind_angle,
        sqrt(a.wind_x * a.wind_x + a.wind_y * a.wind_y)    as wind_magnitude,

        -- Distance of centroid from nearest grid boundary (100x100 grid)
        least(
            a.centroid_row,
            100 - a.centroid_row,
            a.centroid_col,
            100 - a.centroid_col
        )                                                    as distance_to_boundary,

        -- Targets — first leak only (Phase 1)
        -- leaks_arr is already ARRAY<JSON> from staging — index directly
        cast(json_extract_scalar(
            a.leaks_arr[offset(0)], '$.row'
        ) as float64)                                        as leak_row,

        cast(json_extract_scalar(
            a.leaks_arr[offset(0)], '$.col'
        ) as float64)                                        as leak_col

    from aggregated a
)

select
    source,
    seed,
    layout_id,
    config_hash,
    locked_dimensions,
    tick,
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
    leak_row,
    leak_col,
    uploaded_at
from with_targets
where
    array_length(leaks_arr) = 1
    and leak_row is not null
    and leak_col is not null
    and sensor_delta > 0
