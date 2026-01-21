# Architecture Notes

## API -> Worker Contract

The API enqueues jobs to BullMQ, and the worker owns execution. The API does not run long tasks directly.

Initial job types:

- `ingest:poll` (payload: `sectorId`, `sourceId`)
- `ingest:processItem` (payload: `sourceId`, `itemId`)
- `publish:queue` (payload: `articleId`)

The worker updates job status and writes results to the database for the API/UI to display.
