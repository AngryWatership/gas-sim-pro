-- fct_training_examples.sql
-- One row per (layout_id, tick).
-- Produces exactly the features needed for the 34-feature model.
-- Single-leak filter and signal threshold applied in ml_export.

with base as (
    select
        source, seed, layout_id, config_hash, tick,
        wind_x, wind_y, diffusion_rate, decay_factor, leak_injection, uploaded_at,
        locked_dimensions, leaks_arr, walls_arr, doors_arr,
        sensor_row, sensor_col, sensor_reading
    from {{ ref('stg_simulation_ticks') }}
),

-- Wall features per layout — computed once per layout_id/config_hash
walls_base as (
    select
        layout_id,
        config_hash,
        ARRAY_LENGTH(JSON_EXTRACT_ARRAY(TO_JSON_STRING(walls_arr)))     as n_walls,
        ARRAY_LENGTH(JSON_EXTRACT_ARRAY(TO_JSON_STRING(doors_arr)))     as n_doors,
        (select avg(cast(w as int64) / 100)
         from unnest(JSON_EXTRACT_ARRAY(TO_JSON_STRING(walls_arr))) as w)   as wall_centroid_row,
        (select avg(mod(cast(w as int64), 100))
         from unnest(JSON_EXTRACT_ARRAY(TO_JSON_STRING(walls_arr))) as w)   as wall_centroid_col,
        (select stddev_samp(cast(w as int64) / 100)
         from unnest(JSON_EXTRACT_ARRAY(TO_JSON_STRING(walls_arr))) as w)   as wall_spread_row,
        (select stddev_samp(mod(cast(w as int64), 100))
         from unnest(JSON_EXTRACT_ARRAY(TO_JSON_STRING(walls_arr))) as w)   as wall_spread_col,
        (select countif(cast(w as int64) / 100 < 50 and mod(cast(w as int64),100) < 50)
         from unnest(JSON_EXTRACT_ARRAY(TO_JSON_STRING(walls_arr))) as w)   as walls_q1,
        (select countif(cast(w as int64) / 100 < 50 and mod(cast(w as int64),100) >= 50)
         from unnest(JSON_EXTRACT_ARRAY(TO_JSON_STRING(walls_arr))) as w)   as walls_q2,
        (select countif(cast(w as int64) / 100 >= 50 and mod(cast(w as int64),100) < 50)
         from unnest(JSON_EXTRACT_ARRAY(TO_JSON_STRING(walls_arr))) as w)   as walls_q3,
        (select countif(cast(w as int64) / 100 >= 50 and mod(cast(w as int64),100) >= 50)
         from unnest(JSON_EXTRACT_ARRAY(TO_JSON_STRING(walls_arr))) as w)   as walls_q4
    from (
        select layout_id, config_hash,
               any_value(walls_arr) as walls_arr,
               any_value(doors_arr) as doors_arr
        from base
        where walls_arr is not null
        group by layout_id, config_hash
    )
),

-- Top-3 sensors by reading per tick
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
        max(case when sensor_rank = 1 then sensor_row     end) as top1_row,
        max(case when sensor_rank = 1 then sensor_col     end) as top1_col,
        max(case when sensor_rank = 1 then sensor_reading end) as top1_reading,
        max(case when sensor_rank = 2 then sensor_row     end) as top2_row,
        max(case when sensor_rank = 2 then sensor_col     end) as top2_col,
        max(case when sensor_rank = 2 then sensor_reading end) as top2_reading,
        max(case when sensor_rank = 3 then sensor_row     end) as top3_row,
        max(case when sensor_rank = 3 then sensor_col     end) as top3_col,
        max(case when sensor_rank = 3 then sensor_reading end) as top3_reading
    from ranked_sensors
    group by source, seed, layout_id, config_hash, tick
),

