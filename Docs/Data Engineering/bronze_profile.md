# Bronze profile -- inputs for Silver schema design

Generated 2026-09-27T13:34:53

Bronze is DESIGNED to be all-VARCHAR (raw ingest, no typing/cleaning yet), but a real run of
this script found a table with a BIGINT column already -- so `type` below is each column's
ACTUAL type on disk, not an assumption. Anything other than VARCHAR is flagged **⚠** and worth
a quick look: it may just mean that table happened to get typed correctly already (fine), or
it may mean an earlier/different ingestion path wrote it inconsistently with the rest of
Bronze (worth knowing before Silver builds on top of it either way).

`numeric %` / `date %`
below are the share of non-null, non-sentinel values that would survive
`TRY_CAST(... AS DOUBLE)` / `TRY_CAST(... AS DATE)` -- useful for spotting columns that are
*almost* clean (worth a Silver-layer decision on the exceptions) vs. columns that were never
meant to be numeric/date in the first place (ignore those two columns for that row).

`null-like %` catches non-empty text that MEANS missing but isn't NULL or blank --
case-insensitive matches against: '#n/a', '#na', '-', '--', '-inf', '-infinity', '?', 'inf', 'infinity', 'missing', 'n/a', 'na', 'nan', 'nil', 'none', 'null', 'undefined', 'unknown'.
This matters because DuckDB's TRY_CAST follows IEEE 754: `'NaN'` casts to a valid DOUBLE, and
`'Infinity'` casts to a valid DOUBLE *and* a valid DATE (`9999-12-31`) -- both are excluded
from `numeric %` / `date %` above so a column full of "NaN" placeholders doesn't misreport as
clean. A high `null-like %` on a column also needs its OWN Silver rule (coalesce to true
NULL), separate from whatever handles real blanks.

`sample values` shows every distinct value with its row count when there are few enough
(**all shown**), or up to 5 non-null examples otherwise (**sample**) -- check the **all
shown** columns against the data dictionary before trusting either one; this project has
found the dictionary wrong on exactly this kind of column three times already.

## `bronze.branches` -- 350 rows

| column | type | null/blank % | null-like % | distinct | numeric % | date % | sample values |
|---|---|---:|---:|---:|---:|---:|---|
| branch_id | VARCHAR | 0.0 | 0.0 | 350 | 0.0 | 0.0 | 'SUC-FQBLIDK9'; 'SUC-UBOAYTJG'; 'SUC-4AVH1MSP'; 'SUC-5R12FFLE'; 'SUC-57LRN6RH' (sample) |
| branch_code | VARCHAR | 0.0 | 0.0 | 350 | 0.0 | 0.0 | 'S0023'; 'S0025'; 'S0032'; 'S0039'; 'S0045' (sample) |
| branch_name | VARCHAR | 0.0 | 0.0 | 175 | 0.0 | 0.0 | 'Banco LATAM Querétaro 42'; 'Banco LATAM Guadalajara 66'; 'Banco LATAM Ciudad de México Oeste'; 'Banco LATAM Puebla 135'; 'Banco LATAM Querétaro 139' (sample) |
| branch_type | VARCHAR | 0.0 | 0.0 | 4 | 0.0 | 0.0 | 'Express' (130); 'Corporate' (129); 'Premium' (48); 'Main' (43) (all shown) |
| address | VARCHAR | 0.0 | 0.0 | 350 | 0.0 | 0.0 | 'Circuito Revolución 553, Centro'; 'Andador Zaragoza 7, Centro'; 'Calzada Madero 563, Centro'; 'Privada Allende 257, Centro'; 'Paseo La Paz 887, Centro' (sample) |
| city | VARCHAR | 0.0 | 0.0 | 16 | 0.0 | 0.0 | 'Puebla' (33); 'Guadalajara' (30); 'Tijuana' (29); 'Ciudad de México' (29); 'Monterrey' (28); 'Querétaro' (26); 'Barranquilla' (24); 'Cartagena' (23); 'Bogotá' (22); 'Cali' (21); 'Córdoba' (20); 'Mendoza' (16); ... (+4 more) (all shown) |
| state | VARCHAR | 0.0 | 0.0 | 16 | 0.0 | 0.0 | 'Puebla' (33); 'Jalisco' (30); 'Ciudad de México' (29); 'Baja California' (29); 'Nuevo León' (28); 'Querétaro' (26); 'Atlántico' (24); 'Bolívar' (23); 'Cundinamarca' (22); 'Valle del Cauca' (21); 'Córdoba' (20); 'Mendoza' (16); ... (+4 more) (all shown) |
| country | VARCHAR | 0.0 | 0.0 | 3 | 0.0 | 0.0 | 'México' (175); 'Colombia' (105); 'Argentina' (70) (all shown) |
| postal_code | VARCHAR | 0.0 | 0.0 | 105 | 80.0 | 0.0 | '130004'; '111392'; '112250'; '110230'; '111474' (sample) |
| geographic_zone | VARCHAR | 0.0 | 0.0 | 1 | 0.0 | 0.0 | 'Urbana' (350) (all shown) |
| phone | VARCHAR | 0.0 | 0.0 | 350 | 0.0 | 0.0 | '+54 28 9348 9085'; '+54 54 1344 4770'; '+54 21 8705 1317'; '+54 75 5377 1042'; '+54 24 4886 7248' (sample) |
| email | VARCHAR | 0.0 | 0.0 | 350 | 0.0 | 0.0 | 'sucursal0006@bancolatam.com'; 'sucursal0014@bancolatam.com'; 'sucursal0033@bancolatam.com'; 'sucursal0041@bancolatam.com'; 'sucursal0061@bancolatam.com' (sample) |
| opening_time | VARCHAR | 0.0 | 0.0 | 4 | 0.0 | 0.0 | '09:30:00' (104); '09:00:00' (89); '08:00:00' (81); '08:30:00' (76) (all shown) |
| closing_time | VARCHAR | 0.0 | 0.0 | 5 | 0.0 | 0.0 | '17:00:00' (91); '19:00:00' (76); '20:00:00' (68); '18:00:00' (58); '17:30:00' (57) (all shown) |
| has_atms | VARCHAR | 0.0 | 0.0 | 1 | 0.0 | 0.0 | 'True' (350) (all shown) |
| atm_count | VARCHAR | 0.0 | 0.0 | 7 | 100.0 | 0.0 | '8' (54); '4' (53); '3' (52); '7' (52); '6' (49); '5' (46); '2' (44) (all shown) |
| has_teller_windows | VARCHAR | 0.0 | 0.0 | 1 | 0.0 | 0.0 | 'True' (350) (all shown) |
| teller_window_count | VARCHAR | 0.0 | 0.0 | 10 | 100.0 | 0.0 | '12' (48); '10' (39); '7' (38); '6' (38); '8' (36); '9' (34); '11' (32); '3' (30); '5' (28); '4' (27) (all shown) |
| latitude | VARCHAR | 0.0 | 0.0 | 350 | 100.0 | 0.0 | '0.0610092'; '-0.0769316'; '19.397173'; '20.6969636'; '0.0201677' (sample) |
| longitude | VARCHAR | 0.0 | 0.0 | 350 | 100.0 | 0.0 | '0.0738601'; '0.066919'; '0.0810612'; '-0.0745306'; '-103.354399' (sample) |
| branch_opening_date | VARCHAR | 0.0 | 0.0 | 346 | 0.0 | 100.0 | '1992-12-20'; '1995-08-04'; '2014-02-21'; '1995-11-02'; '2001-09-28' (sample) |
| branch_status | VARCHAR | 0.0 | 0.0 | 2 | 0.0 | 0.0 | 'Active' (336); 'Temporarily Closed' (14) (all shown) |

## `bronze.call_center_interactions` -- 686,296 rows
⚠ non-VARCHAR column(s): year

