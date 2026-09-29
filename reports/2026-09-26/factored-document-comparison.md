# Factored challenge document comparison

Compared on September 26, 2026 against the original PDFs in the local repository’s `Docs/sources/`.

| Document | Earlier copy | New copy | Result |
| --- | ---: | ---: | --- |
| Datathon 2026 Kickoff | 24 pages | 24 pages | Identical bytes and SHA-256 |
| Factored AI & Data Hackathon 2026 | 6 pages | 6 pages | Identical bytes and SHA-256 |
| LATAM Bank Dataset Summary | 5 pages | 5 pages | Identical bytes and SHA-256 |
| LATAM Bank Complete Data Dictionary | 17 pages | 18 pages | Updated cover date and one added access page |

## Dictionary changes

- Cover: generation date changes from July 2026 to September 2026. Dataset version remains 1.0.0.
- New page 2: read-only participant S3 credentials, bucket, region, AWS CLI configuration, and list/copy/sync examples.
- Bucket: `factored-datathon-2026-s3-157725502942-us-east-2-an`; region: `us-east-2`.
- The supplied credentials match the locally configured `factored-datathon` profile. No credential values are reproduced here.
- All 16 content pages after the old cover match the corresponding new pages after whitespace normalization: old pages 2–17 map to new pages 3–18. No extracted schema or relationship text changed.

## Implications for our work

We now have the missing connection information. The original dictionary did not include credentials; the new channel copy does. The challenge requirements, kickoff logistics, table definitions and documented dataset scope are unchanged by this update.

The dataset summary still says July 2026, while the updated dictionary cover says September 2026. This is a document metadata discrepancy; it does not establish a change to the underlying data. Actual S3 contents and analysis coverage must still be verified separately.

Earlier findings remain relevant: the repository’s Markdown dictionary omits dimension schemas, the Python customer-status contract differs from the PDF, and Portuguese demonstrations are required despite documented Spanish source text.

The original credential-free dictionary remains in the repository. The new credential-bearing original remains in Downloads; it was not copied into the version-controlled source directory. Refer to the original dictionary for schema content and this comparison for the added access information. Credentials remain in the local AWS profile.

## Verification scope

Compared complete file hashes for all four pairs and extracted text across every page. Confirmed dictionary page correspondence and checked credential equality without printing values. No assertion is made about layout identity for the changed dictionary or about the dataset download being complete.