-- Aggregate sensor stats per tick
aggregated as (
    select
        b.source, b.seed, b.layout_id, b.config_hash, b.tick,
        b.wind_x, b.wind_y, b.diffusion_rate, b.decay_factor,
        b.leak_injection, b.uploaded_at,
        any_value(b.locked_dimensions)                                  as locked_dimensions,
        any_value(b.leaks_arr)                                          as leaks_arr,

        max(b.sensor_reading) - min(b.sensor_reading)                  as sensor_delta,
        avg(b.sensor_reading)                                           as sensor_mean,
        var_samp(b.sensor_reading)                                      as reading_variance,
        safe_divide(sum(b.sensor_row * b.sensor_reading),
                    nullif(sum(b.sensor_reading), 0))                   as centroid_row,
        safe_divide(sum(b.sensor_col * b.sensor_reading),
                    nullif(sum(b.sensor_reading), 0))                   as centroid_col,
        safe_divide(countif(b.sensor_reading > 0.01), count(*))         as coverage_ratio,
        count(*)                                                         as sensor_count,

        -- Wall features
        any_value(wb.n_walls)                                           as n_walls,
        any_value(wb.n_doors)                                           as n_doors,
        safe_divide(any_value(wb.n_walls), 10000.0)                     as wall_density,
        safe_divide(10000.0 - any_value(wb.n_walls) - any_value(wb.n_doors),
                    10000.0)                                             as open_path_ratio,
        any_value(wb.wall_centroid_row)                                 as wall_centroid_row,
        any_value(wb.wall_centroid_col)                                 as wall_centroid_col,
        any_value(wb.wall_spread_row)                                   as wall_spread_row,
        any_value(wb.wall_spread_col)                                   as wall_spread_col,
        any_value(wb.walls_q1)                                          as walls_q1,
        any_value(wb.walls_q2)                                          as walls_q2,
        any_value(wb.walls_q3)                                          as walls_q3,
        any_value(wb.walls_q4)                                          as walls_q4,

        -- Top-3 sensors
        any_value(t3.top1_row)                                          as top1_row,
        any_value(t3.top1_col)                                          as top1_col,
        any_value(t3.top1_reading)                                      as top1_reading,
        any_value(t3.top2_row)                                          as top2_row,
        any_value(t3.top2_col)                                          as top2_col,
        any_value(t3.top2_reading)                                      as top2_reading,
        any_value(t3.top3_row)                                          as top3_row,
        any_value(t3.top3_col)                                          as top3_col,
        any_value(t3.top3_reading)                                      as top3_reading

    from base b
    join top3_sensors t3
        using (source, seed, layout_id, config_hash, tick)
    left join walls_base wb
        on b.layout_id = wb.layout_id and b.config_hash = wb.config_hash
    group by b.source, b.seed, b.layout_id, b.config_hash, b.tick,
             b.wind_x, b.wind_y, b.diffusion_rate, b.decay_factor,
             b.leak_injection, b.uploaded_at
),

-- Add wind features and derived spatial features
with_features as (
    select
        a.*,
        atan2(a.wind_y, a.wind_x)                                       as wind_angle,
        sqrt(a.wind_x * a.wind_x + a.wind_y * a.wind_y)                 as wind_magnitude,
        least(a.centroid_row, 100 - a.centroid_row,
              a.centroid_col, 100 - a.centroid_col)                      as distance_to_boundary,
        array_length(a.leaks_arr)                                        as n_leaks,

        -- Triangulation
        safe_divide(
            a.top1_row * coalesce(a.top1_reading, 0) +
            a.top2_row * coalesce(a.top2_reading, 0) +
            a.top3_row * coalesce(a.top3_reading, 0),
            nullif(coalesce(a.top1_reading,0) + coalesce(a.top2_reading,0) +
                   coalesce(a.top3_reading,0), 0)
        )                                                                as top3_centroid_row,
        safe_divide(
            a.top1_col * coalesce(a.top1_reading, 0) +
            a.top2_col * coalesce(a.top2_reading, 0) +
            a.top3_col * coalesce(a.top3_reading, 0),
            nullif(coalesce(a.top1_reading,0) + coalesce(a.top2_reading,0) +
                   coalesce(a.top3_reading,0), 0)
        )                                                                as top3_centroid_col,
        safe_divide(coalesce(a.top1_reading,0),
                    nullif(coalesce(a.top2_reading,0), 0))               as t1_t2_ratio,
        safe_divide(coalesce(a.top1_reading,0),
                    nullif(coalesce(a.top3_reading,0), 0))               as t1_t3_ratio,
        sqrt(pow(coalesce(a.top1_row,50) - coalesce(a.top2_row,50), 2) +
             pow(coalesce(a.top1_col,50) - coalesce(a.top2_col,50), 2)) as t1_t2_dist,
        sqrt(pow(coalesce(a.top1_row,50) - coalesce(a.top3_row,50), 2) +
             pow(coalesce(a.top1_col,50) - coalesce(a.top3_col,50), 2)) as t1_t3_dist,
        coalesce(a.top1_row,50) - coalesce(a.top2_row,50)               as t1_t2_vec_row,
        coalesce(a.top1_col,50) - coalesce(a.top2_col,50)               as t1_t2_vec_col

    from aggregated a
    where a.sensor_delta > 0
),

-- walls_blocking_top1 requires tick-level top1 position — computed separately
walls_proximity as (
    select
        wf.source, wf.seed, wf.layout_id, wf.config_hash, wf.tick,
        (
            select countif(
                pow(cast(w as int64) / 100 - wf.centroid_row, 2) +
                pow(mod(cast(w as int64), 100) - wf.centroid_col, 2) <= 100.0
            )
            from unnest(JSON_EXTRACT_ARRAY(TO_JSON_STRING(wl.walls_arr))) as w
        ) as walls_near_centroid,
        (
            select countif(
                pow(cast(w as int64) / 100
                    - (wf.top1_row + wf.centroid_row) / 2.0, 2) +
                pow(mod(cast(w as int64), 100)
                    - (wf.top1_col + wf.centroid_col) / 2.0, 2) <= 25.0
            )
            from unnest(JSON_EXTRACT_ARRAY(TO_JSON_STRING(wl.walls_arr))) as w
        ) as walls_blocking_top1
    from with_features wf
    join (
        select layout_id, config_hash, any_value(walls_arr) as walls_arr
        from base
        where walls_arr is not null
        group by layout_id, config_hash
    ) wl using (layout_id, config_hash)
),

