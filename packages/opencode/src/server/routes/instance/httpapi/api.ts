import { Schema } from "effect"
import { HttpApi } from "effect/http-api"
import { BusEvent } from "@/bus/bus-event"
import { SyncEvent } from "@/sync"
import { ConfigApi } from "./groups/config"
import { ControlApi } from "./groups/control"
import { EventApi } from "./groups/event"
import { ExperimentalApi } from "./groups/experimental"
import { FileApi } from "./groups/file"
import { GlobalApi } from "./groups/global"
import { InstanceApi } from "./groups/instance"
import { McpApi } from "./groups/mcp"
import { PermissionApi } from "./groups/permission"
import { ProjectApi } from "./groups/project"
import { ProviderApi } from "./groups/provider"
import { PtyApi, PtyConnectApi } from "./groups/pty"
import { QuestionApi } from "./groups/question"
import { SessionApi } from "./groups/session"
import { SoulApi } from "./groups/soul"
import { SyncApi } from "./groups/sync"
import { TuiApi } from "./groups/tui"
import { WorkspaceApi } from "./groups/workspace"
import { V2Api } from "./groups/v2"
// 261104 Red background 组必须放在其它组之后求值：它经由 instance-context 拉到
// project/instance-store 这条链，若在 permission/session 的初始化环之前求值，
// session.ts 顶层的 Permission.Ruleset 会命中 TDZ（Cannot access 'Ruleset' before
// initialization）。前面任一组的 import 会先把这个环走完。改动本段顺序时跑
// `bun run test:httpapi` 验证，别按字母重排。
import { BackgroundApi } from "./groups/background"
import { Authorization } from "./middleware/authorization"
import { SchemaErrorMiddleware } from "./middleware/schema-error"

// SSE event schemas built from the BusEvent/SyncEvent registries.
const EventSchema = Schema.Union(BusEvent.effectPayloads()).annotate({ identifier: "Event" })
const SyncEventSchemas = SyncEvent.effectPayloads()

export const RootHttpApi = HttpApi.make("redcode-root")
  .addHttpApi(ControlApi)
  .addHttpApi(GlobalApi)
  .middleware(SchemaErrorMiddleware)
  .middleware(Authorization)

export const InstanceHttpApi = HttpApi.make("redcode-instance")
  .addHttpApi(ConfigApi)
  .addHttpApi(ExperimentalApi)
  .addHttpApi(FileApi)
  .addHttpApi(InstanceApi)
  .addHttpApi(McpApi)
  .addHttpApi(ProjectApi)
  .addHttpApi(PtyApi)
  .addHttpApi(QuestionApi)
  .addHttpApi(PermissionApi)
  .addHttpApi(ProviderApi)
  .addHttpApi(SessionApi)
  .addHttpApi(SoulApi)
  .addHttpApi(SyncApi)
  .addHttpApi(V2Api)
  .addHttpApi(TuiApi)
  .addHttpApi(WorkspaceApi)
  .addHttpApi(BackgroundApi)
  .middleware(SchemaErrorMiddleware)

export const RedCodeHttpApi = HttpApi.make("redcode")
  .addHttpApi(RootHttpApi)
  .addHttpApi(EventApi)
  .addHttpApi(InstanceHttpApi)
  .addHttpApi(PtyConnectApi)
  .annotate(HttpApi.AdditionalSchemas, [EventSchema, ...SyncEventSchemas])