| column | type | null/blank % | null-like % | distinct | numeric % | date % | sample values |
|---|---|---:|---:|---:|---:|---:|---|
| interaction_id | VARCHAR | 0.0 | 0.0 | 686,296 | 0.0 | 0.0 | 'INT-5X2T33QTKLKB4CNR'; 'INT-PWRSTROLSIJDX4TW'; 'INT-5N7A2YVWMFHZXOSB'; 'INT-2T104M257G2MXWN0'; 'INT-WVGVXJ4YJLGQVFNJ' (sample) |
| interaction_date | VARCHAR | 0.0 | 0.0 | 683,625 | 0.0 | 100.0 | '2023-06-18 07:49:59'; '2023-06-18 00:14:15'; '2023-06-18 16:05:44'; '2023-06-18 19:48:14'; '2023-06-18 17:33:15' (sample) |
| process_date | VARCHAR | 0.0 | 0.0 | 1,097 | 0.0 | 100.0 | '2025-07-10'; '2025-08-22'; '2025-08-29'; '2025-09-23'; '2025-10-07' (sample) |
| customer_id | VARCHAR | 0.0 | 0.0 | 148,443 | 0.0 | 0.0 | 'CLI-56M90H64659G'; 'CLI-0GTKWS3ZJV25'; 'CLI-CXROP8ZZ7TYD'; 'CLI-9BBIZP0AF3KS'; 'CLI-0CKHPTKZ7U74' (sample) |
| agent_id | VARCHAR | 0.0 | 0.0 | 1,090 | 0.0 | 0.0 | 'AGT-MNK9T02WF4'; 'AGT-ZCZWPFNLF1'; 'AGT-P6ZSI9FXVT'; 'AGT-YUKU1CJ7LZ'; 'AGT-3LD55SM258' (sample) |
| interaction_type | VARCHAR | 0.0 | 0.0 | 5 | 0.0 | 0.0 | 'Inbound Call' (480,678); 'Outbound Call' (102,572); 'Chat' (68,691); 'Email' (27,543); 'Video' (6,812) (all shown) |
| channel | VARCHAR | 0.0 | 0.0 | 6 | 0.0 | 0.0 | 'Phone' (583,250); 'Email' (27,543); 'App' (26,364); 'WhatsApp' (22,888); 'Web Chat' (22,856); 'Web' (3,395) (all shown) |
| contact_reason | VARCHAR | 0.0 | 0.0 | 6 | 0.0 | 0.0 | 'Transaccional' (240,056); 'Producto' (150,863); 'Queja' (117,021); 'Técnico' (102,899); 'Comercial' (54,879); 'Retención' (20,578) (all shown) |
| reason_category | VARCHAR | 0.0 | 0.0 | 6 | 0.0 | 0.0 | 'Transaccional' (240,056); 'Producto' (150,863); 'Queja' (117,021); 'Técnico' (102,899); 'Comercial' (54,879); 'Retención' (20,578) (all shown) |
| duration_seconds | VARCHAR | 14.02 | 0.0 | 1,049 | 85.98 | 0.0 | '190.0'; '142.0'; '266.0'; '162.0'; '357.0' (sample) |
| wait_time_seconds | VARCHAR | 29.96 | 0.0 | 370 | 70.04 | 0.0 | '162.0'; '148.0'; '142.0'; '123.0'; '131.0' (sample) |
| was_resolved | VARCHAR | 0.0 | 0.0 | 2 | 0.0 | 0.0 | 'True' (526,030); 'False' (160,266) (all shown) |
| requires_followup | VARCHAR | 0.0 | 0.0 | 2 | 0.0 | 0.0 | 'False' (447,242); 'True' (239,054) (all shown) |
| detected_sentiment | VARCHAR | 0.0 | 0.0 | 5 | 0.0 | 0.0 | 'Neutral' (459,712); 'Negativo' (94,322); 'Positivo' (75,562); 'Muy Negativo' (37,727); 'Muy Positivo' (18,973) (all shown) |
| sentiment_score | VARCHAR | 0.0 | 0.0 | 202 | 100.0 | 0.0 | '-0.18'; '-0.58'; '-0.16'; '-0.07'; '0.19' (sample) |
| customer_detected_accent | VARCHAR | 29.83 | 0.0 | 3 | 0.0 | 0.0 | 'mexican' (240,674); None (204,750); 'colombian' (144,712); 'argentine' (96,160) (all shown) |
| agent_used_accent | VARCHAR | 29.83 | 0.0 | 3 | 0.0 | 0.0 | 'mexican' (241,931); None (204,750); 'colombian' (144,386); 'argentine' (95,229) (all shown) |
| was_escalated | VARCHAR | 0.0 | 0.0 | 2 | 0.0 | 0.0 | 'False' (617,910); 'True' (68,386) (all shown) |
| mentioned_products | VARCHAR | 60.03 | 0.0 | 274,341 | 0.0 | 0.0 | 'PRD-267ZRWMIADWO,PRD-7WEQR7NOSG3I,PRD-93X8TPV9IYVZ'; 'PRD-4UO8RCE7ZMQI,PRD-S2VUIUQ083CO'; 'PRD-G8BLTK6BTQLF,PRD-9LAFQIT4KEXV'; 'PRD-3Z70IIY805BA,PRD-B1BG4IFZLSU5'; 'PRD-30BCNIFR1GCM' (sample) |
| has_transcript | VARCHAR | 0.0 | 0.0 | 2 | 0.0 | 0.0 | 'False' (514,975); 'True' (171,321) (all shown) |
| has_recording | VARCHAR | 0.0 | 0.0 | 2 | 0.0 | 0.0 | 'True' (590,062); 'False' (96,234) (all shown) |
| day | VARCHAR | 0.0 | 0.0 | 31 | 100.0 | 0.0 | '27'; '19'; '29'; '11'; '13' (sample) |
| month | VARCHAR | 0.0 | 0.0 | 12 | 100.0 | 0.0 | '03' (58,910); '07' (58,662); '08' (58,532); '12' (57,935); '04' (57,837); '10' (57,820); '05' (57,459); '01' (57,183); '09' (56,599); '06' (56,586); '11' (55,295); '02' (53,478) (all shown) |
| year | BIGINT **⚠** | 0.0 | 0.0 | 4 | 100.0 | 0.0 | 2025 (229,056); 2024 (228,210); 2023 (123,545); 2026 (105,485) (all shown) |

## `bronze.call_transcripts` -- 171,321 rows
⚠ non-VARCHAR column(s): year

| column | type | null/blank % | null-like % | distinct | numeric % | date % | sample values |
|---|---|---:|---:|---:|---:|---:|---|
| transcript_id | VARCHAR | 0.0 | 0.0 | 171,321 | 0.0 | 0.0 | 'TRS-Q4VADN54M3XQUW1C0NQF'; 'TRS-RON5FG7R88QOZJ0T14M7'; 'TRS-FREWYZ8YJL88FVKAS3NR'; 'TRS-AHDA5ZPRTFCJ2Z8BX11S'; 'TRS-HF26ZGKA8UMMXIBM9OA6' (sample) |
| interaction_id | VARCHAR | 0.0 | 0.0 | 171,321 | 0.0 | 0.0 | 'INT-PDC6I1091FD6W05H'; 'INT-OXQNJCAPI5NLGH83'; 'INT-3FU1B7AYCKFT9L5P'; 'INT-JM00S91EBW194B32'; 'INT-G9P9BFNCJIQL8XYM' (sample) |
| process_date | VARCHAR | 0.0 | 0.0 | 1,097 | 0.0 | 100.0 | '2023-06-21'; '2023-07-05'; '2023-07-21'; '2023-08-12'; '2023-08-24' (sample) |
| customer_id | VARCHAR | 0.0 | 0.0 | 101,951 | 0.0 | 0.0 | 'CLI-4XYYW02CZWS6'; 'CLI-Y9NXOHRVQ1WX'; 'CLI-KCMIVM6L8GLH'; 'CLI-8IX8B2YKHRED'; 'CLI-C8HS6JR0M7BI' (sample) |
| agent_id | VARCHAR | 0.0 | 0.0 | 1,090 | 0.0 | 0.0 | 'AGT-5RF05BZME0'; 'AGT-LFX460UJ80'; 'AGT-9FZV5Z7FAG'; 'AGT-2NVH86ET7M'; 'AGT-NIV1UCW44H' (sample) |
| full_text | VARCHAR | 0.0 | 0.0 | 546 | 0.0 | 0.0 | 'Cliente: Buenas tardes, necesito consultar el saldo de mi tarjeta de crédito.\n\nAgente: Buenas tardes, claro que sí. Déjeme revisar esa información. Su saldo actual es {monto} {moneda} y su límite disponible es de {limite} {moneda}.\n\nCliente: Perfecto, eso es lo que necesitaba.\n\nAgente: Claro, estoy para servirle.\n\nCliente: Perfecto, eso es lo que necesitaba.\n\nAgente: Perfecto, ¿necesita algo más?'; 'Cliente: Hola, buenos días. Quisiera saber cuál es mi saldo actual en mi cuenta de ahorros.\n\nAgente: Buenos días, con gusto le ayudo. Permítame un momento para verificar su saldo. Su saldo actual es de {monto} {moneda}.\n\nCliente: Perfecto, eso es lo que necesitaba.\n\nAgente: No hay problema, que tenga buen día.\n\nCliente: Entiendo, muchas gracias.\n\nAgente: Claro, estoy para servirle.'; 'Cliente: Hola, buenos días. Quisiera saber cuál es mi saldo actual en mi cuenta de ahorros.\n\nAgente: Buenos días, con gusto le ayudo. Permítame un momento para verificar su saldo. Su saldo actual es de {monto} {moneda}.\n\nCliente: ¿Y eso cuánto tiempo tarda?\n\nAgente: Claro, estoy para servirle.'; 'Cliente: Hola, buenos días. Quisiera saber cuál es mi saldo actual en mi cuenta de ahorros.\n\nAgente: Buenos días, con gusto le ayudo. Permítame un momento para verificar su saldo. Su saldo actual es de {monto} {moneda}.\n\nCliente: ¿Y eso cuánto tiempo tarda?\n\nAgente: No hay problema, que tenga buen día.'; 'Cliente: Buenas tardes, necesito consultar el saldo de mi tarjeta de crédito.\n\nAgente: Buenas tardes, claro que sí. Déjeme revisar esa información. Su saldo actual es {monto} {moneda} y su límite disponible es de {limite} {moneda}.\n\nCliente: Muy bien, ¿hay algo más que deba saber?\n\nAgente: Claro, estoy para servirle.\n\nCliente: ¿Y eso cuánto tiempo tarda?\n\nAgente: Con gusto. ¿Hay algo más en lo que pueda ayudarle?' (sample) |
| customer_text | VARCHAR | 0.0 | 0.0 | 42 | 0.0 | 0.0 | 'Hola, buenos días. Quisiera saber cuál es mi saldo actual en mi cuenta de ahorros. Muy bien, ¿hay algo más que deba saber? ¿Y eso cuánto tiempo tarda?'; 'Buenas tardes, necesito consultar el saldo de mi tarjeta de crédito. ¿Y eso cuánto tiempo tarda? ¿Y eso cuánto tiempo tarda?'; 'Hola, buenos días. Quisiera saber cuál es mi saldo actual en mi cuenta de ahorros. ¿Y eso cuánto tiempo tarda? Muy bien, ¿hay algo más que deba saber?'; 'Hola, buenos días. Quisiera saber cuál es mi saldo actual en mi cuenta de ahorros. ¿Y eso cuánto tiempo tarda? Perfecto, eso es lo que necesitaba.'; 'Hola, buenos días. Quisiera saber cuál es mi saldo actual en mi cuenta de ahorros. Perfecto, eso es lo que necesitaba.' (sample) |
| agent_text | VARCHAR | 0.0 | 0.0 | 42 | 0.0 | 0.0 | 'Buenas tardes, claro que sí. Déjeme revisar esa información. Su saldo actual es {monto} {moneda} y su límite disponible es de {limite} {moneda}. Perfecto, ¿necesita algo más? No hay problema, que tenga buen día.'; 'Buenas tardes, claro que sí. Déjeme revisar esa información. Su saldo actual es {monto} {moneda} y su límite disponible es de {limite} {moneda}. Con gusto. ¿Hay algo más en lo que pueda ayudarle? Perfecto, ¿necesita algo más?'; 'Buenas tardes, claro que sí. Déjeme revisar esa información. Su saldo actual es {monto} {moneda} y su límite disponible es de {limite} {moneda}. Con gusto. ¿Hay algo más en lo que pueda ayudarle?'; 'Buenos días, con gusto le ayudo. Permítame un momento para verificar su saldo. Su saldo actual es de {monto} {moneda}. No hay problema, que tenga buen día. Con gusto. ¿Hay algo más en lo que pueda ayudarle?'; 'Buenos días, con gusto le ayudo. Permítame un momento para verificar su saldo. Su saldo actual es de {monto} {moneda}. Con gusto. ¿Hay algo más en lo que pueda ayudarle? Claro, estoy para servirle.' (sample) |
| detected_language | VARCHAR | 0.0 | 0.0 | 1 | 0.0 | 0.0 | 'es' (171,321) (all shown) |
| detected_accent | VARCHAR | 36.82 | 0.0 | 3 | 0.0 | 0.0 | None (63,083); 'mexican' (54,152); 'colombian' (32,284); 'argentine' (21,802) (all shown) |
| accent_confidence | VARCHAR | 10.01 | 0.0 | 25 | 89.99 | 0.0 | '0.99'; '0.98'; '0.77'; '0.76'; '0.85' (sample) |
| detected_keywords | VARCHAR | 5.13 | 0.0 | 12 | 0.0 | 0.0 | 'banco, servicio, cuenta' (18,173); 'cuenta, servicio, banco' (18,116); 'cuenta, banco, servicio' (18,113); 'servicio, cuenta, banco' (18,016); 'servicio, banco, cuenta' (18,016); 'banco, cuenta, servicio' (17,910); 'cuenta, banco' (9,082); 'cuenta, servicio' (9,053); 'banco, servicio' (9,052); 'servicio, cuenta' (9,032); 'servicio, banco' (9,002); 'banco, cuenta' (8,959); ... (+1 more) (all shown) |
| mentioned_entities | VARCHAR | 10.02 | 0.0 | 54 | 0.0 | 0.0 | '{"account_numbers": 0, "dates": 1, "amounts": 0, "products": "Cuenta Ahorro"}'; '{"account_numbers": 2, "dates": 0, "amounts": 2, "products": null}'; '{"account_numbers": 2, "dates": 0, "amounts": 0, "products": "Cuenta Ahorro"}'; '{"account_numbers": 2, "dates": 0, "amounts": 0, "products": "Tarjeta Crédito"}'; '{"account_numbers": 2, "dates": 0, "amounts": 1, "products": null}' (sample) |
| detected_intents | VARCHAR | 4.94 | 0.0 | 1 | 0.0 | 0.0 | 'consulta_general' (162,864); None (8,457) (all shown) |
| main_topics | VARCHAR | 0.0 | 0.0 | 6 | 0.0 | 0.0 | 'Transaccional' (59,786); 'Producto' (37,658); 'Queja' (29,198); 'Técnico' (25,691); 'Comercial' (13,808); 'Retención' (5,180) (all shown) |
| transcription_model | VARCHAR | 0.0 | 0.0 | 4 | 0.0 | 0.0 | 'AWS Transcribe' (43,117); 'Whisper v3' (42,803); 'Google STT' (42,740); 'Azure Speech' (42,661) (all shown) |
| audio_quality | VARCHAR | 5.04 | 0.0 | 3 | 0.0 | 0.0 | 'High' (114,371); 'Medium' (40,350); None (8,638); 'Low' (7,962) (all shown) |
| duration_seconds | VARCHAR | 14.03 | 0.0 | 973 | 85.97 | 0.0 | '419.0'; '604.0'; '164.0'; '364.0'; '242.0' (sample) |
| day | VARCHAR | 0.0 | 0.0 | 31 | 100.0 | 0.0 | '05'; '10'; '19'; '27'; '29' (sample) |
| month | VARCHAR | 0.0 | 0.0 | 12 | 100.0 | 0.0 | '07' (14,828); '03' (14,824); '12' (14,564); '08' (14,564); '04' (14,428); '10' (14,382); '01' (14,287); '05' (14,255); '06' (14,235); '09' (14,039); '11' (13,653); '02' (13,262) (all shown) |
| year | BIGINT **⚠** | 0.0 | 0.0 | 4 | 100.0 | 0.0 | 2024 (56,982); 2025 (56,974); 2023 (30,813); 2026 (26,552) (all shown) |

