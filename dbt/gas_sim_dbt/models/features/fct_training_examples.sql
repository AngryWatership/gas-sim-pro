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

-- Pre-compute top-3 sensors by reading per tick
ranked_sensors as (
    select *,
        row_number() over (
            partition by source, seed, layout_id, config_hash, tick
            order by sensor_reading desc
        ) as sensor_rank
    from base
),

top3_sensors as (
    select
        source, seed, layout_id, config_hash, tick,
        max(case when sensor_rank = 1 then sensor_row  end) as top1_row,
        max(case when sensor_rank = 1 then sensor_col  end) as top1_col,
        max(case when sensor_rank = 1 then sensor_reading end) as top1_reading,
        max(case when sensor_rank = 2 then sensor_row  end) as top2_row,
        max(case when sensor_rank = 2 then sensor_col  end) as top2_col,
        max(case when sensor_rank = 2 then sensor_reading end) as top2_reading,
        max(case when sensor_rank = 3 then sensor_row  end) as top3_row,
        max(case when sensor_rank = 3 then sensor_col  end) as top3_col,
        max(case when sensor_rank = 3 then sensor_reading end) as top3_reading
    from ranked_sensors
    group by source, seed, layout_id, config_hash, tick
),

-- Pre-compute max sensor row/col before grouping
max_sensor as (
    select
        source, seed, layout_id, config_hash, tick,
        max(sensor_reading)                                    as max_reading,
        max(case when rn = 1 then sensor_row end)             as max_reading_row,
        max(case when rn = 1 then sensor_col end)             as max_reading_col
    from (
        select *,
            row_number() over (
                partition by source, seed, layout_id, config_hash, tick
                order by sensor_reading desc
            ) as rn
        from base
    )
    group by source, seed, layout_id, config_hash, tick
),

aggregated as (
    select
        b.source, b.seed, b.layout_id, b.config_hash, b.tick,
        b.wind_x, b.wind_y, b.diffusion_rate, b.decay_factor, b.leak_injection, b.uploaded_at,
        any_value(b.locked_dimensions)                                         as locked_dimensions,
        any_value(b.leaks_arr)                                                 as leaks_arr,

        -- Core sensor aggregates
        max(b.sensor_reading) - min(b.sensor_reading)                         as sensor_delta,
        avg(b.sensor_reading)                                                  as sensor_mean,
        stddev_samp(b.sensor_reading)                                          as reading_variance,

        -- Weighted centroid by reading value
        safe_divide(
            sum(b.sensor_row * b.sensor_reading), nullif(sum(b.sensor_reading), 0)
        )                                                                      as centroid_row,
        safe_divide(
            sum(b.sensor_col * b.sensor_reading), nullif(sum(b.sensor_reading), 0)
        )                                                                      as centroid_col,

        -- Coverage
        safe_divide(countif(b.sensor_reading > 0.01), count(*))               as coverage_ratio,
        count(*)                                                               as sensor_count,

        -- Distribution shape features
        countif(b.sensor_reading > 0.10)                                       as n_sensors_above_threshold,

        -- Max reading and its position from pre-computed CTE
        any_value(m.max_reading)                                               as max_reading,
        any_value(m.max_reading_row)                                           as max_reading_row,
        any_value(m.max_reading_col)                                           as max_reading_col,

        -- Top-3 sensors by reading value
        any_value(t3.top1_row)                                                 as top1_row,
        any_value(t3.top1_col)                                                 as top1_col,
        any_value(t3.top1_reading)                                             as top1_reading,
        any_value(t3.top2_row)                                                 as top2_row,
        any_value(t3.top2_col)                                                 as top2_col,
        any_value(t3.top2_reading)                                             as top2_reading,
        any_value(t3.top3_row)                                                 as top3_row,
        any_value(t3.top3_col)                                                 as top3_col,
        any_value(t3.top3_reading)                                             as top3_reading

    from base b
    join max_sensor m
        on  b.source      = m.source
        and b.seed        = m.seed
        and b.layout_id   = m.layout_id
        and b.config_hash = m.config_hash
        and b.tick        = m.tick
    join top3_sensors t3
        on  b.source      = t3.source
        and b.seed        = t3.seed
        and b.layout_id   = t3.layout_id
        and b.config_hash = t3.config_hash
        and b.tick        = t3.tick
    group by b.source, b.seed, b.layout_id, b.config_hash, b.tick,
             b.wind_x, b.wind_y, b.diffusion_rate, b.decay_factor,
             b.leak_injection, b.uploaded_at
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

    -- Top-3 individual sensor positions and readings
    coalesce(top1_row, 50.0)      as top1_row,
    coalesce(top1_col, 50.0)      as top1_col,
    coalesce(top1_reading, 0.0)   as top1_reading,
    coalesce(top2_row, 50.0)      as top2_row,
    coalesce(top2_col, 50.0)      as top2_col,
    coalesce(top2_reading, 0.0)   as top2_reading,
    coalesce(top3_row, 50.0)      as top3_row,
    coalesce(top3_col, 50.0)      as top3_col,
    coalesce(top3_reading, 0.0)   as top3_reading,

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
