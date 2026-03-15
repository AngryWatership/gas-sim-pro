-- stg_simulation_ticks.sql
-- Unnests the JSON sensor array into one row per sensor per tick.
-- Filters out records with null required fields.

with raw as (
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
        json_extract_array(sensors)  as sensors_arr,
        json_extract_array(leaks)    as leaks_arr,
        json_extract_array(walls)    as walls_arr,
        json_extract_array(doors)    as doors_arr
    from {{ source('raw', 'simulation_ticks') }}
    where
        source is not null
        and layout_id is not null
        and tick is not null
        and sensors is not null
        and leaks is not null
),

unnested as (
    select
        r.source,
        r.seed,
        r.layout_id,
        r.config_hash,
        r.locked_dimensions,
        r.tick,
        r.wind_x,
        r.wind_y,
        r.diffusion_rate,
        r.decay_factor,
        r.leak_injection,
        r.uploaded_at,
        r.leaks_arr,
        r.walls_arr,
        r.doors_arr,
        cast(json_extract_scalar(s, '$.row')     as int64)   as sensor_row,
        cast(json_extract_scalar(s, '$.col')     as int64)   as sensor_col,
        cast(json_extract_scalar(s, '$.reading') as float64) as sensor_reading,
        row_number() over (
            partition by r.layout_id, r.tick
            order by json_extract_scalar(s, '$.row'), json_extract_scalar(s, '$.col')
        ) as sensor_index
    from raw r,
    unnest(r.sensors_arr) as s
)

select * from unnested
