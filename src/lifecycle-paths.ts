import { join } from "node:path"
import { parseEntryId, parseTransactionId } from "./lifecycle-schema"

export type LifecyclePaths = {
  readonly archiveEntry: string
  readonly userTrashEntry: string
  readonly transaction: string
  readonly archiveIndex: string
}

export function lifecyclePaths(storeRoot: string, entryIdInput: unknown, transactionIdInput: unknown): LifecyclePaths {
  const entryId = parseEntryId(entryIdInput)
  const transactionId = parseTransactionId(transactionIdInput)
  return {
    archiveEntry: join(storeRoot, ".archive", "entries", entryId),
    userTrashEntry: join(storeRoot, ".user-trash", "entries", entryId),
    transaction: join(storeRoot, ".memory-lifecycle", "transactions", transactionId),
    archiveIndex: join(storeRoot, ".archive", "index.json"),
  }
}
