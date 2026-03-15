-- ml_export.sql
-- Final flat ML-ready table. One row = one training example.
-- No nulls in any feature or target column.

select
    source,
    seed,
    layout_id,
    config_hash,
    tick,
    -- Feature columns (model input)
    sensor_delta,
    sensor_mean,
    coalesce(reading_variance, 0)         as reading_variance,
    coalesce(centroid_row, 50.0)          as centroid_row,
    coalesce(centroid_col, 50.0)          as centroid_col,
    coalesce(coverage_ratio, 0)           as coverage_ratio,
    wind_angle,
    wind_magnitude,
    coalesce(distance_to_boundary, 0)     as distance_to_boundary,
    wind_x,
    wind_y,
    diffusion_rate,
    decay_factor,
    leak_injection,
    sensor_count,
    -- Target columns (model output)
    leak_row,
    leak_col,
    uploaded_at
from {{ ref('fct_training_examples') }}
where
    sensor_delta        is not null
    and wind_angle      is not null
    and wind_magnitude  is not null
    and diffusion_rate  is not null
    and decay_factor    is not null
    and leak_injection  is not null
