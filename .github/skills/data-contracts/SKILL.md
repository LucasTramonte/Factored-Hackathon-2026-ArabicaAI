# Data Contracts

## Purpose
Maintain one explicit description of table structure and relationship expectations.

## When to use
Use when adding a table, changing a schema, defining quality checks, or introducing a join.

## Workflow
1. Consult the data dictionary and actual headers.
2. Define table path, required/nullable columns, types, primary key, domains, partition/date fields, and foreign keys.
3. Represent composite keys explicitly.
4. Keep contracts declarative and separate from check implementation.
5. Compare actual headers to the contract and report drift.
6. Add a fixture for every risky contract rule.

## Constraints
Preserve exact source column names. Treat the documented dictionary as authority, then verify actual files. Runtime contracts and audit registries must not silently diverge.

## Validation
Check required columns, type parseability, key uniqueness, allowed domains, partition consistency, and relationship cardinality.

## Anti-patterns
Do not invent fields, treat a shared customer ID as a safe fact join, or hide schema drift through automatic renaming.