## `bronze.campaign_sends` -- 1,746,801 rows
⚠ non-VARCHAR column(s): year

| column | type | null/blank % | null-like % | distinct | numeric % | date % | sample values |
|---|---|---:|---:|---:|---:|---:|---|
| send_id | VARCHAR | 0.0 | 0.0 | 1,746,801 | 0.0 | 0.0 | 'SND-7ELWW0N235N7NP8PCPVD'; 'SND-NUDJ9DSKD01MT0IX3BKK'; 'SND-5GYG5Y05Q9T361VNVIG9'; 'SND-5QNERH6B37FT3QRB9D1H'; 'SND-195A1Y75VMYJS2V8C1Q6' (sample) |
| send_date | VARCHAR | 0.0 | 0.0 | 1,729,711 | 0.0 | 100.0 | '2024-06-10 16:24:02'; '2024-06-11 01:42:04'; '2024-06-10 19:02:35'; '2024-06-10 12:19:41'; '2024-06-10 08:05:43' (sample) |
| process_date | VARCHAR | 0.0 | 0.0 | 1,083 | 0.0 | 100.0 | '2024-11-22'; '2024-11-29'; '2024-12-15'; '2024-12-20'; '2024-12-26' (sample) |
| campaign_id | VARCHAR | 0.0 | 0.0 | 175 | 0.0 | 0.0 | 'CMP-3RQ0RM77AJRO'; 'CMP-N3I2U4V7H3KU'; 'CMP-M1NN6040HCIT'; 'CMP-PL7U5PYE1AT6'; 'CMP-NID1J8SSDLQR' (sample) |
| customer_id | VARCHAR | 0.0 | 0.0 | 150,000 | 0.0 | 0.0 | 'CLI-TYS4O1OZIDNY'; 'CLI-1GX2E761V28S'; 'CLI-RCIHGE8EBA83'; 'CLI-96FZW0X5R7K5'; 'CLI-3HKIDNZ0YZWL' (sample) |
| send_channel | VARCHAR | 0.0 | 0.0 | 5 | 0.0 | 0.0 | 'Email' (620,195); 'SMS' (432,283); 'WhatsApp' (349,144); 'Push' (290,650); 'Voice' (54,529) (all shown) |
| template_used | VARCHAR | 10.03 | 0.0 | 875 | 0.0 | 0.0 | 'template_CMP-M1NN6040HCIT_4'; 'template_CMP-PEXKJNP13GVV_3'; 'template_CMP-UNAIIQA1WYH4_5'; 'template_CMP-UNAIIQA1WYH4_3'; 'template_CMP-C4Z5FPK4YO51_5' (sample) |
| subject | VARCHAR | 68.03 | 0.0 | 8 | 0.0 | 0.0 | None (1,188,342); '¡Oferta especial en Tarjeta Crédito!' (191,344); '¡Oferta especial en Préstamo Personal!' (95,544); '¡Oferta especial en Cuenta Corriente!' (79,322); '¡Oferta especial en Cuenta Ahorro!' (66,310); '¡Oferta especial en Inversión!' (38,402); '¡Oferta especial en nan!' (38,142); '¡Oferta especial en Seguro!' (25,469); '¡Oferta especial en Préstamo Hipotecario!' (23,926) (all shown) |
| send_status | VARCHAR | 0.0 | 0.0 | 4 | 0.0 | 0.0 | 'Sent' (1,642,044); 'Failed' (52,306); 'Bounced' (34,900); 'Blocked' (17,551) (all shown) |
| was_delivered | VARCHAR | 0.0 | 0.0 | 2 | 0.0 | 0.0 | 'True' (1,642,044); 'False' (104,757) (all shown) |
| was_opened | VARCHAR | 27.72 | 0.0 | 2 | 0.0 | 0.0 | 'False' (775,263); 'True' (487,309); None (484,229) (all shown) |
| open_date | VARCHAR | 72.1 | 0.0 | 485,996 | 0.0 | 27.9 | '2024-06-13 22:07:42'; '2024-06-12 04:13:46'; '2024-06-15 21:23:09'; '2024-06-12 08:08:42'; '2024-06-13 18:26:33' (sample) |
| was_clicked | VARCHAR | 0.0 | 0.0 | 2 | 0.0 | 0.0 | 'False' (1,649,008); 'True' (97,793) (all shown) |
| click_date | VARCHAR | 94.4 | 0.0 | 97,749 | 0.0 | 5.6 | '2024-10-28 14:25:44'; '2024-11-02 01:25:28'; '2024-10-28 10:18:50'; '2024-10-28 19:43:02'; '2024-10-30 01:21:22' (sample) |
| click_count | VARCHAR | 94.4 | 0.0 | 5 | 5.6 | 0.0 | None (1,649,008); '4.0' (19,649); '1.0' (19,593); '3.0' (19,564); '5.0' (19,498); '2.0' (19,489) (all shown) |
| had_conversion | VARCHAR | 0.0 | 0.0 | 2 | 0.0 | 0.0 | 'False' (1,737,002); 'True' (9,799) (all shown) |
| conversion_date | VARCHAR | 99.44 | 0.0 | 9,798 | 0.0 | 0.56 | '2025-01-09 00:27:40'; '2025-01-10 09:08:40'; '2025-01-11 09:01:12'; '2025-01-12 02:03:29'; '2025-01-13 15:38:30' (sample) |
| conversion_value | VARCHAR | 99.44 | 0.0 | 9,709 | 0.56 | 0.0 | '4389.38'; '3918.74'; '2273.66'; '3122.45'; '3392.25' (sample) |
| open_device | VARCHAR | 74.9 | 0.0 | 3 | 0.0 | 0.0 | None (1,308,424); 'Desktop' (146,494); 'Tablet' (146,450); 'Mobile' (145,433) (all shown) |
| open_country | VARCHAR | 74.9 | 0.0 | 3 | 0.0 | 0.0 | None (1,308,278); 'México' (219,090); 'Colombia' (132,441); 'Argentina' (86,992) (all shown) |
| failure_reason | VARCHAR | 94.3 | 0.0 | 3 | 0.0 | 0.0 | None (1,647,204); 'SMTP error' (49,706); 'Invalid email address' (33,209); 'User blocked sender' (16,682) (all shown) |
| send_cost | VARCHAR | 15.0 | 0.0 | 2,901 | 85.0 | 0.0 | '0.0011'; '0.0089'; '0.0021'; '0.0098'; '0.005' (sample) |
| day | VARCHAR | 0.0 | 0.0 | 31 | 100.0 | 0.0 | '26'; '07'; '12'; '22'; '31' (sample) |
| month | VARCHAR | 0.0 | 0.0 | 12 | 100.0 | 0.0 | '01' (151,972); '12' (150,716); '07' (150,532); '08' (150,473); '10' (150,438); '05' (150,060); '04' (148,649); '03' (147,082); '11' (145,386); '09' (141,836); '02' (136,930); '06' (122,727) (all shown) |
| year | BIGINT **⚠** | 0.0 | 0.0 | 4 | 100.0 | 0.0 | 2024 (591,104); 2025 (588,009); 2023 (295,364); 2026 (272,324) (all shown) |

## `bronze.complaints` -- 67,095 rows
⚠ non-VARCHAR column(s): year

