import chiTask from "../../assets/images/chi-task.jpg"
import "./chi-task-sticker.css"

/**
 * 看板娘「赤」的「任务已接收」立绘。
 *
 * 出现条件由调用方给：**会话的第一轮、且一个 token 都还没回来**。赤是「等待期」的门面，
 * 不是助手的嘴替 —— soul 有独立人格，那块不碰。每轮都放会变成周期性闪动。
 *
 * 图上的中文是这张立绘本身的一部分，不做裁剪、也不另配文案。
 */
export function ChiTaskSticker(props: { class?: string }) {
  return (
    <div class={["chi-task-sticker", props.class].filter(Boolean).join(" ")} aria-hidden="true">
      <img src={chiTask} alt="" draggable={false} width={280} height={280} />
    </div>
  )
}
