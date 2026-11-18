import { PetView } from "@redcode-ai/app/desktop-pet"
import { Show, createSignal, onCleanup, onMount } from "solid-js"
import { render } from "solid-js/web"
import type { PetScene, PetWindowAPI } from "../preload/pet-types"

declare global {
  interface Window {
    desktopPetWindow: PetWindowAPI
  }
}

function DesktopPet() {
  const api = window.desktopPetWindow
  const [scene, setScene] = createSignal<PetScene>()
  onMount(() => {
    onCleanup(api.onScene(setScene))
    api.ready()
  })
  return (
    <Show when={scene()}>
      {(current) => (
        <PetView
          display={{ kind: current().snapshot.kind, tool: "" }}
          outfit={current().snapshot.outfit}
          behavior={current().snapshot.behavior}
          onClose={api.close}
          native={{
            get layout() {
              return current().layout
            },
            drag: api.drag,
            hit: api.hit,
          }}
        />
      )}
    </Show>
  )
}

render(() => <DesktopPet />, document.getElementById("pet")!)