| column | type | null/blank % | null-like % | distinct | numeric % | date % | sample values |
|---|---|---:|---:|---:|---:|---:|---|
| complaint_id | VARCHAR | 0.0 | 0.0 | 67,095 | 0.0 | 0.0 | 'CMP-P7HVN55QJQFLDZ4HRU55'; 'CMP-JSJ0B0XVTB2VY3H2RR4H'; 'CMP-72Q2B1HXJ2IU22VEXKK1'; 'CMP-G990SWO5FCLNF9U7DH8K'; 'CMP-FW1455BPCXWU9MJ4AJI6' (sample) |
| creation_date | VARCHAR | 0.0 | 0.0 | 67,074 | 0.0 | 100.0 | '2023-06-18 03:59:47'; '2023-06-20 00:38:45'; '2023-06-20 00:23:10'; '2023-06-19 14:31:50'; '2023-06-19 08:22:32' (sample) |
| process_date | VARCHAR | 0.0 | 0.0 | 1,097 | 0.0 | 100.0 | '2023-06-30'; '2023-07-30'; '2023-07-31'; '2023-08-10'; '2023-09-07' (sample) |
| customer_id | VARCHAR | 0.0 | 0.0 | 54,145 | 0.0 | 0.0 | 'CLI-VDYHS00980KO'; 'CLI-TWFAK26V2U9E'; 'CLI-S3QZ16Q4WDPK'; 'CLI-U5FZ1LK11I0M'; 'CLI-C40PG8KZV2EJ' (sample) |
| case_type | VARCHAR | 0.0 | 0.0 | 4 | 0.0 | 0.0 | 'Complaint' (40,452); 'Claim' (16,598); 'Request' (6,761); 'Suggestion' (3,284) (all shown) |
| category | VARCHAR | 0.0 | 0.0 | 5 | 0.0 | 0.0 | 'Transactions' (13,580); 'Fees' (13,553); 'Technical' (13,407); 'Branch' (13,361); 'Service' (13,194) (all shown) |
| subcategory | VARCHAR | 9.98 | 0.0 | 5 | 0.0 | 0.0 | 'Cargo no reconocido' (12,297); 'Cobro indebido' (12,194); 'Problema con app' (12,128); 'Atención en sucursal' (11,892); 'Calidad de servicio' (11,886); None (6,698) (all shown) |
| reception_channel | VARCHAR | 0.0 | 0.0 | 6 | 0.0 | 0.0 | 'Call Center' (33,761); 'Email' (13,323); 'Web' (9,884); 'App' (6,727); 'Branch' (2,683); 'Regulator' (717) (all shown) |
| affected_product_id | VARCHAR | 33.57 | 0.0 | 42,184 | 0.0 | 0.0 | 'PRD-YFVSIJZP5NNQ'; 'PRD-6403NN659EQA'; 'PRD-EOSYFM5CVNC6'; 'PRD-D8EYL4WXBXHC'; 'PRD-12X18ERSKUHY' (sample) |
| related_branch_id | VARCHAR | 71.42 | 0.0 | 350 | 0.0 | 0.0 | 'SUC-UV1CR4D5'; 'SUC-F16NSV5F'; 'SUC-P3KNB4PY'; 'SUC-JRR5Z8WK'; 'SUC-OZH64PX1' (sample) |
| origin_interaction_id | VARCHAR | 100.0 | 0.0 | 0 | 0.0 | 0.0 | None (67,095) (all shown) |
| description | VARCHAR | 0.0 | 0.0 | 5 | 0.0 | 0.0 | 'Queja relacionada con transactions' (13,580); 'Queja relacionada con fees' (13,553); 'Queja relacionada con technical' (13,407); 'Queja relacionada con branch' (13,361); 'Queja relacionada con service' (13,194) (all shown) |
| claimed_amount | VARCHAR | 67.58 | 0.0 | 21,303 | 32.42 | 0.0 | '725.2'; '3307.13'; '2931.43'; '1121.39'; '3757.66' (sample) |
| currency | VARCHAR | 67.54 | 0.0 | 4 | 0.0 | 0.0 | None (45,319); 'MXN' (5,487); 'COP' (5,456); 'USD' (5,431); 'ARS' (5,402) (all shown) |
| priority | VARCHAR | 0.0 | 0.0 | 4 | 0.0 | 0.0 | 'Medium' (33,439); 'Low' (20,411); 'High' (9,890); 'Critical' (3,355) (all shown) |
| status | VARCHAR | 0.0 | 0.0 | 6 | 0.0 | 0.0 | 'In Process' (26,823); 'Open' (20,125); 'Resolved' (13,512); 'Escalated' (3,321); 'Closed' (2,609); 'Rejected' (705) (all shown) |
| assigned_agent_id | VARCHAR | 34.45 | 0.0 | 1,200 | 0.0 | 0.0 | 'AGT-DHXTM6VCSZ'; 'AGT-592VGF7W61'; 'AGT-VBPI4ZZ5XX'; 'AGT-1PCJWOWJBX'; 'AGT-U2B4DX2JUH' (sample) |
| assignment_date | VARCHAR | 34.47 | 0.0 | 43,955 | 0.0 | 65.53 | '2023-06-19 00:00:37'; '2023-06-18 19:15:52'; '2023-06-19 07:57:09'; '2023-06-20 21:09:19'; '2023-06-20 18:53:34' (sample) |
| first_response_date | VARCHAR | 39.11 | 0.0 | 40,847 | 0.0 | 60.89 | '2023-06-18 09:26:12'; '2023-06-19 23:25:53'; '2023-06-21 12:01:26'; '2023-06-20 13:12:54'; '2023-06-20 22:08:53' (sample) |
| resolution_date | VARCHAR | 77.12 | 0.0 | 15,348 | 0.0 | 22.88 | '2023-06-22 14:52:07'; '2023-06-20 07:10:42'; '2023-06-21 12:29:53'; '2023-07-16 23:18:54'; '2023-07-16 02:39:51' (sample) |
| closing_date | VARCHAR | 96.3 | 0.0 | 2,480 | 0.0 | 3.7 | '2023-08-25 20:57:25'; '2023-08-23 10:00:21'; '2023-08-27 14:06:43'; '2023-09-05 17:43:04'; '2024-06-05 09:37:12' (sample) |
| sla_breached | VARCHAR | 0.0 | 0.0 | 2 | 0.0 | 0.0 | 'False' (53,600); 'True' (13,495) (all shown) |
| resolution_days | VARCHAR | 77.1 | 0.0 | 30 | 22.9 | 0.0 | '17.0'; '8.0'; '20.0'; '22.0'; '6.0' (sample) |
| resolution | VARCHAR | 77.18 | 0.0 | 5 | 0.0 | 0.0 | None (51,785); 'Se revisó el caso y se realizó el ajuste correspondiente en la cuenta del cliente.' (3,132); 'Se escaló a área correspondiente y se aplicó la solución definitiva.' (3,098); 'Se brindó explicación detallada al cliente y se resolvió la situación.' (3,078); 'Se otorgó compensación al cliente por las molestias ocasionadas.' (3,034); 'Se verificó la información y se procedió con la corrección solicitada.' (2,968) (all shown) |
| compensation_granted | VARCHAR | 93.08 | 0.0 | 4,436 | 6.92 | 0.0 | '494.64'; '156.66'; '310.06'; '63.7'; '399.44' (sample) |
| resolution_satisfaction | VARCHAR | 96.3 | 0.0 | 5 | 3.7 | 0.0 | None (64,611); '5.0' (526); '3.0' (514); '1.0' (500); '2.0' (472); '4.0' (472) (all shown) |
| is_repeat_complainer | VARCHAR | 0.0 | 0.0 | 2 | 0.0 | 0.0 | 'False' (57,009); 'True' (10,086) (all shown) |
| day | VARCHAR | 0.0 | 0.0 | 31 | 100.0 | 0.0 | '18'; '19'; '27'; '20'; '09' (sample) |
| month | VARCHAR | 0.0 | 0.0 | 12 | 100.0 | 0.0 | '01' (5,820); '12' (5,774); '07' (5,762); '10' (5,730); '08' (5,672); '03' (5,652); '06' (5,527); '04' (5,523); '05' (5,521); '11' (5,492); '09' (5,440); '02' (5,182) (all shown) |
| year | BIGINT **⚠** | 0.0 | 0.0 | 4 | 100.0 | 0.0 | 2025 (22,356); 2024 (22,329); 2023 (12,078); 2026 (10,332) (all shown) |

## `bronze.customers` -- 150,000 rows

