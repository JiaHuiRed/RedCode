export * as Session from "./session"

import { Schema } from "effect"
import { withStatics } from "./schema"
import { Identifier } from "./util/identifier"

export const ID = Schema.String.check(Schema.isStartingWith("ses")).pipe(
  Schema.brand("SessionID"),
  withStatics((schema) => ({
    descending: (id?: string) => schema.make(id ?? "ses_" + Identifier.descending()),
  })),
)
export type ID = typeof ID.Type
