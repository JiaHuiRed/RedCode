// @ts-nocheck

import { RedCode } from "@redcode-ai/core"
import { ReadTool } from "@redcode-ai/core/tools"

const redcode = RedCode.make({})

redcode.tool.add(ReadTool)

redcode.tool.add({
  name: "bash",
  schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The command to run.",
      },
    },
    required: ["command"],
  },
  execute(input, ctx) {},
})

redcode.auth.add({
  provider: "openai",
  type: "api",
  value: process.env.OPENAI_API_KEY,
})

redcode.agent.add({
  name: "build",
  permissions: [],
  model: {
    id: "gpt-5-5",
    provider: "openai",
    variant: "xhigh",
  },
})

const sessionID = await redcode.session.create({
  agent: "build",
})

redcode.subscribe((event) => {
  console.log(event)
})

await redcode.session.prompt({
  sessionID,
  text: "hey what is up",
})

await redcode.session.prompt({
  sessionID,
  text: "what is up with this",
  files: [
    {
      mime: "image/png",
      uri: "data:image/png;base64,xxxx",
    },
  ],
})

await redcode.session.wait()

console.log(await redcode.session.messages(sessionID))