| column | type | null/blank % | null-like % | distinct | numeric % | date % | sample values |
|---|---|---:|---:|---:|---:|---:|---|
| customer_id | VARCHAR | 0.0 | 0.0 | 150,000 | 0.0 | 0.0 | 'CLI-HOSWR2BXJQVR'; 'CLI-HZPJ7J1DT9RZ'; 'CLI-PYT9AZ8UERMU'; 'CLI-4OWN5PV64HZY'; 'CLI-BQ1Y40P098OG' (sample) |
| document_number | VARCHAR | 0.0 | 0.0 | 150,000 | 89.96 | 0.0 | '9631937'; '59706825'; '34666767'; 'C2726940'; 'F8226597' (sample) |
| document_type | VARCHAR | 0.0 | 0.0 | 4 | 0.0 | 0.0 | 'DNI' (104,749); 'CE' (15,150); 'Pasaporte' (15,062); 'CC' (15,039) (all shown) |
| first_name | VARCHAR | 0.0 | 0.0 | 7,480 | 0.0 | 0.0 | 'Marco Camila'; 'Héctor'; 'Mateo'; 'Antonio'; 'Marco Silvia' (sample) |
| last_name | VARCHAR | 0.0 | 0.0 | 3,460 | 0.0 | 0.0 | 'Suárez Guerrero'; 'Blanco Cabrera'; 'Alvarez Vázquez'; 'Ramos Gómez'; 'Morales Luna' (sample) |
| date_of_birth | VARCHAR | 0.0 | 0.0 | 22,956 | 0.0 | 100.0 | '1946-06-15'; '1969-11-07'; '1999-04-06'; '1999-08-30'; '1992-11-11' (sample) |
| gender | VARCHAR | 0.0 | 0.0 | 3 | 0.0 | 0.0 | 'F' (50,508); 'O' (49,808); 'M' (49,684) (all shown) |
| email | VARCHAR | 1.99 | 0.0 | 91,289 | 0.0 | 0.0 | 'sortiz@live.com'; 'albertorestrepo@yahoo.com'; 'galvarez@yahoo.com'; 'gaguilar@gmail.com'; 'gabrielguerrero@protonmail.com' (sample) |
| mobile_phone | VARCHAR | 3.14 | 0.0 | 145,285 | 0.0 | 0.0 | '+57 302 851 7178'; '+57 350 220 1889'; '+54 9 32 8084 2016'; '+54 9 16 5096 9329'; '+54 9 49 3228 5197' (sample) |
| landline_phone | VARCHAR | 50.04 | 0.0 | 74,942 | 0.0 | 0.0 | '+54 98 5360 2131'; '+54 90 2795 5803'; '+54 30 6594 5295'; '+54 33 1833 2825'; '+57 4 673 1730' (sample) |
| address | VARCHAR | 4.91 | 0.0 | 134,009 | 0.0 | 0.0 | 'Autopista Calle 53 #110, Barrio El Poblado'; 'Calzada La Paz 531, Centro'; 'Carrera 924 #29-13, Barrio El Poblado'; 'Avenida Hidalgo 419, Centro'; 'Autopista Carrera 11 #412, Barrio El Poblado' (sample) |
| city | VARCHAR | 0.0 | 0.0 | 16 | 0.0 | 0.0 | 'Guadalajara' (12,643); 'Ciudad de México' (12,506); 'Querétaro' (12,500); 'Tijuana' (12,489); 'Puebla' (12,400); 'Monterrey' (12,369); 'Bogotá' (9,140); 'Medellín' (9,107); 'Barranquilla' (9,076); 'Cali' (8,972); 'Cartagena' (8,956); 'Rosario' (6,081); ... (+4 more) (all shown) |
| state | VARCHAR | 0.0 | 0.0 | 16 | 0.0 | 0.0 | 'Jalisco' (12,643); 'Ciudad de México' (12,506); 'Querétaro' (12,500); 'Baja California' (12,489); 'Puebla' (12,400); 'Nuevo León' (12,369); 'Cundinamarca' (9,140); 'Antioquia' (9,107); 'Atlántico' (9,076); 'Valle del Cauca' (8,972); 'Bolívar' (8,956); 'Santa Fe' (6,081); ... (+4 more) (all shown) |
| country | VARCHAR | 0.0 | 0.0 | 3 | 0.0 | 0.0 | 'México' (74,907); 'Colombia' (45,251); 'Argentina' (29,842) (all shown) |
| postal_code | VARCHAR | 10.03 | 0.0 | 8,419 | 72.06 | 0.0 | '80846'; '130010'; '80649'; '80919'; '760149' (sample) |
| detected_accent | VARCHAR | 29.88 | 0.0 | 3 | 0.0 | 0.0 | 'mexican' (52,505); None (44,817); 'colombian' (31,666); 'argentine' (21,012) (all shown) |
| segment | VARCHAR | 0.0 | 0.0 | 4 | 0.0 | 0.0 | 'Basic' (89,756); 'Plus' (37,547); 'Premium' (15,207); 'Student' (7,490) (all shown) |
| credit_score | VARCHAR | 14.99 | 0.0 | 400 | 85.01 | 0.0 | '584.0'; '688.0'; '661.0'; '772.0'; '645.0' (sample) |
| estimated_monthly_income | VARCHAR | 20.02 | 0.0 | 119,734 | 79.98 | 0.0 | '24475.01'; '4302099.67'; '352566.99'; '3606628.13'; '2115684.78' (sample) |
| occupation | VARCHAR | 10.03 | 0.0 | 20 | 0.0 | 0.0 | None (15,039); 'Manager' (6,862); 'Accountant' (6,857); 'Salesperson' (6,823); 'Homemaker' (6,806); 'Entrepreneur' (6,805); 'Doctor' (6,794); 'Lawyer' (6,779); 'Technician' (6,778); 'Artist' (6,762); 'Driver' (6,752); 'Director' (6,747); ... (+9 more) (all shown) |
| marital_status | VARCHAR | 7.97 | 0.0 | 4 | 0.0 | 0.0 | 'Married' (34,765); 'Divorced' (34,734); 'Single' (34,474); 'Widowed' (34,072); None (11,955) (all shown) |
| education_level | VARCHAR | 11.97 | 0.0 | 5 | 0.0 | 0.0 | 'College Prep' (39,583); 'High School' (33,120); 'University' (32,870); None (17,952); 'Graduate' (13,269); 'Elementary' (13,206) (all shown) |
| registration_date | VARCHAR | 0.0 | 0.0 | 149,947 | 0.0 | 100.0 | '2022-02-13 06:58:48'; '2023-05-21 11:10:40'; '2022-09-12 12:23:56'; '2022-12-09 14:21:54'; '2021-11-03 02:41:07' (sample) |
| registration_branch_id | VARCHAR | 0.0 | 0.0 | 150,000 | 0.0 | 0.0 | 'SUC-C2OZRMFE'; 'SUC-WEODJBTH'; 'SUC-J82THNP0'; 'SUC-3CGSA0MB'; 'SUC-FLATGN44' (sample) |
| customer_status | VARCHAR | 0.0 | 0.0 | 4 | 0.0 | 0.0 | 'Active' (127,700); 'Inactive' (14,914); 'Suspended' (4,407); 'Closed' (2,979) (all shown) |
| last_updated | VARCHAR | 0.0 | 0.0 | 149,961 | 0.0 | 100.0 | '2025-01-26 06:15:36'; '2019-12-02 05:04:05'; '2027-04-08 14:42:38'; '2026-06-12 19:55:42'; '2023-02-16 00:08:54' (sample) |
| accepts_marketing | VARCHAR | 0.0 | 0.0 | 2 | 0.0 | 0.0 | 'False' (75,007); 'True' (74,993) (all shown) |

## `bronze.daily_exchange_rates` -- 13,164 rows

| column | type | null/blank % | null-like % | distinct | numeric % | date % | sample values |
|---|---|---:|---:|---:|---:|---:|---|
| date | VARCHAR | 0.0 | 0.0 | 1,097 | 0.0 | 100.0 | '2023-06-25'; '2023-07-07'; '2023-07-09'; '2023-07-13'; '2023-07-25' (sample) |
| source_currency | VARCHAR | 0.0 | 0.0 | 4 | 0.0 | 0.0 | 'USD' (3,291); 'COP' (3,291); 'MXN' (3,291); 'ARS' (3,291) (all shown) |
| target_currency | VARCHAR | 0.0 | 0.0 | 4 | 0.0 | 0.0 | 'MXN' (3,291); 'ARS' (3,291); 'USD' (3,291); 'COP' (3,291) (all shown) |
| exchange_rate | VARCHAR | 0.0 | 0.0 | 9,520 | 100.0 | 0.0 | '0.057832'; '346.352332'; '0.004187'; '0.086678'; '16.66489' (sample) |
| buy_rate | VARCHAR | 0.0 | 0.0 | 9,614 | 100.0 | 0.0 | '3915.220455'; '17.006012'; '235.847962'; '0.084942'; '0.048617' (sample) |
| sell_rate | VARCHAR | 0.0 | 0.0 | 9,636 | 100.0 | 0.0 | '0.058728'; '0.049506'; '0.058634'; '16.801481'; '0.049571' (sample) |
| source | VARCHAR | 0.0 | 0.0 | 4 | 0.0 | 0.0 | 'Bloomberg' (3,303); 'Reuters' (3,297); 'Internal' (3,293); 'Central Bank' (3,271) (all shown) |

## `bronze.digital_events` -- 15,620,994 rows
⚠ non-VARCHAR column(s): year

