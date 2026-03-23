-- fct_training_examples.sql
-- One row per (layout_id, tick) = one training example.
-- Includes ALL records regardless of leak count (1-8 leaks).
-- Multi-leak records contribute aggregate targets:
--   target_centroid_row/col  — mean position across all leaks
--   target_nearest_row/col   — leak closest to sensor centroid
--   target_n_leaks           — number of leaks

with base as (
    select * from {{ ref('stg_simulation_ticks') }}
),

aggregated as (
    select
        source, seed, layout_id, config_hash, tick,
        wind_x, wind_y, diffusion_rate, decay_factor, leak_injection, uploaded_at,
        any_value(locked_dimensions) as locked_dimensions,
        any_value(leaks_arr)         as leaks_arr,

        -- Core sensor aggregates
        max(sensor_reading) - min(sensor_reading)                              as sensor_delta,
        avg(sensor_reading)                                                    as sensor_mean,
        stddev_samp(sensor_reading)                                            as reading_variance,

        -- Weighted centroid by reading value
        safe_divide(
            sum(sensor_row * sensor_reading), nullif(sum(sensor_reading), 0)
        )                                                                      as centroid_row,
        safe_divide(
            sum(sensor_col * sensor_reading), nullif(sum(sensor_reading), 0)
        )                                                                      as centroid_col,

        -- Coverage
        safe_divide(countif(sensor_reading > 0.01), count(*))                 as coverage_ratio,
        count(*)                                                               as sensor_count,

        -- Distribution shape features (multi-leak indicators)
        countif(sensor_reading > 0.10)                                         as n_sensors_above_threshold,
        max(sensor_reading)                                                    as max_reading,

        -- Row/col of sensor with highest reading
        any_value(sensor_row order by sensor_reading desc)                    as max_reading_row,
        any_value(sensor_col order by sensor_reading desc)                    as max_reading_col

    from base
    group by source, seed, layout_id, config_hash, tick,
             wind_x, wind_y, diffusion_rate, decay_factor,
             leak_injection, uploaded_at
),

with_wind as (
    select
        a.*,
        atan2(a.wind_y, a.wind_x)                            as wind_angle,
        sqrt(a.wind_x * a.wind_x + a.wind_y * a.wind_y)     as wind_magnitude,
        least(a.centroid_row, 100 - a.centroid_row,
              a.centroid_col, 100 - a.centroid_col)          as distance_to_boundary,
        array_length(a.leaks_arr)                            as n_leaks
    from aggregated a
    where sensor_delta > 0
),

with_leak_aggregates as (
    select
        w.*,

        -- Leak centroid (aggregate target — always valid regardless of n_leaks)
        (
            select avg(cast(json_extract_scalar(lk, '$.row') as float64))
            from unnest(w.leaks_arr) as lk
        ) as target_centroid_row,

        (
            select avg(cast(json_extract_scalar(lk, '$.col') as float64))
            from unnest(w.leaks_arr) as lk
        ) as target_centroid_col,

        -- Leak spread (how distributed are the leaks)
        (
            select stddev_samp(cast(json_extract_scalar(lk, '$.row') as float64))
            from unnest(w.leaks_arr) as lk
        ) as leaks_spread_row,

        (
            select stddev_samp(cast(json_extract_scalar(lk, '$.col') as float64))
            from unnest(w.leaks_arr) as lk
        ) as leaks_spread_col

    from with_wind w
),

with_nearest as (
    select
        la.*,

        -- Nearest leak to sensor centroid (individual target)
        (
            select cast(json_extract_scalar(lk, '$.row') as float64)
            from unnest(la.leaks_arr) as lk
            order by
                pow(cast(json_extract_scalar(lk, '$.row') as float64) - la.centroid_row, 2) +
                pow(cast(json_extract_scalar(lk, '$.col') as float64) - la.centroid_col, 2)
            limit 1
        ) as target_nearest_row,

        (
            select cast(json_extract_scalar(lk, '$.col') as float64)
            from unnest(la.leaks_arr) as lk
            order by
                pow(cast(json_extract_scalar(lk, '$.row') as float64) - la.centroid_row, 2) +
                pow(cast(json_extract_scalar(lk, '$.col') as float64) - la.centroid_col, 2)
            limit 1
        ) as target_nearest_col

    from with_leak_aggregates la
)

select
    source, seed, layout_id, config_hash, locked_dimensions, tick, uploaded_at,

    -- Input features (sensor-derived)
    sensor_delta,
    sensor_mean,
    coalesce(reading_variance, 0)           as reading_variance,
    coalesce(centroid_row, 50.0)            as centroid_row,
    coalesce(centroid_col, 50.0)            as centroid_col,
    coverage_ratio,
    wind_angle,
    wind_magnitude,
    coalesce(distance_to_boundary, 0)       as distance_to_boundary,
    wind_x,
    wind_y,
    diffusion_rate,
    decay_factor,
    leak_injection,
    sensor_count,
    n_sensors_above_threshold,
    max_reading,
    max_reading_row,
    max_reading_col,

    -- Multi-leak input features
    n_leaks,
    coalesce(target_centroid_row, 50.0)     as leaks_centroid_row,
    coalesce(target_centroid_col, 50.0)     as leaks_centroid_col,
    coalesce(leaks_spread_row, 0)           as leaks_spread_row,
    coalesce(leaks_spread_col, 0)           as leaks_spread_col,

    -- Targets
    coalesce(target_centroid_row, 50.0)     as target_centroid_row,
    coalesce(target_centroid_col, 50.0)     as target_centroid_col,
    coalesce(target_nearest_row, 50.0)      as target_nearest_row,
    coalesce(target_nearest_col, 50.0)      as target_nearest_col,
    n_leaks                                 as target_n_leaks

from with_nearest
where
    target_centroid_row is not null
    and target_centroid_col is not null
    and sensor_delta > 0
