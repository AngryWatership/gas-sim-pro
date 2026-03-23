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

-- Pre-compute wall/door layout features per (layout_id, config_hash)
-- Walls stored as flat cell indices: cell_idx = row * 100 + col
-- Grid is 100x100 = 10000 cells total
walls_base as (
    select
        layout_id,
        config_hash,

        -- Count features
        n_walls,
        n_doors,

        -- Wall centroid
        wall_centroid_row,
        wall_centroid_col,

        -- Wall spread (compact room vs long corridor)
        wall_spread_row,
        wall_spread_col,

        -- Wall density per quadrant
        walls_q1, walls_q2, walls_q3, walls_q4

    from (
        select
            layout_id,
            config_hash,
            ARRAY_LENGTH(JSON_EXTRACT_ARRAY(TO_JSON_STRING(walls_arr)))  as n_walls,
            ARRAY_LENGTH(JSON_EXTRACT_ARRAY(TO_JSON_STRING(doors_arr)))  as n_doors,
            (select avg(cast(w as int64) / 100)
             from unnest(JSON_EXTRACT_ARRAY(TO_JSON_STRING(walls_arr))) as w
            )                                                             as wall_centroid_row,
            (select avg(mod(cast(w as int64), 100))
             from unnest(JSON_EXTRACT_ARRAY(TO_JSON_STRING(walls_arr))) as w
            )                                                             as wall_centroid_col,
            (select stddev_samp(cast(w as int64) / 100)
             from unnest(JSON_EXTRACT_ARRAY(TO_JSON_STRING(walls_arr))) as w
            )                                                             as wall_spread_row,
            (select stddev_samp(mod(cast(w as int64), 100))
             from unnest(JSON_EXTRACT_ARRAY(TO_JSON_STRING(walls_arr))) as w
            )                                                             as wall_spread_col,
            (select countif(cast(w as int64) / 100 < 50
                         and mod(cast(w as int64),100) < 50)
             from unnest(JSON_EXTRACT_ARRAY(TO_JSON_STRING(walls_arr))) as w
            )                                                             as walls_q1,
            (select countif(cast(w as int64) / 100 < 50
                         and mod(cast(w as int64),100) >= 50)
             from unnest(JSON_EXTRACT_ARRAY(TO_JSON_STRING(walls_arr))) as w
            )                                                             as walls_q2,
            (select countif(cast(w as int64) / 100 >= 50
                         and mod(cast(w as int64),100) < 50)
             from unnest(JSON_EXTRACT_ARRAY(TO_JSON_STRING(walls_arr))) as w
            )                                                             as walls_q3,
            (select countif(cast(w as int64) / 100 >= 50
                         and mod(cast(w as int64),100) >= 50)
             from unnest(JSON_EXTRACT_ARRAY(TO_JSON_STRING(walls_arr))) as w
            )                                                             as walls_q4
        from (
            select layout_id, config_hash,
                   any_value(walls_arr) as walls_arr,
                   any_value(doors_arr) as doors_arr
            from {{ ref('stg_simulation_ticks') }}
            where walls_arr is not null
            group by layout_id, config_hash
        )
    )
),