| column | type | null/blank % | null-like % | distinct | numeric % | date % | sample values |
|---|---|---:|---:|---:|---:|---:|---|
| event_id | VARCHAR | 0.0 | 0.0 | 15,620,994 | 0.0 | 0.0 | 'EVT-2NBBUPABEEA4FXOWMAJ0'; 'EVT-YG4EPQAPUPXM7MACOZNY'; 'EVT-7NM43DO0TIZK2AKXPG9T'; 'EVT-L68F0NDG464V4A57E4TC'; 'EVT-4KPZG9UL18I17JFV27TI' (sample) |
| event_date | VARCHAR | 0.0 | 0.0 | 14,217,807 | 0.0 | 100.0 | '2023-08-10 13:51:42'; '2023-08-10 13:51:48'; '2023-08-10 19:10:09'; '2023-08-11 02:47:55'; '2023-08-10 21:54:09' (sample) |
| process_date | VARCHAR | 0.0 | 0.0 | 1,097 | 0.0 | 100.0 | '2023-12-10'; '2024-01-30'; '2024-01-31'; '2024-06-12'; '2024-07-17' (sample) |
| customer_id | VARCHAR | 23.98 | 0.0 | 149,997 | 0.0 | 0.0 | 'CLI-1JZAF782VAS4'; 'CLI-TXJ28C6MC7Z3'; 'CLI-L0WFMHV1HSK9'; 'CLI-S0KGGEB1TULH'; 'CLI-KOGJ4JEU319J' (sample) |
| session_id | VARCHAR | 0.0 | 0.0 | 1,837,415 | 0.0 | 0.0 | 'SES-U56TOZT1PLOOEW23WUQCZZTT1GEG'; 'SES-6J0USRLT5IJD7DSSYBL8YKZTIJ8W'; 'SES-ZMHLBMJY470ZYFHM53CSJ6V8PE0C'; 'SES-CV16AMWA5T4WBTK1N5QENUMQJKQ3'; 'SES-N8UGNF9WEY9LCGQK90CBSSX28FJC' (sample) |
| event_type | VARCHAR | 0.0 | 0.0 | 7 | 0.0 | 0.0 | 'PageView' (5,972,564); 'Click' (3,585,034); 'Login' (2,434,770); 'Logout' (2,433,612); 'FormSubmit' (596,908); 'Error' (358,723); 'Purchase' (239,383) (all shown) |
| event_category | VARCHAR | 0.0 | 0.0 | 4 | 0.0 | 0.0 | 'Authentication' (4,868,382); 'Navigation' (3,961,324); 'Product' (3,786,314); 'Transaction' (3,004,974) (all shown) |
| channel | VARCHAR | 0.0 | 0.0 | 4 | 0.0 | 0.0 | 'Android App' (5,476,164); 'iOS App' (3,899,497); 'Desktop Web' (3,128,851); 'Mobile Web' (3,116,482) (all shown) |
| platform | VARCHAR | 5.0 | 0.0 | 5 | 0.0 | 0.0 | 'Android' (6,685,963); 'iOS' (5,182,421); 'Windows' (991,807); 'Linux' (991,774); 'MacOS' (988,502); None (780,527) (all shown) |
| browser | VARCHAR | 62.02 | 0.0 | 5 | 0.0 | 0.0 | None (9,687,736); 'Safari' (1,728,968); 'Chrome' (1,725,978); 'Samsung Internet' (990,164); 'Firefox' (744,247); 'Edge' (743,901) (all shown) |
| app_version | VARCHAR | 42.98 | 0.0 | 500 | 0.0 | 0.0 | '5.4.0'; '3.1.2'; '5.3.1'; '4.3.3'; '4.6.7' (sample) |
| page_url | VARCHAR | 5.0 | 0.0 | 12 | 0.0 | 0.0 | '/login' (2,312,677); '/logout' (2,312,586); '/products/loans' (1,199,796); '/products/savings' (1,198,797); '/products/credit-card' (1,198,674); '/payments' (952,561); '/transfer' (951,673); '/transactions' (950,903); '/accounts' (941,944); '/products' (941,304); '/home' (939,969); '/help' (939,716); ... (+1 more) (all shown) |
| page_title | VARCHAR | 4.99 | 0.0 | 12 | 0.0 | 0.0 | 'Cerrar Sesión' (2,312,841); 'Iniciar Sesión' (2,312,796); 'Préstamos' (1,199,615); 'Cuenta de Ahorro' (1,198,585); 'Tarjeta de Crédito' (1,198,485); 'Pagar Servicios' (952,401); 'Transferir' (951,874); 'Mis Movimientos' (950,599); 'Mis Cuentas' (942,316); 'Productos' (941,200); 'Inicio' (940,741); 'Ayuda' (939,717); ... (+1 more) (all shown) |
| action | VARCHAR | 10.0 | 0.0 | 10 | 0.0 | 0.0 | 'view_product' (3,407,643); 'logout' (2,191,640); 'login' (2,189,929); None (1,561,432); 'initiate_payment' (902,225); 'initiate_transfer' (901,824); 'view_transactions' (901,039); 'view_accounts' (892,802); 'view_products' (891,777); 'view_help' (890,625); 'view_home' (890,058) (all shown) |
| element_id | VARCHAR | 15.0 | 0.0 | 12 | 0.0 | 0.0 | None (2,343,244); 'login_form' (2,070,024); 'logout_btn' (2,069,557); 'loans_product' (1,073,762); 'cc_product' (1,072,404); 'savings_product' (1,071,672); 'payment_form' (851,779); 'transfer_form' (851,642); 'transactions_page' (850,628); 'accounts_page' (842,563); 'products_page' (841,806); 'help_page' (841,029); ... (+1 more) (all shown) |
| product_id | VARCHAR | 90.78 | 0.0 | 389,087 | 0.0 | 0.0 | 'PRD-D40X6OV0EMST'; 'PRD-9REWOX439LM9'; 'PRD-XBAEE9A78AZK'; 'PRD-J7YOTYF22K7D'; 'PRD-4ADTNH3DN0T6' (sample) |
| event_value | VARCHAR | 94.91 | 0.0 | 397,337 | 5.09 | 0.0 | '222.93'; '1205.98'; '1426.28'; '954.1'; '1933.5' (sample) |
| duration_seconds | VARCHAR | 63.67 | 0.0 | 296 | 36.33 | 0.0 | '103.0'; '36.0'; '184.0'; '195.0'; '101.0' (sample) |
| ip_address | VARCHAR | 5.0 | 0.0 | 1,836,678 | 0.0 | 0.0 | '173.220.208.233'; '213.124.169.39'; '15.17.157.158'; '126.204.145.5'; '161.126.157.143' (sample) |
| ip_country | VARCHAR | 0.0 | 0.0 | 4 | 0.0 | 0.0 | 'México' (6,242,893); 'Colombia' (4,806,882); 'Argentina' (3,533,045); 'Mexico' (1,038,174) (all shown) |
| ip_city | VARCHAR | 27.98 | 0.0 | 16 | 0.0 | 0.0 | None (4,370,476); 'Guadalajara' (951,621); 'Querétaro' (938,075); 'Tijuana' (935,526); 'Puebla' (934,034); 'Ciudad de México' (930,004); 'Monterrey' (928,988); 'Bogotá' (687,593); 'Barranquilla' (681,227); 'Medellín' (680,636); 'Cali' (673,084); 'Cartagena' (667,934); ... (+5 more) (all shown) |
| is_mobile | VARCHAR | 0.0 | 0.0 | 2 | 0.0 | 0.0 | 'True' (12,492,143); 'False' (3,128,851) (all shown) |
| referrer | VARCHAR | 93.29 | 0.0 | 4 | 0.0 | 0.0 | None (14,573,469); 'https://www.instagram.com' (262,214); 'https://email.marketing.com' (262,107); 'https://www.google.com' (261,610); 'https://www.facebook.com' (261,594) (all shown) |
| utm_source | VARCHAR | 94.63 | 0.0 | 4 | 0.0 | 0.0 | None (14,781,949); 'email' (210,149); 'direct' (209,721); 'google' (209,669); 'facebook' (209,506) (all shown) |
| utm_medium | VARCHAR | 94.63 | 0.0 | 4 | 0.0 | 0.0 | None (14,781,860); 'organic' (210,210); 'email' (209,778); 'social' (209,627); 'cpc' (209,519) (all shown) |
| utm_campaign | VARCHAR | 94.63 | 0.0 | 3 | 0.0 | 0.0 | None (14,782,077); 'retention' (280,033); 'spring_promo' (279,962); 'new_users' (278,922) (all shown) |
| day | VARCHAR | 0.0 | 0.0 | 31 | 100.0 | 0.0 | '04'; '20'; '09'; '18'; '30' (sample) |
| month | VARCHAR | 0.0 | 0.0 | 12 | 100.0 | 0.0 | '01' (1,456,469); '07' (1,452,232); '05' (1,366,212); '09' (1,319,844); '08' (1,307,089); '10' (1,292,187); '03' (1,284,727); '06' (1,281,867); '12' (1,253,723); '11' (1,224,148); '04' (1,203,352); '02' (1,179,144) (all shown) |
| year | BIGINT **⚠** | 0.0 | 0.0 | 4 | 100.0 | 0.0 | 2025 (5,173,832); 2024 (5,057,968); 2023 (2,926,425); 2026 (2,462,769) (all shown) |

## `bronze.marketing_campaigns` -- 200 rows

| column | type | null/blank % | null-like % | distinct | numeric % | date % | sample values |
|---|---|---:|---:|---:|---:|---:|---|
| campaign_id | VARCHAR | 0.0 | 0.0 | 200 | 0.0 | 0.0 | 'CMP-8NDJCZJCGB8P'; 'CMP-1Y30B5OERXVQ'; 'CMP-9K93Q81W883B'; 'CMP-KJQXW6V6XZEH'; 'CMP-5G96QSKR6UWT' (sample) |
| campaign_name | VARCHAR | 0.0 | 0.0 | 200 | 0.0 | 0.0 | 'CMP_UPS_CHK_Jul2024_0013'; 'CMP_RET_MTG_Aug2023_0025'; 'CMP_RET_CC_Jul2023_0042'; 'CMP_XSL_MTG_Jan2025_0058'; 'CMP_UPS_SAV_Jun2026_0070' (sample) |
| description | VARCHAR | 19.5 | 0.0 | 37 | 0.0 | 0.0 | 'Campaña de cross-sell para Préstamo Hipotecario'; 'Campaña de retention para Tarjeta Crédito'; 'Campaña de up-sell para Cuenta Corriente'; 'Campaña de cross-sell para Préstamo Personal'; 'Campaña de retention para Préstamo Hipotecario' (sample) |
| campaign_type | VARCHAR | 0.0 | 0.0 | 6 | 0.0 | 0.0 | 'Email' (67); 'SMS' (42); 'WhatsApp' (37); 'Push' (24); 'Mix' (21); 'Voice' (9) (all shown) |
| campaign_objective | VARCHAR | 0.0 | 0.0 | 5 | 0.0 | 0.0 | 'Retention' (62); 'Cross-sell' (51); 'Acquisition' (38); 'Reactivation' (25); 'Up-sell' (24) (all shown) |
| promoted_product | VARCHAR | 11.0 | 0.0 | 7 | 0.0 | 0.0 | 'Tarjeta Crédito' (52); 'Cuenta Ahorro' (40); 'Préstamo Personal' (28); None (22); 'Inversión' (20); 'Cuenta Corriente' (17); 'Préstamo Hipotecario' (11); 'Seguro' (10) (all shown) |
| target_segment | VARCHAR | 39.5 | 0.0 | 4 | 0.0 | 0.0 | None (79); 'Premium' (32); 'Plus' (32); 'Basic' (30); 'Student' (27) (all shown) |
| target_country | VARCHAR | 55.5 | 0.0 | 3 | 0.0 | 0.0 | None (111); 'Colombia' (33); 'Argentina' (28); 'Mexico' (28) (all shown) |
| start_date | VARCHAR | 0.0 | 0.0 | 186 | 0.0 | 100.0 | '2024-05-11'; '2025-03-26'; '2024-04-20'; '2024-04-15'; '2024-08-15' (sample) |
| end_date | VARCHAR | 0.0 | 0.0 | 180 | 0.0 | 100.0 | '2024-01-30'; '2024-11-30'; '2025-07-16'; '2023-12-10'; '2025-08-21' (sample) |
| budget | VARCHAR | 15.5 | 0.0 | 169 | 84.5 | 0.0 | '20732.43'; '313461.93'; '82917.59'; '490614.51'; '102169.45' (sample) |
| campaign_status | VARCHAR | 0.0 | 0.0 | 3 | 0.0 | 0.0 | 'Completed' (172); 'Paused' (25); 'Active' (3) (all shown) |
| expected_conversion_rate | VARCHAR | 7.0 | 0.0 | 176 | 93.0 | 0.0 | '8.37'; '12.21'; '8.35'; '4.97'; '10.31' (sample) |

## `bronze.products` -- 400,000 rows

