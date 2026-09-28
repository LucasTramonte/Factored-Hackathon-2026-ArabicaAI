# Data Contracts

Use for table schemas, types, keys and joins. Start at the data dictionary, then compare actual Bronze columns and the Silver `TableSpec` before coding. Bronze registry lives in `data_pipelines/bronze/config.py`; typed mappings live in `data_pipelines/silver/table_specs.py`; quality expectations live in `data_pipelines/quality/contracts.py`. Keep exact source names and explain any deliberate rename, such as `date` to `rate_date` for FX. A new rule needs a fixture and a numerator/denominator. Do not infer relationships from matching column names alone.
