/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RouteProvider } from "../../../src/cli/cmd/tui/context/route"
import { DialogMessage } from "../../../src/cli/cmd/tui/routes/session/dialog-message"
import { mountBackgroundDialog } from "../../fixture/background-dialog"

test("steering trace stays inspectable but cannot become a revert or fork task target", async () => {
  for (const record of [false, true]) {
    const modal = await mountBackgroundDialog(
      () => (
        <RouteProvider initialRoute={{ type: "session", sessionID: "parent" }}>
          <DialogMessage messageID="user" sessionID="parent" />
        </RouteProvider>
      ),
      {},
      {
        data: {
          message: { parent: [{ id: "user", role: "user" }] },
          part: {
            user: [
              {
                type: "text",
                text: "supplement",
                ...(record ? { synthetic: true, metadata: { task_steer_record: {} } } : {}),
              },
            ],
          },
          message_versions: {},
        },
      },
    )
    try {
      const frame = await modal.paint()
      expect(frame).toContain("Copy")
      expect(frame.includes("Revert")).toBe(!record)
      expect(frame.includes("Fork")).toBe(!record)
    } finally {
      modal.app.renderer.destroy()
    }
  }
})
