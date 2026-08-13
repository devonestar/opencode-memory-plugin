export const LIFECYCLE_REMOVAL_CHECKPOINTS = [
  "transaction-intent-staged",
  "transaction-record-staged",
  "transaction-payload-staged",
  "transaction-receipt-staged",
  "transaction-state-staged",
  "transaction-published",
  "entry-record-staged",
  "entry-topic-staged",
  "entry-origin-staged",
  "entry-state-staged",
  "entry-published",
  "active-removed",
  "transaction-destination-state",
  "transaction-source-state",
  "entry-current-state",
  "transaction-receipt-state",
  "active-index",
  "archive-index",
  "transaction-indexes-state",
  "committed-marker",
] as const

export const LIFECYCLE_RESTORE_CHECKPOINTS = [
  "transaction-intent-staged",
  "transaction-record-staged",
  "transaction-payload-staged",
  "transaction-receipt-staged",
  "transaction-state-staged",
  "transaction-published",
  "active-materialized",
  "transaction-destination-state",
  "transaction-source-state",
  "entry-current-state",
  "transaction-receipt-state",
  "active-index",
  "archive-index",
  "transaction-indexes-state",
  "committed-marker",
] as const

export type LifecycleCheckpoint = {
  readonly phase:
    | (typeof LIFECYCLE_REMOVAL_CHECKPOINTS)[number]
    | (typeof LIFECYCLE_RESTORE_CHECKPOINTS)[number]
    | "intent"
    | "payload"
    | "source"
    | "receipt"
    | "index"
}

export type LifecycleFault = (checkpoint: LifecycleCheckpoint) => void | Promise<void>
