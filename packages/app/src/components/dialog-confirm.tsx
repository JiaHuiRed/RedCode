import { useDialog } from "@redcode-ai/ui/context/dialog"
import { Dialog } from "@redcode-ai/ui/dialog"
import { Button } from "@redcode-ai/ui/button"
import { useLanguage } from "@/context/language"

/**
 * 261106 Red 通用二次确认对话框。删除服务器（dialog-select-server 的 handleRemove）、
 * 移除项目（home 的 removeProject）此前下拉菜单一点直接生效，误触即丢配置。
 * confirmLabel 不传时用 common.delete；确认后自动关窗。
 */
export function DialogConfirm(props: {
  title: string
  description?: string
  confirmLabel?: string
  onConfirm: () => void
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const confirm = () => {
    dialog.close()
    props.onConfirm()
  }
  return (
    <Dialog title={props.title} description={props.description}>
      <div class="flex justify-end gap-2 pt-2">
        <Button variant="ghost" size="small" onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </Button>
        <Button variant="primary" size="small" onClick={confirm}>
          {props.confirmLabel ?? language.t("common.delete")}
        </Button>
      </div>
    </Dialog>
  )
}
