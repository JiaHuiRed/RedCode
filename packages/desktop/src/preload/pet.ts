import { contextBridge, ipcRenderer } from "electron"
import type { PetScene, PetWindowAPI } from "./pet-types"

const pet: PetWindowAPI = {
  ready: () => ipcRenderer.send("desktop-pet:ready"),
  onScene: (listener) => {
    const handler = (_: unknown, scene: PetScene) => listener(scene)
    ipcRenderer.on("desktop-pet:scene", handler)
    return () => ipcRenderer.removeListener("desktop-pet:scene", handler)
  },
  hit: (interactive) => ipcRenderer.send("desktop-pet:hit", interactive),
  drag: (phase) => ipcRenderer.send("desktop-pet:drag", phase),
  close: () => ipcRenderer.send("desktop-pet:close"),
}

contextBridge.exposeInMainWorld("desktopPetWindow", pet)
