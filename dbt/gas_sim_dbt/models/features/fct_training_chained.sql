-- fct_training_chained.sql
-- Expands multi-leak records into N training samples (one per chain step).
-- Single-leak records become chain_step=0 with null second output.
-- Used for the multi-leak chained model experiment only.

with base as (
    select
        source, seed, layout_id, config_hash, tick,
        wind_x, wind_y, diffusion_rate, decay_factor, leak_injection, uploaded_at,
        locked_dimensions, leaks_arr,
        sensor_row, sensor_col, sensor_reading, sensor_index
    from {{ ref('stg_simulation_ticks') }}
),

aggregated as (
    select
        source, seed, layout_id, config_hash, tick,
        wind_x, wind_y, diffusion_rate, decay_factor, leak_injection, uploaded_at,
        any_value(locked_dimensions) as locked_dimensions,
        any_value(leaks_arr)         as leaks_arr,

        max(sensor_reading) - min(sensor_reading)            as sensor_delta,
        avg(sensor_reading)                                  as sensor_mean,
        stddev_samp(sensor_reading)                          as reading_variance,
        safe_divide(sum(sensor_row * sensor_reading), nullif(sum(sensor_reading), 0)) as centroid_row,
        safe_divide(sum(sensor_col * sensor_reading), nullif(sum(sensor_reading), 0)) as centroid_col,
        safe_divide(countif(sensor_reading > 0.01), count(*))                         as coverage_ratio,
        count(*) as sensor_count

    from base
    group by source, seed, layout_id, config_hash, tick,
             wind_x, wind_y, diffusion_rate, decay_factor,
             leak_injection, uploaded_at
),

with_features as (
    select
        a.*,
        atan2(a.wind_y, a.wind_x)                        as wind_angle,
        sqrt(a.wind_x * a.wind_x + a.wind_y * a.wind_y) as wind_magnitude,
        least(a.centroid_row, 100 - a.centroid_row,
              a.centroid_col, 100 - a.centroid_col)       as distance_to_boundary,
        array_length(a.leaks_arr)                         as n_leaks
    from aggregated a
    where sensor_delta > 0
      and array_length(leaks_arr) >= 1
),

-- Chain step 0: no known leak, predict first two leaks
chain_step_0 as (
    select
        source, seed, layout_id, config_hash, tick,
        sensor_delta, sensor_mean, reading_variance,
        centroid_row, centroid_col, coverage_ratio,
        wind_angle, wind_magnitude, distance_to_boundary,
        wind_x, wind_y, diffusion_rate, decay_factor,
        leak_injection, sensor_count, uploaded_at,
        0.0 as known_leak_row,
        0.0 as known_leak_col,
        0   as chain_step,
        cast(json_extract_scalar(leaks_arr[offset(0)], '$.row') as float64) as leak1_row,
        cast(json_extract_scalar(leaks_arr[offset(0)], '$.col') as float64) as leak1_col,
        1.0 as confidence1,
        case when n_leaks >= 2
            then cast(json_extract_scalar(leaks_arr[offset(1)], '$.row') as float64)
            else 0.0 end as leak2_row,
        case when n_leaks >= 2
            then cast(json_extract_scalar(leaks_arr[offset(1)], '$.col') as float64)
            else 0.0 end as leak2_col,
        case when n_leaks >= 2 then 1.0 else 0.0 end as confidence2
    from with_features
),

-- Chain step 1: first leak known, predict second and third
chain_step_1 as (
    select
        source, seed, layout_id, config_hash, tick,
        sensor_delta, sensor_mean, reading_variance,
        centroid_row, centroid_col, coverage_ratio,
        wind_angle, wind_magnitude, distance_to_boundary,
        wind_x, wind_y, diffusion_rate, decay_factor,
        leak_injection, sensor_count, uploaded_at,
        cast(json_extract_scalar(leaks_arr[offset(0)], '$.row') as float64) as known_leak_row,
        cast(json_extract_scalar(leaks_arr[offset(0)], '$.col') as float64) as known_leak_col,
        1 as chain_step,
        cast(json_extract_scalar(leaks_arr[offset(1)], '$.row') as float64) as leak1_row,
        cast(json_extract_scalar(leaks_arr[offset(1)], '$.col') as float64) as leak1_col,
        1.0 as confidence1,
        case when n_leaks >= 3
            then cast(json_extract_scalar(leaks_arr[offset(2)], '$.row') as float64)
            else 0.0 end as leak2_row,
        case when n_leaks >= 3
            then cast(json_extract_scalar(leaks_arr[offset(2)], '$.col') as float64)
            else 0.0 end as leak2_col,
        case when n_leaks >= 3 then 1.0 else 0.0 end as confidence2
    from with_features
    where n_leaks >= 2
)

select * from chain_step_0
union all
select * from chain_step_1
