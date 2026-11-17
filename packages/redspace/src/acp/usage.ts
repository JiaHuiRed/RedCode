// 261006 Red 从 agent.ts 单体拆出（上游 acp/usage.ts 的对应物）：ACP usage_update
// 上报。币种只在 step-finish part 上（260930 费用分桶），混合币种时省略 cost 字段
// 而不是伪装成单一币种相加。

import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import * as Log from "@redcode-ai/core/util/log"
import type { AssistantMessage, OpencodeClient, SessionMessageResponse } from "@redcode-ai/sdk/v2"
import { addCost, emptyCostBucket, singleCurrencyAmount } from "@/session/cost-bucket"
import { ModelID, ProviderID } from "@/provider/schema"

const log = Log.create({ service: "acp-agent" })

export async function getContextLimit(
  sdk: OpencodeClient,
  providerID: ProviderID,
  modelID: ModelID,
  directory: string,
): Promise<number | null> {
  const providers = await sdk.config
    .providers({ directory })
    .then((x) => x.data?.providers ?? [])
    .catch((error) => {
      log.error("failed to get providers for context limit", { error })
      return []
    })

  const provider = providers.find((p) => p.id === providerID)
  const model = provider?.models[modelID]
  return model?.limit.context ?? null
}

export async function sendUsageUpdate(
  connection: AgentSideConnection,
  sdk: OpencodeClient,
  sessionID: string,
  directory: string,
): Promise<void> {
  const messages = await sdk.session
    .messages({ sessionID, directory }, { throwOnError: true })
    .then((x) => x.data)
    .catch((error) => {
      log.error("failed to fetch messages for usage update", { error })
      return undefined
    })

  if (!messages) return

  const assistantMessages = messages.filter(
    (m): m is { info: AssistantMessage; parts: SessionMessageResponse["parts"] } => m.info.role === "assistant",
  )

  const lastAssistant = assistantMessages[assistantMessages.length - 1]
  if (!lastAssistant) return

  const msg = lastAssistant.info
  if (!msg.providerID || !msg.modelID) return
  const size = await getContextLimit(sdk, ProviderID.make(msg.providerID), ModelID.make(msg.modelID), directory)

  if (!size) {
    // Cannot calculate usage without known context size
    return
  }

  const used = msg.tokens.input + (msg.tokens.cache?.read ?? 0)
  const bucket = emptyCostBucket()
  for (const m of assistantMessages) {
    for (const part of m.parts) {
      if (part.type === "step-finish") {
        addCost(bucket, part.currency, part.cost)
      }
    }
  }
  const cost = singleCurrencyAmount(bucket)

  await connection
    .sessionUpdate({
      sessionId: sessionID,
      update: {
        sessionUpdate: "usage_update",
        used,
        size,
        ...(cost ? { cost: { amount: cost.amount, currency: cost.currency } } : {}),
      },
    })
    .catch((error) => {
      log.error("failed to send usage update", { error })
    })
}

export * as Usage from "./usage"