| column | type | null/blank % | null-like % | distinct | numeric % | date % | sample values |
|---|---|---:|---:|---:|---:|---:|---|
| product_id | VARCHAR | 0.0 | 0.0 | 400,000 | 0.0 | 0.0 | 'PRD-7WXSFF4JGJAR'; 'PRD-8FUB2XHWG8PN'; 'PRD-4JRIM1BO00MA'; 'PRD-UO3NWR5BUKGU'; 'PRD-X676P7J88ATW' (sample) |
| customer_id | VARCHAR | 0.0 | 0.0 | 139,578 | 0.0 | 0.0 | 'CLI-GJN9Z625AYB6'; 'CLI-KGZFWJSNIU43'; 'CLI-PYO50K5RQENQ'; 'CLI-I2S0AG51L284'; 'CLI-UMO0WBVYSWP2' (sample) |
| product_type | VARCHAR | 0.0 | 0.0 | 8 | 0.0 | 0.0 | 'Cuenta Ahorro' (120,203); 'Tarjeta Crédito' (100,102); 'Cuenta Corriente' (99,979); 'Tarjeta Débito' (39,938); 'Préstamo Personal' (19,960); 'Préstamo Hipotecario' (11,910); 'Inversión' (5,859); 'Seguro' (2,049) (all shown) |
| product_number | VARCHAR | 0.0 | 0.0 | 399,994 | 90.06 | 0.0 | 'LOAN-15522197'; '8769413928'; '4480715211'; '4259950742'; '7748019262' (sample) |
| currency | VARCHAR | 0.0 | 0.0 | 3 | 0.0 | 0.0 | 'USD' (220,501); 'COP' (107,975); 'ARS' (71,524) (all shown) |
| current_balance | VARCHAR | 0.0 | 0.0 | 359,956 | 100.0 | 0.0 | '31074281.96'; '2615.54'; '3305349.85'; '649178.92'; '9670.28' (sample) |
| credit_limit | VARCHAR | 68.67 | 0.0 | 124,986 | 31.33 | 0.0 | '5554.54'; '9142545.45'; '189953684.13'; '6841538.81'; '42527.84' (sample) |
| interest_rate | VARCHAR | 10.02 | 0.0 | 4,443 | 89.98 | 0.0 | '0.19'; '44.18'; '3.38'; '27.54'; '14.85' (sample) |
| opening_date | VARCHAR | 0.0 | 0.0 | 2,922 | 0.0 | 100.0 | '2025-04-10'; '2024-07-06'; '2021-03-23'; '2021-11-26'; '2025-07-08' (sample) |
| expiration_date | VARCHAR | 66.71 | 0.0 | 3,652 | 0.0 | 33.29 | '2028-10-03'; '2025-02-21'; '2024-04-10'; '2027-02-20'; '2027-05-07' (sample) |
| opening_branch_id | VARCHAR | 0.0 | 0.0 | 350 | 0.0 | 0.0 | 'SUC-RNGAMG7V'; 'SUC-9J6GQRJ4'; 'SUC-IW55XIEY'; 'SUC-X3OFCBL0'; 'SUC-EXKJNP13' (sample) |
| product_status | VARCHAR | 0.0 | 0.0 | 4 | 0.0 | 0.0 | 'Active' (339,965); 'Closed' (32,039); 'Blocked' (19,935); 'Suspended' (8,061) (all shown) |
| opening_channel | VARCHAR | 0.0 | 0.0 | 4 | 0.0 | 0.0 | 'Branch' (199,838); 'Web' (100,282); 'App' (79,726); 'Call Center' (20,154) (all shown) |
| has_linked_app | VARCHAR | 0.0 | 0.0 | 2 | 0.0 | 0.0 | 'False' (200,142); 'True' (199,858) (all shown) |
| days_past_due | VARCHAR | 68.66 | 0.0 | 7 | 31.34 | 0.0 | None (274,650); '0.0' (106,585); '90.0' (3,233); '30.0' (3,117); '15.0' (3,114); '60.0' (3,112); '180.0' (3,106); '120.0' (3,083) (all shown) |
| last_transaction_date | VARCHAR | 23.57 | 0.0 | 305,391 | 0.0 | 76.43 | '2025-04-12 22:00:15'; '2025-10-15 19:37:53'; '2025-01-11 14:04:16'; '2025-08-23 17:12:43'; '2025-05-26 17:20:28' (sample) |
| last_updated | VARCHAR | 0.0 | 0.0 | 399,686 | 0.0 | 100.0 | '2022-07-03 13:15:04'; '2025-06-23 06:35:29'; '2026-04-08 00:01:45'; '2025-12-20 04:01:36'; '2020-01-07 21:11:53' (sample) |

## `bronze.satisfaction_surveys` -- 212,759 rows
⚠ non-VARCHAR column(s): year

| column | type | null/blank % | null-like % | distinct | numeric % | date % | sample values |
|---|---|---:|---:|---:|---:|---:|---|
| survey_id | VARCHAR | 0.0 | 0.0 | 212,759 | 0.0 | 0.0 | 'SRV-QNBT9PHJEEPF6AI6TMEZ'; 'SRV-ID4LKIUJPUW0PI9SAR5M'; 'SRV-KHBL3MCNMF8KKX581OFE'; 'SRV-AOB891O0BPSFMBPND0MG'; 'SRV-HOBIEKT3EINQLYN0ZMP5' (sample) |
| survey_date | VARCHAR | 0.0 | 0.0 | 212,505 | 0.0 | 100.0 | '2025-01-10 10:33:07'; '2025-01-09 12:29:54'; '2025-01-09 17:04:49'; '2025-01-10 11:26:46'; '2025-01-10 21:14:18' (sample) |
| process_date | VARCHAR | 0.0 | 0.0 | 1,097 | 0.0 | 100.0 | '2025-02-05'; '2025-02-21'; '2025-03-10'; '2025-06-12'; '2025-06-24' (sample) |
| interaction_id | VARCHAR | 0.0 | 0.0 | 212,759 | 0.0 | 0.0 | 'INT-M2W9E169PTPMXHQJ'; 'INT-F2N7D5SNDPLV7XXX'; 'INT-8EIL2P5J4O6Q5V1K'; 'INT-LFVYRG96I3PCGPTV'; 'INT-KJWFU06S8SS46HVH' (sample) |
| customer_id | VARCHAR | 0.0 | 0.0 | 113,640 | 0.0 | 0.0 | 'CLI-90FZJ2K6RYYL'; 'CLI-UZGY0LSULWVD'; 'CLI-SLNJOE1ZF08C'; 'CLI-5MJ1O1COA15Y'; 'CLI-9TRZ7D9CEG0Y' (sample) |
| agent_id | VARCHAR | 0.0 | 0.0 | 1,090 | 0.0 | 0.0 | 'AGT-BQKJV90OIO'; 'AGT-HSAKSDDKYK'; 'AGT-83LR6Q5GXW'; 'AGT-Z8YFQBMTYZ'; 'AGT-PEDK01MCRV' (sample) |
| survey_type | VARCHAR | 0.0 | 0.0 | 3 | 0.0 | 0.0 | 'CSAT' (127,856); 'NPS' (63,668); 'CES' (21,235) (all shown) |
| send_channel | VARCHAR | 0.0 | 0.0 | 5 | 0.0 | 0.0 | 'Email' (84,880); 'SMS' (63,798); 'App' (42,595); 'IVR' (10,836); 'Web' (10,650) (all shown) |
| main_score | VARCHAR | 0.0 | 0.0 | 7 | 100.0 | 0.0 | '3' (90,363); '2' (46,398); '4' (21,805); '5' (16,475); '6' (16,329); '7' (16,230); '1' (5,159) (all shown) |
| nps_category | VARCHAR | 71.61 | 0.0 | 2 | 0.0 | 0.0 | None (152,365); 'Detractor' (45,007); 'Passive' (15,387) (all shown) |
| question_1_text | VARCHAR | 42.99 | 0.0 | 3 | 0.0 | 0.0 | None (91,456); '¿Cómo calificaría la atención brindada?' (40,667); '¿El agente resolvió su consulta satisfactoriamente?' (40,489); '¿Qué tan satisfecho está con el servicio recibido?' (40,147) (all shown) |
| question_1_response | VARCHAR | 42.95 | 0.0 | 5 | 57.05 | 0.0 | None (91,389); '5.0' (24,575); '3.0' (24,314); '2.0' (24,217); '4.0' (24,211); '1.0' (24,053) (all shown) |
| question_2_text | VARCHAR | 61.75 | 0.0 | 1 | 0.0 | 0.0 | None (131,388); '¿El tiempo de espera fue aceptable?' (81,371) (all shown) |
| question_2_response | VARCHAR | 61.7 | 0.0 | 5 | 38.3 | 0.0 | None (131,263); '3.0' (16,567); '4.0' (16,473); '2.0' (16,217); '5.0' (16,191); '1.0' (16,048) (all shown) |
| question_3_text | VARCHAR | 81.13 | 0.0 | 1 | 0.0 | 0.0 | None (172,615); '¿Volvería a contactarnos por este canal?' (40,144) (all shown) |
| question_3_response | VARCHAR | 81.15 | 0.0 | 5 | 18.85 | 0.0 | None (172,656); '1.0' (8,176); '4.0' (8,097); '3.0' (8,030); '2.0' (7,954); '5.0' (7,846) (all shown) |
| open_comments | VARCHAR | 52.44 | 0.0 | 13 | 0.0 | 0.0 | None (111,563); 'Tardaron mucho en atenderme.' (13,620); 'No resolvieron mi problema completamente.' (13,546); 'Tuve que esperar demasiado tiempo.' (13,501); 'No estoy satisfecho con la solución.' (13,472); 'El agente no fue muy claro en sus explicaciones.' (13,338); 'Normal, sin problemas mayores.' (8,975); 'El servicio estuvo bien.' (8,964); 'Aceptable.' (8,799); 'Resolvieron mi problema rápidamente.' (1,442); 'Muy satisfecho con el servicio.' (1,406); 'Excelente atención, muy amable el agente.' (1,395); ... (+2 more) (all shown) |
| comment_sentiment | VARCHAR | 52.41 | 0.0 | 3 | 0.0 | 0.0 | None (111,502); 'Negative' (67,529); 'Neutral' (26,774); 'Positive' (6,954) (all shown) |
| response_time_hours | VARCHAR | 0.0 | 0.0 | 3,473 | 100.0 | 0.0 | '20.84'; '18.57'; '9.95'; '16.22'; '27.43' (sample) |
| campaign_response_rate | VARCHAR | 15.06 | 0.0 | 3,001 | 84.94 | 0.0 | '30.46'; '41.79'; '37.22'; '37.61'; '15.15' (sample) |
| day | VARCHAR | 0.0 | 0.0 | 31 | 100.0 | 0.0 | '22'; '26'; '07'; '12'; '19' (sample) |
| month | VARCHAR | 0.0 | 0.0 | 12 | 100.0 | 0.0 | '03' (18,261); '07' (18,185); '08' (18,147); '12' (17,965); '04' (17,930); '10' (17,924); '05' (17,815); '01' (17,726); '09' (17,545); '06' (17,543); '11' (17,143); '02' (16,575) (all shown) |
| year | BIGINT **⚠** | 0.0 | 0.0 | 4 | 100.0 | 0.0 | 2025 (71,004); 2024 (70,753); 2023 (38,302); 2026 (32,700) (all shown) |

## `bronze.service_agents` -- 1,200 rows