-- Targets
with_targets as (
    select
        wf.*,
        wp.walls_near_centroid,
        wp.walls_blocking_top1,
        (select avg(cast(json_extract_scalar(lk, '$.row') as float64))
         from unnest(wf.leaks_arr) as lk)                               as target_centroid_row,
        (select avg(cast(json_extract_scalar(lk, '$.col') as float64))
         from unnest(wf.leaks_arr) as lk)                               as target_centroid_col,
        (select cast(json_extract_scalar(lk, '$.row') as float64)
         from unnest(wf.leaks_arr) as lk
         order by pow(cast(json_extract_scalar(lk,'$.row') as float64) - wf.centroid_row, 2) +
                  pow(cast(json_extract_scalar(lk,'$.col') as float64) - wf.centroid_col, 2)
         limit 1)                                                        as target_nearest_row,
        (select cast(json_extract_scalar(lk, '$.col') as float64)
         from unnest(wf.leaks_arr) as lk
         order by pow(cast(json_extract_scalar(lk,'$.row') as float64) - wf.centroid_row, 2) +
                  pow(cast(json_extract_scalar(lk,'$.col') as float64) - wf.centroid_col, 2)
         limit 1)                                                        as target_nearest_col
    from with_features wf
    left join walls_proximity wp
        using (source, seed, layout_id, config_hash, tick)
)

select
    source, seed, layout_id, config_hash, tick, uploaded_at,
    -- Sensor aggregates
    sensor_delta, sensor_mean, coalesce(reading_variance, 0) as reading_variance,
    coalesce(centroid_row, 50.0) as centroid_row,
    coalesce(centroid_col, 50.0) as centroid_col,
    coverage_ratio, sensor_count,
    wind_angle, wind_magnitude, wind_x, wind_y,
    coalesce(distance_to_boundary, 0) as distance_to_boundary,
    diffusion_rate, decay_factor, leak_injection,
    -- Top-3 sensors
    coalesce(top1_row, 50.0) as top1_row, coalesce(top1_col, 50.0) as top1_col,
    coalesce(top1_reading, 0.0) as top1_reading,
    coalesce(top2_row, 50.0) as top2_row, coalesce(top2_col, 50.0) as top2_col,
    coalesce(top2_reading, 0.0) as top2_reading,
    coalesce(top3_row, 50.0) as top3_row, coalesce(top3_col, 50.0) as top3_col,
    coalesce(top3_reading, 0.0) as top3_reading,
    -- Triangulation
    top3_centroid_row, top3_centroid_col,
    t1_t2_ratio, t1_t3_ratio,
    t1_t2_dist, t1_t3_dist,
    t1_t2_vec_row, t1_t2_vec_col,
    -- Wall features
    coalesce(n_walls, 0) as n_walls, coalesce(n_doors, 0) as n_doors,
    coalesce(wall_density, 0) as wall_density,
    coalesce(open_path_ratio, 1.0) as open_path_ratio,
    coalesce(wall_centroid_row, 50.0) as wall_centroid_row,
    coalesce(wall_centroid_col, 50.0) as wall_centroid_col,
    coalesce(wall_spread_row, 0) as wall_spread_row,
    coalesce(wall_spread_col, 0) as wall_spread_col,
    coalesce(walls_q1, 0) as walls_q1, coalesce(walls_q2, 0) as walls_q2,
    coalesce(walls_q3, 0) as walls_q3, coalesce(walls_q4, 0) as walls_q4,
    coalesce(walls_near_centroid, 0) as walls_near_centroid,
    coalesce(walls_blocking_top1, 0) as walls_blocking_top1,
    -- Derived spatial features
    coalesce(centroid_row, 50.0) - wind_y * 5                  as wind_corr_row,
    coalesce(centroid_col, 50.0) - wind_x * 5                  as wind_corr_col,
    coalesce(top1_row, 50.0) - coalesce(centroid_row, 50.0)    as disp_row,
    coalesce(top1_col, 50.0) - coalesce(centroid_col, 50.0)    as disp_col,
    coalesce(walls_q1, 0) + coalesce(walls_q3, 0)
        - coalesce(walls_q2, 0) - coalesce(walls_q4, 0)        as wall_asymmetry_col,
    coalesce(walls_q1, 0) + coalesce(walls_q2, 0)
        - coalesce(walls_q3, 0) - coalesce(walls_q4, 0)        as wall_asymmetry_row,

    -- Targets
    coalesce(target_centroid_row, 50.0) as target_centroid_row,
    coalesce(target_centroid_col, 50.0) as target_centroid_col,
    coalesce(target_nearest_row, 50.0)  as target_nearest_row,
    coalesce(target_nearest_col, 50.0)  as target_nearest_col,
    n_leaks                             as target_n_leaks

from with_targets
where target_centroid_row is not null
  and target_centroid_col is not null
  and sensor_delta > 0