-- Compute per-tick wall proximity features using aggregated sensor centroid
-- walls_near_centroid and walls_blocking_top1 require tick-level centroid
-- so they are computed in a separate CTE after aggregation
walls_proximity as (
    select
        a.source, a.seed, a.layout_id, a.config_hash, a.tick,

        -- walls_near_centroid: wall cells within radius 10 of weighted sensor centroid
        (
            select countif(
                pow(cast(w as int64) / 100 - a.centroid_row, 2) +
                pow(mod(cast(w as int64), 100) - a.centroid_col, 2) <= 100.0
            )
            from unnest(JSON_EXTRACT_ARRAY(TO_JSON_STRING(wl.walls_arr))) as w
        )                                                                   as walls_near_centroid,

        -- walls_blocking_top1: walls near midpoint between top1 sensor and sensor centroid
        (
            select countif(
                pow(cast(w as int64) / 100
                    - (m.top1_row + a.centroid_row) / 2.0, 2) +
                pow(mod(cast(w as int64), 100)
                    - (m.top1_col + a.centroid_col) / 2.0, 2) <= 25.0
            )
            from unnest(JSON_EXTRACT_ARRAY(TO_JSON_STRING(wl.walls_arr))) as w
        )                                                                   as walls_blocking_top1

    from (
        -- Re-aggregate centroid and top1 position per tick
        select
            b2.source, b2.seed, b2.layout_id, b2.config_hash, b2.tick,
            safe_divide(sum(b2.sensor_row * b2.sensor_reading),
                        nullif(sum(b2.sensor_reading), 0))   as centroid_row,
            safe_divide(sum(b2.sensor_col * b2.sensor_reading),
                        nullif(sum(b2.sensor_reading), 0))   as centroid_col
        from {{ ref('stg_simulation_ticks') }} b2
        group by b2.source, b2.seed, b2.layout_id, b2.config_hash, b2.tick
    ) a
    join (
        -- Top1 sensor position per tick
        select source, seed, layout_id, config_hash, tick,
               max(case when rn=1 then sensor_row end) as top1_row,
               max(case when rn=1 then sensor_col end) as top1_col
        from (
            select *,
                row_number() over (
                    partition by source, seed, layout_id, config_hash, tick
                    order by sensor_reading desc
                ) as rn
            from {{ ref('stg_simulation_ticks') }}
        )
        group by source, seed, layout_id, config_hash, tick
    ) m using (source, seed, layout_id, config_hash, tick)
    join (
        select layout_id, config_hash,
               any_value(walls_arr) as walls_arr
        from {{ ref('stg_simulation_ticks') }}
        where walls_arr is not null
        group by layout_id, config_hash
    ) wl using (layout_id, config_hash)
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

        -- Wall/door layout features
        any_value(wb.n_walls)                                                  as n_walls,
        any_value(wb.n_doors)                                                  as n_doors,
        safe_divide(any_value(wb.n_walls), 10000.0)                            as wall_density,
        safe_divide(10000.0 - any_value(wb.n_walls) - any_value(wb.n_doors),
                    10000.0)                                                    as open_path_ratio,
        any_value(wb.wall_centroid_row)                                        as wall_centroid_row,
        any_value(wb.wall_centroid_col)                                        as wall_centroid_col,
        any_value(wb.wall_spread_row)                                          as wall_spread_row,
        any_value(wb.wall_spread_col)                                          as wall_spread_col,
        any_value(wb.walls_q1)                                                 as walls_q1,
        any_value(wb.walls_q2)                                                 as walls_q2,
        any_value(wb.walls_q3)                                                 as walls_q3,
        any_value(wb.walls_q4)                                                 as walls_q4,

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
    left join walls_base wb
        on  b.layout_id   = wb.layout_id
        and b.config_hash = wb.config_hash
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
    wn.source, wn.seed, wn.layout_id, wn.config_hash,
    wn.locked_dimensions, wn.tick, wn.uploaded_at,

    -- Input features (sensor-derived)
    wn.sensor_delta,
    wn.sensor_mean,
    coalesce(wn.reading_variance, 0)           as reading_variance,
    coalesce(wn.centroid_row, 50.0)            as centroid_row,
    coalesce(wn.centroid_col, 50.0)            as centroid_col,
    wn.coverage_ratio,
    wn.wind_angle,
    wn.wind_magnitude,
    coalesce(wn.distance_to_boundary, 0)       as distance_to_boundary,
    wn.wind_x,
    wn.wind_y,
    wn.diffusion_rate,
    wn.decay_factor,
    wn.leak_injection,
    wn.sensor_count,
    wn.n_sensors_above_threshold,
    wn.max_reading,
    wn.max_reading_row,
    wn.max_reading_col,

    -- Wall/door layout features — full Approach A (14)
    coalesce(wn.n_walls, 0)                       as n_walls,
    coalesce(wn.n_doors, 0)                       as n_doors,
    coalesce(wn.wall_density, 0)               as wall_density,
    coalesce(wn.open_path_ratio, 1.0)          as open_path_ratio,
    coalesce(wn.wall_centroid_row, 50.0)       as wall_centroid_row,
    coalesce(wn.wall_centroid_col, 50.0)       as wall_centroid_col,
    coalesce(wn.wall_spread_row, 0)            as wall_spread_row,
    coalesce(wn.wall_spread_col, 0)            as wall_spread_col,
    coalesce(wn.walls_q1, 0)                   as walls_q1,
    coalesce(wn.walls_q2, 0)                   as walls_q2,
    coalesce(wn.walls_q3, 0)                   as walls_q3,
    coalesce(wn.walls_q4, 0)                   as walls_q4,
    coalesce(wp.walls_near_centroid, 0)        as walls_near_centroid,
    coalesce(wp.walls_blocking_top1, 0)        as walls_blocking_top1,

    -- Top-3 individual sensor positions and readings
    coalesce(wn.top1_row, 50.0)      as top1_row,
    coalesce(wn.top1_col, 50.0)      as top1_col,
    coalesce(wn.top1_reading, 0.0)   as top1_reading,
    coalesce(wn.top2_row, 50.0)      as top2_row,
    coalesce(wn.top2_col, 50.0)      as top2_col,
    coalesce(wn.top2_reading, 0.0)   as top2_reading,
    coalesce(wn.top3_row, 50.0)      as top3_row,
    coalesce(wn.top3_col, 50.0)      as top3_col,
    coalesce(wn.top3_reading, 0.0)   as top3_reading,

    -- Triangulation features derived from top-3 sensors
    safe_divide(
        wn.top1_row * coalesce(top1_reading,0) +
        wn.top2_row * coalesce(top2_reading,0) +
        wn.top3_row * coalesce(top3_reading,0),
        nullif(coalesce(top1_reading,0) + coalesce(top2_reading,0) + coalesce(top3_reading,0), 0)
    )                                                           as top3_centroid_row,
    safe_divide(
        wn.top1_col * coalesce(top1_reading,0) +
        wn.top2_col * coalesce(top2_reading,0) +
        wn.top3_col * coalesce(top3_reading,0),
        nullif(coalesce(top1_reading,0) + coalesce(top2_reading,0) + coalesce(top3_reading,0), 0)
    )                                                           as top3_centroid_col,
    safe_divide(
        coalesce(wn.top1_reading,0),
        nullif(coalesce(wn.top2_reading,0), 0)
    )                                                           as t1_t2_ratio,
    safe_divide(
        coalesce(wn.top1_reading,0),
        nullif(coalesce(wn.top3_reading,0), 0)
    )                                                           as t1_t3_ratio,

    -- Pairwise sensor distances and vectors
    sqrt(pow(coalesce(wn.top1_row,50) - coalesce(top2_row,50), 2) +
         pow(coalesce(top1_col,50) - coalesce(top2_col,50), 2)) as t1_t2_dist,
    sqrt(pow(coalesce(wn.top1_row,50) - coalesce(top3_row,50), 2) +
         pow(coalesce(top1_col,50) - coalesce(top3_col,50), 2)) as t1_t3_dist,
    coalesce(wn.top1_row,50) - coalesce(wn.top2_row,50)               as t1_t2_vec_row,
    coalesce(wn.top1_col,50) - coalesce(wn.top2_col,50)               as t1_t2_vec_col,

    -- Multi-leak input features
    wn.n_leaks,
    coalesce(wn.target_centroid_row, 50.0)     as leaks_centroid_row,
    coalesce(wn.target_centroid_col, 50.0)     as leaks_centroid_col,
    coalesce(wn.leaks_spread_row, 0)           as leaks_spread_row,
    coalesce(wn.leaks_spread_col, 0)           as leaks_spread_col,

    -- Targets
    coalesce(wn.target_centroid_row, 50.0)     as target_centroid_row,
    coalesce(wn.target_centroid_col, 50.0)     as target_centroid_col,
    coalesce(wn.target_nearest_row, 50.0)      as target_nearest_row,
    coalesce(wn.target_nearest_col, 50.0)      as target_nearest_col,
    wn.n_leaks                                 as target_n_leaks

from with_nearest wn
left join walls_proximity wp
    on  wn.source      = wp.source
    and wn.seed        = wp.seed
    and wn.layout_id   = wp.layout_id
    and wn.config_hash = wp.config_hash
    and wn.tick        = wp.tick
where
    wn.target_centroid_row is not null
    and wn.target_centroid_col is not null
    and wn.sensor_delta > 0