| column | type | null/blank % | null-like % | distinct | numeric % | date % | sample values |
|---|---|---:|---:|---:|---:|---:|---|
| agent_id | VARCHAR | 0.0 | 0.0 | 1,200 | 0.0 | 0.0 | 'AGT-OJ9N4FGYV9'; 'AGT-5A7COUI9W1'; 'AGT-4W61FITOXQ'; 'AGT-IA36860J9Z'; 'AGT-8NM2UHJMKP' (sample) |
| employee_code | VARCHAR | 0.0 | 0.0 | 1,187 | 0.0 | 0.0 | 'E51347'; 'E99051'; 'E50838'; 'E11974'; 'E61563' (sample) |
| first_name | VARCHAR | 0.0 | 0.0 | 444 | 0.0 | 0.0 | 'Gerardo Héctor'; 'Alejandro'; 'José Santiago'; 'Manuel Carlos'; 'Ramón' (sample) |
| last_name | VARCHAR | 0.0 | 0.0 | 975 | 0.0 | 0.0 | 'Rojas Vázquez'; 'Jiménez Ruiz'; 'Campos Gutiérrez'; 'Rojas Delgado'; 'Castro Cortés' (sample) |
| email | VARCHAR | 0.0 | 0.0 | 1,188 | 0.0 | 0.0 | 'jose.morales95@bancogmail.com'; 'raquel.medina158@bancoprotonmail.com'; 'gflores@bancohotmail.com'; 'jose.gutierrez@bancoprotonmail.com'; 'emiliodelgado@bancogmail.com' (sample) |
| phone | VARCHAR | 5.75 | 0.0 | 1,131 | 0.0 | 0.0 | '+54 9 63 8956 8886'; '+54 9 20 8461 7790'; '+54 9 92 7086 2775'; '+54 9 53 4768 7223'; '+54 9 77 9348 4090' (sample) |
| native_accent | VARCHAR | 0.0 | 0.0 | 3 | 0.0 | 0.0 | 'mexican' (600); 'colombian' (360); 'argentine' (240) (all shown) |
| country_of_origin | VARCHAR | 0.0 | 0.0 | 3 | 0.0 | 0.0 | 'Mexico' (600); 'Colombia' (360); 'Argentina' (240) (all shown) |
| assigned_branch_id | VARCHAR | 30.58 | 0.0 | 833 | 0.0 | 0.0 | 'SUC-Z3ECV86G'; 'SUC-XIH21FB9'; 'SUC-IF57LV1H'; 'SUC-CNTOZH64'; 'SUC-7WU56M94' (sample) |
| agent_type | VARCHAR | 0.0 | 0.0 | 4 | 0.0 | 0.0 | 'Phone' (588); 'Digital' (251); 'In-Person' (230); 'Hybrid' (131) (all shown) |
| experience_level | VARCHAR | 0.0 | 0.0 | 4 | 0.0 | 0.0 | 'Specialist' (761); 'Senior' (286); 'Mid-Senior' (135); 'Junior' (18) (all shown) |
| languages | VARCHAR | 0.0 | 0.0 | 4 | 0.0 | 0.0 | 'español' (649); 'español, inglés' (422); 'español, portugués' (68); 'español, inglés, portugués' (61) (all shown) |
| specialty | VARCHAR | 39.67 | 0.0 | 8 | 0.0 | 0.0 | None (476); 'Fraudes' (105); 'Cobranza' (97); 'Retención' (96); 'Soporte Técnico' (96); 'Créditos' (87); 'Inversiones' (83); 'Ventas' (82); 'Quejas y Reclamos' (78) (all shown) |
| hire_date | VARCHAR | 0.0 | 0.0 | 1,055 | 0.0 | 100.0 | '2025-11-23'; '2015-05-13'; '2019-06-29'; '2018-06-09'; '2013-12-25' (sample) |
| avg_csat | VARCHAR | 11.17 | 0.0 | 149 | 88.83 | 0.0 | '4.43'; '4.32'; '4.5'; '3.72'; '4.35' (sample) |
| total_monthly_interactions | VARCHAR | 9.25 | 0.0 | 559 | 90.75 | 0.0 | '690.0'; '409.0'; '249.0'; '782.0'; '685.0' (sample) |
| agent_status | VARCHAR | 0.0 | 0.0 | 4 | 0.0 | 0.0 | 'Active' (1,090); 'Vacation' (62); 'Leave' (29); 'Inactive' (19) (all shown) |
| work_shift | VARCHAR | 0.0 | 0.0 | 4 | 0.0 | 0.0 | 'Afternoon' (418); 'Morning' (398); 'Rotating' (203); 'Night' (181) (all shown) |

## `bronze.transactions` -- 4,425,008 rows
⚠ non-VARCHAR column(s): year

| column | type | null/blank % | null-like % | distinct | numeric % | date % | sample values |
|---|---|---:|---:|---:|---:|---:|---|
| transaction_id | VARCHAR | 0.0 | 0.0 | 4,425,008 | 0.0 | 0.0 | 'TRX-T0UMU5RVBHO950KM98BX'; 'TRX-SUM81YO085ODY8G3X63J'; 'TRX-W7CBF4RB8SJET1T4MQI2'; 'TRX-PXEJ628N2Z9RAG8QBCCZ'; 'TRX-BITOHRCQH244C2V7YYXB' (sample) |
| transaction_date | VARCHAR | 0.0 | 0.0 | 4,318,242 | 0.0 | 100.0 | '2023-10-07 20:13:11'; '2023-10-08 03:05:04'; '2023-10-07 22:32:10'; '2023-10-07 23:59:28'; '2023-10-07 14:17:10' (sample) |
| process_date | VARCHAR | 0.0 | 0.0 | 1,097 | 0.0 | 100.0 | '2023-12-10'; '2024-07-17'; '2024-07-18'; '2024-07-19'; '2024-07-27' (sample) |
| product_id | VARCHAR | 0.0 | 0.0 | 339,963 | 0.0 | 0.0 | 'PRD-XO6ZZ5GXRJXU'; 'PRD-A5YQF029AXWX'; 'PRD-374MLAEITIH6'; 'PRD-YGL6NLAB38QH'; 'PRD-R6YU2MXK1AVJ' (sample) |
| customer_id | VARCHAR | 0.0 | 0.0 | 134,515 | 0.0 | 0.0 | 'CLI-FHQV7FLBN576'; 'CLI-11YLGCRCSZ88'; 'CLI-G22LFNFQNGXK'; 'CLI-SYN1G37Z7EIX'; 'CLI-3QJ3BNNEPJBQ' (sample) |
| transaction_type | VARCHAR | 0.0 | 0.0 | 6 | 0.0 | 0.0 | 'Purchase' (1,083,406); 'Withdrawal' (964,673); 'Transfer' (896,438); 'Payment' (738,964); 'Deposit' (609,409); 'Adjustment' (132,118) (all shown) |
| transaction_category | VARCHAR | 60.87 | 0.0 | 6 | 0.0 | 0.0 | None (2,693,520); 'Food' (432,468); 'Services' (345,370); 'Other' (260,518); 'Transport' (260,316); 'Entertainment' (259,643); 'Health' (173,173) (all shown) |
| amount | VARCHAR | 0.0 | 0.0 | 2,570,875 | 100.0 | 0.0 | '4800738.09'; '1326214.38'; '2975811.06'; '1035.31'; '1900.14' (sample) |
| currency | VARCHAR | 0.0 | 0.0 | 3 | 0.0 | 0.0 | 'USD' (2,437,979); 'COP' (1,194,444); 'ARS' (792,585) (all shown) |
| amount_usd | VARCHAR | 57.34 | 0.0 | 528,859 | 42.66 | 0.0 | '2534.95'; '4914.17'; '570.26'; '796.68'; '809.66' (sample) |
| channel | VARCHAR | 0.0 | 0.0 | 6 | 0.0 | 0.0 | 'POS' (1,548,161); 'ATM' (1,328,334); 'Web' (663,445); 'App' (663,414); 'Branch' (132,495); 'Transfer' (89,159) (all shown) |
| branch_id | VARCHAR | 68.63 | 0.0 | 350 | 0.0 | 0.0 | 'SUC-9J6GQRJ4'; 'SUC-IW55XIEY'; 'SUC-YIS5JECV'; 'SUC-0N077NAM'; 'SUC-VPCJ60UW' (sample) |
| merchant_name | VARCHAR | 76.74 | 0.0 | 24 | 0.0 | 0.0 | 'Internet Plus'; 'Centro Comercial'; 'Ferretería'; 'Conciertos Live'; 'Clínica Médica' (sample) |
| merchant_category | VARCHAR | 76.75 | 0.0 | 6 | 0.0 | 0.0 | None (3,396,215); 'Food' (256,846); 'Services' (205,124); 'Other' (155,029); 'Transport' (154,931); 'Entertainment' (153,960); 'Health' (102,903) (all shown) |
| transaction_country | VARCHAR | 0.0 | 0.0 | 7 | 0.0 | 0.0 | 'México' (2,105,794); 'Colombia' (1,289,503); 'Argentina' (867,561); 'USA' (40,621); 'Spain' (40,542); 'Mexico' (40,515); 'Brazil' (40,472) (all shown) |
| transaction_city | VARCHAR | 10.0 | 0.0 | 28 | 0.0 | 0.0 | 'Rosario'; 'Brasília'; 'São Paulo'; 'Buenos Aires'; 'Bogotá' (sample) |
| transaction_status | VARCHAR | 0.0 | 0.0 | 4 | 0.0 | 0.0 | 'Approved' (4,070,681); 'Declined' (221,234); 'Pending' (88,343); 'Reversed' (44,750) (all shown) |
| response_code | VARCHAR | 5.0 | 0.0 | 5 | 95.0 | 0.0 | '00' (3,867,312); None (221,033); '14' (84,472); '51' (84,179); '05' (84,141); '54' (83,871) (all shown) |
| is_fraud | VARCHAR | 0.0 | 0.0 | 2 | 0.0 | 0.0 | 'False' (4,420,692); 'True' (4,316) (all shown) |
| fraud_score | VARCHAR | 20.0 | 0.0 | 5,014 | 80.0 | 0.0 | '12.16'; '3.69'; '1.46'; '0.96'; '13.94' (sample) |
| latitude | VARCHAR | 80.63 | 0.0 | 850,555 | 19.37 | 0.0 | '0.6853027'; '0.43726'; '-0.9741755'; '4.4271793'; '-34.1714025' (sample) |
| longitude | VARCHAR | 80.63 | 0.0 | 850,492 | 19.37 | 0.0 | '0.6594523'; '-0.437413'; '0.8357955'; '-58.1518608'; '-73.9021725' (sample) |
| day | VARCHAR | 0.0 | 0.0 | 31 | 100.0 | 0.0 | '02'; '30'; '31'; '06'; '15' (sample) |
| month | VARCHAR | 0.0 | 0.0 | 12 | 100.0 | 0.0 | '10' (385,079); '05' (380,250); '07' (377,304); '08' (375,914); '12' (371,650); '04' (369,068); '03' (368,766); '06' (368,548); '01' (366,023); '11' (363,413); '09' (355,699); '02' (343,294) (all shown) |
| year | BIGINT **⚠** | 0.0 | 0.0 | 4 | 100.0 | 0.0 | 2024 (1,471,814); 2025 (1,466,502); 2023 (801,170); 2026 (685,522) (all shown) |